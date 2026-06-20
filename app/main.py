from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import subprocess
import threading
import time
import zipfile
import importlib.metadata
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = Path(os.getenv("APP_DATA_DIR", "./data")).resolve()
DOWNLOAD_DIR = Path(os.getenv("DOWNLOAD_DIR", "./downloads")).resolve()
DB_PATH = DATA_DIR / "app.db"
SESSION_DAYS = int(os.getenv("SESSION_DAYS", "14"))
COOKIE_SECURE = os.getenv("APP_COOKIE_SECURE", "false").lower() == "true"
APP_VERSION = os.getenv("APP_VERSION", "0.1.0")
APP_BUILD_SHA = os.getenv("APP_BUILD_SHA", "dev")
APP_BUILD_DATE = os.getenv("APP_BUILD_DATE", "unknown")

DATA_DIR.mkdir(parents=True, exist_ok=True)
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="YTDLP Client")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

stop_worker = threading.Event()
active_lock = threading.Lock()
active_process: subprocess.Popen[str] | None = None
active_download_id: int | None = None


class LoginPayload(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=4096)


class DownloadPayload(BaseModel):
    url: str = Field(min_length=8, max_length=4096)
    mode: str = "best"
    playlist: bool = False
    media_type: Literal["auto", "video", "audio", "captions", "thumbnail"] = "auto"
    video_format: Literal["auto", "mp4", "webm", "mkv"] = "auto"
    video_codec: Literal["auto", "h264", "h265", "av1", "vp9"] = "auto"
    video_quality: Literal["auto", "2160", "1440", "1080", "720", "480", "360"] = "auto"
    audio_format: Literal["auto", "mp3", "m4a", "opus", "flac", "wav"] = "auto"
    audio_bitrate: Literal["auto", "320K", "256K", "192K", "128K", "96K"] = "auto"
    caption_format: Literal["auto", "srt", "vtt", "txt"] = "auto"
    caption_langs: str = Field(default="de,en", max_length=120)
    thumbnail_format: Literal["auto", "jpg", "png", "webp"] = "auto"


class UserCreatePayload(BaseModel):
    username: str = Field(min_length=3, max_length=80)
    password: str = Field(min_length=10, max_length=4096)
    is_admin: bool = False


