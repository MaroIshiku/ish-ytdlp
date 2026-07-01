# Pulliku

Media Download Interface

> Pulliku is a calm, self-hosted web interface for media downloads with yt-dlp.

## Overview

Pulliku is a self-hosted web app from the ishiku family. It is designed for private or small personal deployments and follows the shared Pixel Soft Utility design system.

## Part of the ishiku Family

Pulliku uses the shared ishiku interface:

- quiet, rounded Pixel Soft Utility components
- six shared themes: Lavender, Mint, Sky, Amber, Rose, and Graphite
- Light, Dark, and System appearance modes
- consistent AppHeader, profile/settings sheets, and About/Admin areas
- consistent first-run setup for the first admin account

The app is intentionally meant to feel like part of a shared suite, not like a separate brand with its own design language.

## Features

- Pulliku-branded login, first-run setup, and dashboard UI
- Pixel Soft Utility design system with locally shipped tokens, components, and icons
- System, Light, and Dark appearance modes
- first admin account created on first start with a setup secret
- admins can create users, reset passwords, and delete users
- hardened sessions with HttpOnly cookies, CSRF protection, SameSite, and rate limiting
- user-scoped download history
- download queue for video and audio
- video options for container, codec, and maximum resolution
- audio options for format and bitrate
- optional playlist downloads
- live status with progress, speed, and ETA
- file size and download button directly on completed queue items
- completed files are deleted after the retention period unless marked as permanent
- About/Admin sheet with version, build, public IP, and yt-dlp diagnostics

## Tech Stack

- Frontend: static HTML, CSS, and vanilla JavaScript
- Backend: FastAPI / Uvicorn
- Storage: SQLite in `/data`
- Download engine: yt-dlp, ffmpeg, Deno, and yt-dlp-ejs in the Docker image
- Deployment: Docker / Docker Compose / ZimaOS

## Installation

### Docker Compose

Create the app data folders on ZimaOS or your Docker host:

```bash
mkdir -p /media/ZimaOS-HD/AppData/pulliku/data
mkdir -p /media/ZimaOS-HD/AppData/pulliku/downloads
```

Set a long setup secret in `docker-compose.yml`:

```yaml
ISHIKU_SETUP_SECRET: "replace-this-with-a-long-random-secret"
```

Start Pulliku:

```bash
cd /media/ZimaOS-HD/AppData/pulliku
docker compose up -d
```

The web UI is then available at:

```text
http://<zimaos-ip>:8180
```

### First Start

On first open, Pulliku automatically shows the registration window for the first admin account. Registration is only possible when the setup secret is entered correctly.

### Create the Admin Account

The registration window requires:

- setup secret from `ISHIKU_SETUP_SECRET` or the secret file
- display name
- admin username
- optional email
- admin password and confirmation

The admin password must not match the setup secret, username, or app name. After the first admin account is created successfully, public registration is closed automatically.

## Configuration

### Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `TZ` | Time zone for logs and display | `Europe/Berlin` |
| `ISHIKU_APP_URL` | Public app URL behind a reverse proxy | empty |
| `ISHIKU_ALLOWED_ORIGINS` | Optional comma-separated extra origins for HTTPS/reverse-proxy deployments | empty |
| `ISHIKU_BASE_PATH` | Base path behind a reverse proxy | `/` |
| `ISHIKU_DATA_DIR` | Persistent data path in the container | `/data` |
| `DOWNLOAD_DIR` | Download target path in the container | `/downloads` |
| `ISHIKU_LOG_LEVEL` | Log level | `info` |
| `ISHIKU_SETUP_SECRET_FILE` | Path to the Docker secret | `/run/secrets/ishiku_setup_secret` |
| `ISHIKU_SETUP_SECRET` | Fallback secret as an environment variable, used only when no secret file is configured | empty |
| `PULLIKU_FILE_RETENTION_DAYS` | Automatic retention period for completed files unless they are marked as permanent. `0` disables retention. | `7` |
| `PULLIKU_CLEANUP_INTERVAL_SECONDS` | Interval for the automatic cleanup job | `3600` |
| `APP_COOKIE_SECURE` | Secure cookies and HSTS for HTTPS | `false` |
| `SESSION_DAYS` | Session lifetime in days | `14` |

### Docker Secrets

For simple private deployments, `ISHIKU_SETUP_SECRET` can be set directly as clear text in the Compose environment.

A Docker/Compose secret file via `ISHIKU_SETUP_SECRET_FILE` is safer because environment values may be easier to read depending on the host.

For ZimaOS/CasaOS, `docker-compose.zimaos-ui.yml` is also available and bind-mounts the secret file directly.

### Persistent Data

Persistent data is stored by default in:

```text
/media/ZimaOS-HD/AppData/pulliku/data
```

Downloads are stored by default in:

```text
/media/ZimaOS-HD/AppData/pulliku/downloads
```

Back up both folders regularly when Pulliku is used in production.

## Security

- The setup secret is only used for the first admin registration.
- The admin password must not match the setup secret.
- Passwords are stored with PBKDF2-SHA256 hashes, never as clear text.
- Public registration is closed after the first admin account is created.
- Setup secrets, `.env`, databases, downloads, and logs do not belong in the repository.
- For HTTPS deployments, set `APP_COOKIE_SECURE=true` so Pulliku uses `__Host-` session cookies and HSTS.

## Updates and Backup

```bash
docker compose pull
docker compose up -d
```

Back up the persistent data folder before updates:

```bash
tar -czf backup-pulliku-$(date +%Y%m%d).tar.gz data downloads
```

## Development

```bash
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
$env:ISHIKU_SETUP_SECRET="Use-A-Local-Setup-Secret-2026!"
.\.venv\Scripts\uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

On first local open, create the admin account through the setup window with the configured setup secret.

When making changes, keep the shared Pixel Soft Utility design system intact and avoid app-specific UI deviations.

## Created With ChatGPT Codex

This project was created and revised with support from ChatGPT Codex. Codex was used to generate and refine code, structure, UI components, and documentation according to the ishiku / Pixel Soft Utility standards.

Responsibility for operation, review, security, and publication remains with the repository owner.

## Status and License

Status: personal self-hosted project

License: not specified
