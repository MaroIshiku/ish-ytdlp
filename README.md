# Pulliku

Media Download Interface

> Pulliku ist ein ruhiges, self-hosted Webinterface fuer Medien-Downloads mit yt-dlp.

## Kurzbeschreibung

Pulliku ist eine self-hosted Web-App aus der ishiku-Familie. Die App ist fuer private oder kleine eigene Deployments gedacht und folgt dem gemeinsamen Pixel Soft Utility Designsystem.

## Teil der ishiku-Familie

Pulliku verwendet die gemeinsame ishiku Oberflaeche:

- ruhige, abgerundete Pixel-Soft-Utility-Komponenten
- sechs gemeinsame Themes: Lavender, Mint, Sky, Amber, Rose und Graphite
- Light, Dark und System Mode
- einheitlicher AppHeader, Profil-/Einstellungs-Sheets und About/Admin-Bereiche
- einheitliches First-Run-Setup fuer den ersten Adminaccount

Die App soll sich bewusst wie Teil einer gemeinsamen Suite anfuehlen, nicht wie eine separate Marke mit eigener Designsprache.

## Funktionen

- Pulliku-branded Login, First-Run-Setup und Dashboard UI
- Pixel Soft Utility Designsystem mit lokal ausgelieferten Tokens, Komponenten und Icons
- System, Light und Dark Appearance Modes
- erster Adminaccount wird beim ersten Start ueber ein Setup-Secret erstellt
- Admins koennen User erstellen, Passwoerter zuruecksetzen und User loeschen
- gehaertete Sessions mit HttpOnly-Cookies, CSRF-Schutz, SameSite und Rate Limiting
- user-scoped Download-Historie
- Download-Queue fuer Video und Audio
- Video-Optionen fuer Container, Codec und maximale Aufloesung
- Audio-Optionen fuer Format und Bitrate
- optionale Playlist-Downloads
- Live-Status mit Fortschritt, Geschwindigkeit und ETA
- Datei-Groesse und Download-Button direkt an abgeschlossenen Queue-Eintraegen
- About/Admin-Sheet mit Version, Build, Public IP und yt-dlp-Diagnostik

## Tech Stack

- Frontend: statisches HTML, CSS und Vanilla JavaScript
- Backend: FastAPI / Uvicorn
- Datenhaltung: SQLite in `/data`
- Download Engine: yt-dlp, ffmpeg, Deno und yt-dlp-ejs im Docker Image
- Deployment: Docker / Docker Compose / ZimaOS

## Installation

### Docker Compose

Lege die App-Daten auf ZimaOS oder deinem Docker-Host an:

```bash
mkdir -p /media/ZimaOS-HD/AppData/pulliku/data
mkdir -p /media/ZimaOS-HD/AppData/pulliku/downloads
```

Trage in `docker-compose.yml` ein langes Setup-Secret ein:

```yaml
ISHIKU_SETUP_SECRET: "ersetze-das-durch-ein-langes-zufaelliges-secret"
```

Starte Pulliku:

```bash
cd /media/ZimaOS-HD/AppData/pulliku
docker compose up -d
```

Die WebUI ist danach erreichbar unter:

```text
http://<zimaos-ip>:8180
```

### Erstes Starten

Beim ersten Oeffnen zeigt Pulliku automatisch das Registrierungsfenster fuer den ersten Adminaccount an. Die Registrierung ist nur moeglich, wenn das Setup-Secret korrekt eingegeben wird.

### Adminaccount erstellen

Im Registrierungsfenster werden benoetigt:

- Setup-Secret aus `ISHIKU_SETUP_SECRET` oder aus der Secret-Datei
- Anzeigename
- Admin-Benutzername
- optional E-Mail
- Admin-Passwort und Wiederholung

Das Admin-Passwort darf nicht mit dem Setup-Secret, dem Usernamen oder dem App-Namen uebereinstimmen. Nach erfolgreicher Erstellung des ersten Adminaccounts wird die oeffentliche Registrierung automatisch geschlossen.

## Konfiguration

### Umgebungsvariablen

