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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
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
              error TEXT,
              created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            """
        )
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


def download_mode_args(mode: str) -> list[str]:
    modes = {
        "best": ["-f", "bv*+ba/b"],
        "mp4": ["-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b", "--merge-output-format", "mp4"],
        "audio_mp3": ["-f", "ba/b", "-x", "--audio-format", "mp3"],
        "audio_m4a": ["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"],
    }
    if mode not in modes:
        raise HTTPException(status_code=400, detail="Unknown download mode")
    return modes[mode]


def parse_progress(line: str) -> tuple[float | None, str | None, str | None]:
    percent_match = re.search(r"(\d+(?:\.\d+)?)%", line)
    speed_match = re.search(r"at\s+([^\s]+)", line)
    eta_match = re.search(r"ETA\s+([^\s]+)", line)
    progress = float(percent_match.group(1)) if percent_match else None
    speed = speed_match.group(1) if speed_match else None
    eta = eta_match.group(1) if eta_match else None
    return progress, speed, eta


def row_to_download(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "url": row["url"],
        "mode": row["mode"],
        "playlist": bool(row["playlist"]),
        "title": row["title"],
        "status": row["status"],
        "progress": row["progress"],
        "speed": row["speed"],
        "eta": row["eta"],
        "filename": row["filename"],
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
    mode = row["mode"]
    title = probe_title(url, playlist)
    if title:
        update_download(download_id, title=title)

    command = [
        "yt-dlp",
        "--newline",
        "--continue",
        "--embed-metadata",
        "-P",
        str(DOWNLOAD_DIR),
        "-o",
        "%(title).200B [%(id)s].%(ext)s",
    ]
    if not playlist:
        command.append("--no-playlist")
    command.extend(download_mode_args(mode))
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
                update_download(download_id, title="Metadata wird geschrieben")

        return_code = process.wait()
        with connect() as conn:
            current = conn.execute("SELECT status FROM downloads WHERE id = ?", (download_id,)).fetchone()
        if current and current["status"] == "cancelled":
            return

        if return_code == 0:
            newest = newest_download_file()
            update_download(
                download_id,
                status="completed",
                progress=100,
                eta=None,
                speed=None,
                filename=newest.name if newest else None,
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


def newest_download_file() -> Path | None:
    files = [path for path in DOWNLOAD_DIR.rglob("*") if path.is_file() and not path.name.endswith(".part")]
    if not files:
        return None
    return max(files, key=lambda path: path.stat().st_mtime)


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
def health() -> dict[str, str]:
    return {"status": "ok"}


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
def downloads(_: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM downloads ORDER BY id DESC LIMIT 200").fetchall()
        return {"downloads": [row_to_download(row) for row in rows]}


@app.post("/api/downloads")
def create_download(
    payload: DownloadPayload,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    url = validate_url(payload.url)
    download_mode_args(payload.mode)
    now = utc_now()
    with connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO downloads
              (url, mode, playlist, status, created_by, created_at, updated_at)
            VALUES (?, ?, ?, 'queued', ?, ?, ?)
            """,
            (url, payload.mode, int(payload.playlist), user["id"], now, now),
        )
        row = conn.execute("SELECT * FROM downloads WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return {"download": row_to_download(row)}


@app.post("/api/downloads/{download_id}/cancel")
def cancel_download(download_id: int, _: dict[str, Any] = Depends(get_current_user)) -> dict[str, str]:
    with connect() as conn:
        row = conn.execute("SELECT * FROM downloads WHERE id = ?", (download_id,)).fetchone()
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
def delete_download(download_id: int, _: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    with connect() as conn:
        row = conn.execute("SELECT status FROM downloads WHERE id = ?", (download_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Download not found")
        if row["status"] == "running":
            raise HTTPException(status_code=409, detail="Cancel running downloads before deleting them")
        conn.execute("DELETE FROM downloads WHERE id = ?", (download_id,))
    return {"status": "deleted"}


@app.get("/api/files")
def files(_: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    items = []
    for path in sorted(DOWNLOAD_DIR.rglob("*"), key=lambda item: item.stat().st_mtime, reverse=True):
        if not path.is_file() or path.name.endswith(".part"):
            continue
        relative = path.relative_to(DOWNLOAD_DIR).as_posix()
        stat = path.stat()
        items.append(
            {
                "name": path.name,
                "path": relative,
                "size": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                "url": f"/files/{relative}",
            }
        )
    return {"files": items[:200]}


@app.get("/files/{file_path:path}")
def serve_file(file_path: str, _: dict[str, Any] = Depends(get_current_user)) -> FileResponse:
    target = (DOWNLOAD_DIR / file_path).resolve()
    try:
        target.relative_to(DOWNLOAD_DIR)
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
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response