class PasswordPayload(BaseModel):
    password: str = Field(min_length=10, max_length=4096)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE COLLATE NOCASE,
              password_hash TEXT NOT NULL,
              is_admin INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
              token_hash TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              expires_at TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS downloads (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              url TEXT NOT NULL,
              mode TEXT NOT NULL,
              playlist INTEGER NOT NULL DEFAULT 0,
              title TEXT,
              status TEXT NOT NULL,
              progress REAL NOT NULL DEFAULT 0,
              speed TEXT,
              eta TEXT,
              filename TEXT,
              file_size INTEGER,
              settings_json TEXT NOT NULL DEFAULT '{}',
              error TEXT,
              created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            """
        )
        ensure_column(conn, "downloads", "file_size", "INTEGER")
        ensure_column(conn, "downloads", "settings_json", "TEXT NOT NULL DEFAULT '{}'")
    ensure_initial_admin()


def read_secret(name: str, file_name: str) -> str | None:
    direct = os.getenv(name)
    if direct:
        return direct.strip()
    secret_file = os.getenv(file_name)
    if secret_file and Path(secret_file).exists():
        return Path(secret_file).read_text(encoding="utf-8").strip()
    return None


def ensure_initial_admin() -> None:
    with connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if count:
            return

        username = os.getenv("FIRST_ADMIN_USERNAME", "admin").strip() or "admin"
        password = read_secret("FIRST_ADMIN_PASSWORD", "FIRST_ADMIN_PASSWORD_FILE")
        if not password or password == "change-me-before-first-start":
            raise RuntimeError(
                "No initial admin password configured. Set FIRST_ADMIN_PASSWORD_FILE "
                "or FIRST_ADMIN_PASSWORD before the first start."
            )

        conn.execute(
            "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)",
            (username, hash_password(password), utc_now()),
        )


def hash_password(password: str) -> str:
    iterations = 260_000
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, iterations, salt_hex, digest_hex = stored.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        expected = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            int(iterations),
        ).hex()
        return hmac.compare_digest(expected, digest_hex)
    except (ValueError, TypeError):
        return False


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def user_public(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "username": row["username"],
        "is_admin": bool(row["is_admin"]),
        "created_at": row["created_at"],
    }


def get_current_user(session: str | None = Cookie(default=None)) -> dict[str, Any]:
    if not session:
        raise HTTPException(status_code=401, detail="Not authenticated")

    with connect() as conn:
        row = conn.execute(
            """
            SELECT users.*
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?
            """,
            (hash_token(session), utc_now()),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="Session expired")
        return user_public(row)


def require_admin(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin permissions required")
    return user


def validate_url(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Only http(s) URLs are supported")
    return url.strip()


VIDEO_FORMAT_CODECS = {
    "mp4": {"h264", "h265", "av1"},
    "webm": {"vp9", "av1"},
    "mkv": {"h264", "h265", "av1", "vp9"},
}

VIDEO_CODEC_FFMPEG = {
    "h264": ["-c:v", "libx264", "-preset", "medium", "-crf", "23"],
    "h265": ["-c:v", "libx265", "-preset", "medium", "-crf", "28"],
    "av1": ["-c:v", "libaom-av1", "-crf", "30", "-b:v", "0"],
    "vp9": ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0"],
}


def clean_caption_langs(value: str) -> str:
    langs = [lang.strip() for lang in value.split(",") if lang.strip()]
    valid = [lang for lang in langs if re.fullmatch(r"[A-Za-z0-9.*_-]{1,24}", lang)]
    return ",".join(valid[:8]) or "de,en"


def normalize_download_options(payload: DownloadPayload) -> dict[str, str]:
    settings = {
        "media_type": payload.media_type,
        "video_format": payload.video_format,
        "video_codec": payload.video_codec,
        "video_quality": payload.video_quality,
        "audio_format": payload.audio_format,
        "audio_bitrate": payload.audio_bitrate,
        "caption_format": payload.caption_format,
        "caption_langs": clean_caption_langs(payload.caption_langs),
        "thumbnail_format": payload.thumbnail_format,
    }

    media_type = settings["media_type"]
    if media_type != "video":
        settings["video_format"] = "auto"
        settings["video_codec"] = "auto"
        settings["video_quality"] = "auto"
    if media_type != "audio":
        settings["audio_format"] = "auto"
        settings["audio_bitrate"] = "auto"
    if media_type != "captions":
        settings["caption_format"] = "auto"
    if media_type != "thumbnail":
        settings["thumbnail_format"] = "auto"

    if media_type == "video":
        video_format = settings["video_format"]
        video_codec = settings["video_codec"]
        if video_format != "auto" and video_codec != "auto" and video_codec not in VIDEO_FORMAT_CODECS[video_format]:
            raise HTTPException(status_code=400, detail=f"{video_codec} is not compatible with {video_format}")
    return settings


def settings_summary(settings: dict[str, str]) -> str:
    media_type = settings.get("media_type", "auto")
    if media_type == "auto":
        return "Auto"
    if media_type == "audio":
        parts = ["Audio", settings.get("audio_format", "auto"), settings.get("audio_bitrate", "auto")]
    elif media_type == "captions":
        parts = ["Captions", settings.get("caption_format", "auto"), settings.get("caption_langs", "de,en")]
    elif media_type == "thumbnail":
        parts = ["Thumbnail", settings.get("thumbnail_format", "auto")]
    else:
        parts = [
            "Video",
            settings.get("video_format", "auto"),
            settings.get("video_codec", "auto"),
            f"{settings.get('video_quality', 'auto')}p" if settings.get("video_quality") != "auto" else "auto",
        ]
    summary = " ".join(part for part in parts if part and part != "auto")
    media_label = media_type.title()
    return f"{media_label} Auto" if summary == media_label else summary or f"{media_label} Auto"


def legacy_settings(mode: str) -> dict[str, str]:
    if mode == "mp4":
        return {
            "media_type": "video",
            "video_format": "mp4",
            "video_codec": "auto",
            "video_quality": "auto",
            "audio_format": "auto",
            "audio_bitrate": "auto",
            "caption_format": "auto",
            "caption_langs": "de,en",
            "thumbnail_format": "auto",
        }
    if mode == "audio_mp3":
        return {
            "media_type": "audio",
            "video_format": "auto",
            "video_codec": "auto",
            "video_quality": "auto",
            "audio_format": "mp3",
            "audio_bitrate": "auto",
            "caption_format": "auto",
            "caption_langs": "de,en",
            "thumbnail_format": "auto",
        }
    if mode == "audio_m4a":
        return {
            "media_type": "audio",
            "video_format": "auto",
            "video_codec": "auto",
            "video_quality": "auto",
            "audio_format": "m4a",
            "audio_bitrate": "auto",
            "caption_format": "auto",
            "caption_langs": "de,en",
            "thumbnail_format": "auto",
        }
    return {
        "media_type": "auto",
        "video_format": "auto",
        "video_codec": "auto",
        "video_quality": "auto",
        "audio_format": "auto",
        "audio_bitrate": "auto",
        "caption_format": "auto",
        "caption_langs": "de,en",
        "thumbnail_format": "auto",
    }


def row_settings(row: sqlite3.Row) -> dict[str, str]:
    try:
        settings = json.loads(row["settings_json"] or "{}")
    except (json.JSONDecodeError, KeyError):
        settings = {}
    return {**legacy_settings(row["mode"]), **settings}


def format_selector_for_height(selector: str, quality: str) -> str:
    if quality == "auto":
        return selector
    return selector.replace("bv*", f"bv*[height<={quality}]").replace("bestvideo", f"bestvideo[height<={quality}]")


def ytdlp_args_for_settings(settings: dict[str, str]) -> list[str]:
    media_type = settings.get("media_type", "auto")
    if media_type == "auto":
        return ["-f", "bv*+ba/b"]

    if media_type == "audio":
        audio_format = settings.get("audio_format", "auto")
        args = ["-f", "ba/b", "-x"]
        if audio_format != "auto":
            args.extend(["--audio-format", audio_format])
        if settings.get("audio_bitrate") != "auto":
            args.extend(["--audio-quality", settings["audio_bitrate"]])
        return args

    if media_type == "captions":
        caption_format = settings.get("caption_format", "auto")
        convert_format = "vtt" if caption_format in {"auto", "txt"} else caption_format
        return [
            "--skip-download",
            "--write-subs",
            "--write-auto-subs",
            "--sub-langs",
            settings.get("caption_langs", "de,en"),
            "--convert-subs",
            convert_format,
        ]

    if media_type == "thumbnail":
        args = ["--skip-download", "--write-thumbnail"]
        if settings.get("thumbnail_format") != "auto":
            args.extend(["--convert-thumbnails", settings["thumbnail_format"]])
        return args

    video_format = settings.get("video_format", "auto")
    quality = settings.get("video_quality", "auto")
    selector = "bv*+ba/b"
    if video_format == "mp4":
        selector = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b"
    elif video_format == "webm":
        selector = "bv*[ext=webm]+ba[ext=webm]/b[ext=webm]/bv*+ba/b"
    selector = format_selector_for_height(selector, quality)
    args = ["-f", selector]
    if video_format in {"mp4", "webm", "mkv"}:
        args.extend(["--merge-output-format", video_format])
    return args


def parse_progress(line: str) -> tuple[float | None, str | None, str | None]:
    percent_match = re.search(r"(\d+(?:\.\d+)?)%", line)
    speed_match = re.search(r"at\s+([^\s]+)", line)
    eta_match = re.search(r"ETA\s+([^\s]+)", line)
    progress = float(percent_match.group(1)) if percent_match else None
    speed = speed_match.group(1) if speed_match else None
    eta = eta_match.group(1) if eta_match else None
    return progress, speed, eta


def safe_download_path(relative_path: str | None) -> Path | None:
    if not relative_path:
        return None
    download_root = DOWNLOAD_DIR.resolve()
    target = (download_root / relative_path).resolve()
    try:
        target.relative_to(download_root)
    except ValueError:
        return None
    return target if target.is_file() else None


def stored_file_size(row: sqlite3.Row) -> int | None:
    try:
        if row["file_size"] is not None:
            return int(row["file_size"])
    except (KeyError, TypeError, ValueError):
        pass
    target = safe_download_path(row["filename"])
    return target.stat().st_size if target else None


def row_to_download(row: sqlite3.Row) -> dict[str, Any]:
    file_url = f"/api/downloads/{row['id']}/file" if row["status"] == "completed" and row["filename"] else None
    settings = row_settings(row)
    return {
        "id": row["id"],
        "url": row["url"],
        "mode": row["mode"],
        "settings": settings,
        "playlist": bool(row["playlist"]),
        "title": row["title"],
        "status": row["status"],
        "progress": row["progress"],
        "speed": row["speed"],
        "eta": row["eta"],
        "filename": row["filename"],
        "file_size": stored_file_size(row),
        "file_url": file_url,
        "error": row["error"],
        "created_by": row["created_by"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def claim_next_download() -> sqlite3.Row | None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM downloads WHERE status = 'queued' ORDER BY id LIMIT 1"
        ).fetchone()
        if not row:
            conn.commit()
            return None
        conn.execute(
            "UPDATE downloads SET status = 'running', updated_at = ? WHERE id = ?",
            (utc_now(), row["id"]),
        )
        conn.commit()
        return conn.execute("SELECT * FROM downloads WHERE id = ?", (row["id"],)).fetchone()


def update_download(download_id: int, **fields: Any) -> None:
    if not fields:
        return
    fields["updated_at"] = utc_now()
    assignments = ", ".join(f"{key} = ?" for key in fields)
    values = list(fields.values()) + [download_id]
    with connect() as conn:
        conn.execute(f"UPDATE downloads SET {assignments} WHERE id = ?", values)


def probe_title(url: str, playlist: bool) -> str | None:
    command = [
        "yt-dlp",
        "--dump-single-json",
        "--no-warnings",
        "--skip-download",
    ]
    if not playlist:
        command.append("--no-playlist")
    command.append(url)

    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=45)
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        return data.get("title") or data.get("webpage_url_basename")
    except (subprocess.SubprocessError, json.JSONDecodeError):
        return None


def run_download(row: sqlite3.Row) -> None:
    global active_download_id, active_process

    download_id = row["id"]
    url = row["url"]
    playlist = bool(row["playlist"])
    settings = row_settings(row)
    title = probe_title(url, playlist)
    if title:
        update_download(download_id, title=title)
    started_at = time.time()

    command = [
        "yt-dlp",
        "--newline",
        "--continue",
        "--no-mtime",
        "-P",
        str(DOWNLOAD_DIR),
        "-o",
        "%(title).200B [%(id)s].%(ext)s",
    ]
    if settings.get("media_type") in {"auto", "video", "audio"}:
        command.append("--embed-metadata")
    if not playlist:
        command.append("--no-playlist")
    command.extend(ytdlp_args_for_settings(settings))
    command.append(url)

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        with active_lock:
            active_download_id = download_id
            active_process = process

        output_tail: list[str] = []
        assert process.stdout is not None
        for line in process.stdout:
            clean = line.strip()
            if not clean:
                continue
            output_tail = (output_tail + [clean])[-8:]

            if "[download]" in clean:
                progress, speed, eta = parse_progress(clean)
                changes: dict[str, Any] = {}
                if progress is not None:
                    changes["progress"] = min(progress, 100.0)
                if speed:
                    changes["speed"] = speed
                if eta:
                    changes["eta"] = eta
                if changes:
                    update_download(download_id, **changes)
            elif "[Metadata]" in clean and not title:
                update_download(download_id, title="Writing metadata")

        return_code = process.wait()
        with connect() as conn:
            current = conn.execute("SELECT status FROM downloads WHERE id = ?", (download_id,)).fetchone()
        if current and current["status"] == "cancelled":
            return

        if return_code == 0:
            files = output_files_since(started_at)
            final_files = postprocess_files(files, settings)
            final_file = package_download_files(download_id, final_files)
            relative_filename = final_file.relative_to(DOWNLOAD_DIR.resolve()).as_posix() if final_file else None
            file_size = final_file.stat().st_size if final_file and final_file.exists() else None
            update_download(
                download_id,
                status="completed",
                progress=100,
                eta=None,
                speed=None,
                filename=relative_filename,
                file_size=file_size,
                error=None,
            )
        else:
            update_download(
                download_id,
                status="failed",
                error="\n".join(output_tail) or f"yt-dlp exited with code {return_code}",
            )
    except Exception as exc:
        update_download(download_id, status="failed", error=str(exc))
    finally:
        with active_lock:
            active_download_id = None
            active_process = None


def download_files_since(since: float = 0) -> list[Path]:
    return sorted(
        [
            path
            for path in DOWNLOAD_DIR.rglob("*")
            if path.is_file() and not path.name.endswith(".part") and path.stat().st_mtime >= since
        ],
        key=lambda path: path.stat().st_mtime,
    )


def unique_path(target: Path) -> Path:
    counter = 1
    unique = target
    while unique.exists():
        unique = target.with_name(f"{target.stem}-{counter}{target.suffix}")
        counter += 1
    return unique


def output_path_for_conversion(source: Path, extension: str) -> Path:
    target = source.with_suffix(f".{extension}")
    if target == source:
        target = source.with_name(f"{source.stem}.converted{source.suffix}")
    return unique_path(target)


def package_download_files(download_id: int, files: list[Path]) -> Path | None:
    existing_files = [path for path in files if path.is_file()]
    if not existing_files:
        return None
    if len(existing_files) == 1:
        return existing_files[0]

    target = unique_path(DOWNLOAD_DIR / f"download-{download_id}.zip")
    download_root = DOWNLOAD_DIR.resolve()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in existing_files:
            archive.write(path, path.resolve().relative_to(download_root).as_posix())
    return target


def output_files_since(since: float = 0) -> list[Path]:
    return [
        path
        for path in download_files_since(since)
        if not path.name.startswith("download-") or path.suffix.lower() != ".zip"
    ]


def default_video_codec(settings: dict[str, str]) -> str:
    video_format = settings.get("video_format", "auto")
    video_codec = settings.get("video_codec", "auto")
    if video_codec != "auto":
        return video_codec
    if video_format == "webm":
        return "vp9"
    return "h264"


def default_video_extension(settings: dict[str, str]) -> str:
    video_format = settings.get("video_format", "auto")
    if video_format != "auto":
        return video_format
    return "mp4"


def should_convert_video(settings: dict[str, str]) -> bool:
    return any(
        settings.get(key, "auto") != "auto"
        for key in ("video_format", "video_codec", "video_quality")
    )


def ffmpeg_audio_args_for_video(extension: str) -> list[str]:
    if extension == "webm":
        return ["-c:a", "libopus", "-b:a", "160k"]
    return ["-c:a", "aac", "-b:a", "192k"]


def convert_video(source: Path, settings: dict[str, str]) -> Path:
    extension = default_video_extension(settings)
    codec = default_video_codec(settings)
    if extension in VIDEO_FORMAT_CODECS and codec not in VIDEO_FORMAT_CODECS[extension]:
        raise RuntimeError(f"{codec} cannot be stored in {extension}")

    target = output_path_for_conversion(source, extension)
    command = ["ffmpeg", "-y", "-i", str(source)]
    quality = settings.get("video_quality", "auto")
    if quality != "auto":
        command.extend(["-vf", f"scale=-2:min(ih\\,{quality})"])
    command.extend(VIDEO_CODEC_FFMPEG[codec])
    command.extend(ffmpeg_audio_args_for_video(extension))
    if extension == "mp4":
        command.extend(["-movflags", "+faststart"])
    command.append(str(target))
    result = subprocess.run(command, capture_output=True, text=True, timeout=None)
    if result.returncode != 0:
        target.unlink(missing_ok=True)
        error = "\n".join((result.stderr or result.stdout or "").splitlines()[-8:])
        raise RuntimeError(error or f"ffmpeg exited with code {result.returncode}")
    source.unlink(missing_ok=True)
    return target


def caption_to_text(source: Path) -> Path:
    target = output_path_for_conversion(source, "txt")
    lines = []
    timestamp = re.compile(r"^\d{1,2}:?\d{2}:\d{2}[.,]\d{3}\s+-->\s+")
    for raw_line in source.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.upper() == "WEBVTT" or line.isdigit() or timestamp.search(line):
            continue
        if line.startswith(("NOTE", "STYLE", "REGION")):
            continue
        clean = re.sub(r"<[^>]+>", "", line).strip()
        if clean and (not lines or lines[-1] != clean):
            lines.append(clean)
    target.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    source.unlink(missing_ok=True)
    return target


def postprocess_file(path: Path | None, settings: dict[str, str]) -> Path | None:
    if not path:
        return None
    media_type = settings.get("media_type", "auto")
    if media_type == "video" and should_convert_video(settings):
        return convert_video(path, settings)
    if media_type == "captions" and settings.get("caption_format") == "txt":
        return caption_to_text(path)
    return path


def postprocess_files(paths: list[Path], settings: dict[str, str]) -> list[Path]:
    processed = []
    for path in paths:
        final_path = postprocess_file(path, settings)
        if final_path:
            processed.append(final_path)
    return processed


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def command_version(command: list[str]) -> str | None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            return result.stdout.strip().splitlines()[0]
    except (OSError, subprocess.SubprocessError):
        return None
    return None


def system_info() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": APP_VERSION,
        "build_sha": APP_BUILD_SHA,
        "build_date": APP_BUILD_DATE,
        "yt_dlp_version": command_version(["yt-dlp", "--version"])
        or package_version("yt-dlp")
        or "unknown",
        "curl_cffi_available": importlib.util.find_spec("curl_cffi") is not None,
        "yt_dlp_ejs_version": package_version("yt-dlp-ejs") or "unavailable",
        "deno_version": command_version(["deno", "--version"]) or "unavailable",
        "ffmpeg_version": command_version(["ffmpeg", "-version"]) or "unavailable",
    }


def worker_loop() -> None:
    while not stop_worker.is_set():
        row = claim_next_download()
        if row:
            run_download(row)
        else:
            stop_worker.wait(1.5)


@app.on_event("startup")
def startup() -> None:
    init_db()
    thread = threading.Thread(target=worker_loop, name="download-worker", daemon=True)
    thread.start()


@app.on_event("shutdown")
def shutdown() -> None:
    stop_worker.set()
    with active_lock:
        if active_process and active_process.poll() is None:
            active_process.terminate()


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict[str, Any]:
    return system_info()


@app.post("/api/login")
def login(payload: LoginPayload, response: Response) -> dict[str, Any]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE",
            (payload.username.strip(),),
        ).fetchone()
        if not row or not verify_password(payload.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid username or password")

        token = secrets.token_urlsafe(40)
        expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (hash_token(token), row["id"], expires_at.isoformat(), utc_now()),
        )
        response.set_cookie(
            "session",
            token,
            max_age=SESSION_DAYS * 24 * 60 * 60,
            httponly=True,
            samesite="lax",
            secure=COOKIE_SECURE,
        )
        return {"user": user_public(row)}


@app.post("/api/logout")
def logout(response: Response, session: str | None = Cookie(default=None)) -> dict[str, str]:
    if session:
        with connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(session),))
    response.delete_cookie("session")
    return {"status": "ok"}


@app.get("/api/me")
def me(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    return {"user": user}


@app.get("/api/downloads")
def downloads(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM downloads WHERE created_by = ? ORDER BY id DESC LIMIT 200",
            (user["id"],),
        ).fetchall()
        return {"downloads": [row_to_download(row) for row in rows]}


@app.post("/api/downloads")
def create_download(
    payload: DownloadPayload,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    url = validate_url(payload.url)
    settings = normalize_download_options(payload)
    mode = settings_summary(settings)
    now = utc_now()
    with connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO downloads
              (url, mode, playlist, status, settings_json, created_by, created_at, updated_at)
            VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
            """,
            (url, mode, int(payload.playlist), json.dumps(settings), user["id"], now, now),
        )
        row = conn.execute("SELECT * FROM downloads WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return {"download": row_to_download(row)}


@app.post("/api/downloads/{download_id}/cancel")
def cancel_download(download_id: int, user: dict[str, Any] = Depends(get_current_user)) -> dict[str, str]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM downloads WHERE id = ? AND created_by = ?",
            (download_id, user["id"]),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Download not found")
        if row["status"] in {"completed", "failed", "cancelled"}:
            return {"status": row["status"]}
        conn.execute(
            "UPDATE downloads SET status = 'cancelled', error = NULL, updated_at = ? WHERE id = ?",
            (utc_now(), download_id),
        )

    with active_lock:
        if active_download_id == download_id and active_process and active_process.poll() is None:
            active_process.terminate()
    return {"status": "cancelled"}


@app.delete("/api/downloads/{download_id}")
def delete_download(download_id: int, user: dict[str, Any] = Depends(get_current_user)) -> dict[str, str]:
    with connect() as conn:
        row = conn.execute(
            "SELECT status FROM downloads WHERE id = ? AND created_by = ?",
            (download_id, user["id"]),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Download not found")
        if row["status"] == "running":
            raise HTTPException(status_code=409, detail="Cancel running downloads before deleting them")
        conn.execute("DELETE FROM downloads WHERE id = ?", (download_id,))
    return {"status": "deleted"}


@app.get("/api/files")
def files(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    items = []
    download_root = DOWNLOAD_DIR.resolve()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, filename, updated_at
            FROM downloads
            WHERE created_by = ? AND status = 'completed' AND filename IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 200
            """,
            (user["id"],),
        ).fetchall()
    for row in rows:
        target = (download_root / row["filename"]).resolve()
        try:
            target.relative_to(download_root)
        except ValueError:
            continue
        if target.is_file():
            stat = target.stat()
            items.append(
                {
                    "name": target.name,
                    "path": row["filename"],
                    "size": stat.st_size,
                    "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                    "url": f"/api/downloads/{row['id']}/file",
                }
            )
    return {"files": items[:200]}


@app.get("/api/downloads/{download_id}/file")
def download_file(download_id: int, user: dict[str, Any] = Depends(get_current_user)) -> FileResponse:
    download_root = DOWNLOAD_DIR.resolve()
    with connect() as conn:
        row = conn.execute(
            """
            SELECT filename
            FROM downloads
            WHERE id = ? AND created_by = ? AND status = 'completed' AND filename IS NOT NULL
            """,
            (download_id, user["id"]),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="File not found")

    target = (download_root / row["filename"]).resolve()
    try:
        target.relative_to(download_root)
    except ValueError:
        raise HTTPException(status_code=404, detail="File not found") from None
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(target, filename=target.name)


@app.get("/api/admin/users")
def list_users(_: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY id").fetchall()
        return {"users": [user_public(row) for row in rows]}


@app.post("/api/admin/users")
def create_user(payload: UserCreatePayload, _: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    username = payload.username.strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,80}", username):
        raise HTTPException(status_code=400, detail="Use letters, numbers, dots, dashes or underscores")
    try:
        with connect() as conn:
            cursor = conn.execute(
                "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)",
                (username, hash_password(payload.password), int(payload.is_admin), utc_now()),
            )
            row = conn.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()
            return {"user": user_public(row)}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Username already exists") from None


@app.put("/api/admin/users/{user_id}/password")
def reset_password(
    user_id: int,
    payload: PasswordPayload,
    _: dict[str, Any] = Depends(require_admin),
) -> dict[str, str]:
    with connect() as conn:
        result = conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(payload.password), user_id),
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="User not found")
    return {"status": "updated"}


@app.delete("/api/admin/users/{user_id}")
def delete_user(user_id: int, admin: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    with connect() as conn:
        admins = conn.execute("SELECT COUNT(*) FROM users WHERE is_admin = 1").fetchone()[0]
        target = conn.execute("SELECT is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="User not found")
        if target["is_admin"] and admins <= 1:
            raise HTTPException(status_code=400, detail="At least one admin must remain")
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return {"status": "deleted"}


@app.middleware("http")
async def no_store_api(request: Request, call_next: Any) -> Response:
    response = await call_next(request)
    if request.url.path.startswith("/api/") or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
    return response