| Variable | Beschreibung | Standard |
| --- | --- | --- |
| `TZ` | Zeitzone fuer Logs und Anzeige | `Europe/Berlin` |
| `ISHIKU_APP_URL` | Oeffentliche URL der App hinter einem Reverse Proxy | leer |
| `ISHIKU_ALLOWED_ORIGINS` | Optionale kommaseparierte Zusatz-Origins fuer HTTPS/Reverse-Proxy-Deployments | leer |
| `ISHIKU_BASE_PATH` | Basis-Pfad hinter Reverse Proxy | `/` |
| `ISHIKU_DATA_DIR` | Persistenter Datenpfad im Container | `/data` |
| `DOWNLOAD_DIR` | Download-Zielpfad im Container | `/downloads` |
| `ISHIKU_LOG_LEVEL` | Log-Level | `info` |
| `ISHIKU_SETUP_SECRET_FILE` | Pfad zum Docker-Secret | `/run/secrets/ishiku_setup_secret` |
| `ISHIKU_SETUP_SECRET` | Fallback-Secret als ENV, nur wenn kein Secret-File genutzt wird | leer |
| `PULLIKU_FILE_RETENTION_DAYS` | Automatische Loeschfrist fuer abgeschlossene Dateien, ausser sie sind permanent markiert. `0` deaktiviert die Frist. | `7` |
| `PULLIKU_CLEANUP_INTERVAL_SECONDS` | Intervall fuer den automatischen Cleanup-Job | `3600` |
| `APP_COOKIE_SECURE` | Secure Cookies und HSTS fuer HTTPS | `false` |
| `SESSION_DAYS` | Session-Laufzeit in Tagen | `14` |

### Docker Secrets

Fuer einfache private Deployments kann `ISHIKU_SETUP_SECRET` direkt als Klartext in der Compose-Umgebung gesetzt werden.

Sicherer ist ein Docker/Compose Secret als Datei ueber `ISHIKU_SETUP_SECRET_FILE`, weil ENV-Werte je nach Host leichter auslesbar sind.

Fuer ZimaOS/CasaOS gibt es zusaetzlich `docker-compose.zimaos-ui.yml`, das die Secret-Datei direkt bind-mounted.

### Persistente Daten

Persistente Daten liegen standardmaessig in:

```text
/media/ZimaOS-HD/AppData/pulliku/data
```

Downloads liegen standardmaessig in:

```text
/media/ZimaOS-HD/AppData/pulliku/downloads
```

Sichere beide Ordner regelmaessig, wenn Pulliku produktiv genutzt wird.

## Sicherheit

- Das Setup-Secret dient nur zur ersten Admin-Registrierung.
- Das Admin-Passwort darf nicht dem Setup-Secret entsprechen.
- Passwoerter werden mit PBKDF2-SHA256 gehasht gespeichert, nie im Klartext.
- Die oeffentliche Registrierung wird nach dem ersten Adminaccount geschlossen.
- Setup-Secret, `.env`, Datenbanken, Downloads und Logs gehoeren nicht ins Repository.
- Fuer HTTPS-Deployments sollte `APP_COOKIE_SECURE=true` gesetzt werden, damit Pulliku `__Host-` Session-Cookies und HSTS nutzt.

## Updates und Backup

```bash
docker compose pull
docker compose up -d
```

Vor Updates sollte der persistente Datenordner gesichert werden:

```bash
tar -czf backup-pulliku-$(date +%Y%m%d).tar.gz data downloads
```

## Entwicklung

```bash
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
$env:ISHIKU_SETUP_SECRET="Use-A-Local-Setup-Secret-2026!"
.\.venv\Scripts\uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

Beim ersten lokalen Oeffnen erstellst du den Adminaccount ueber das Setup-Fenster mit dem gesetzten Setup-Secret.

Codex soll bei Aenderungen das gemeinsame Pixel Soft Utility Designsystem beibehalten und keine app-spezifischen UI-Abweichungen einfuehren.

## Erstellt mit ChatGPT Codex

Dieses Projekt wurde mit Unterstuetzung von ChatGPT Codex erstellt bzw. ueberarbeitet. Codex wurde verwendet, um Code, Struktur, UI-Komponenten und Dokumentation nach den Vorgaben der ishiku / Pixel Soft Utility Standards zu generieren.

Die Verantwortung fuer Betrieb, Pruefung, Sicherheit und Veroeffentlichung liegt beim Repository-Betreiber.

## Status und Lizenz

Status: persoenliches self-hosted Projekt

Lizenz: nicht angegeben
