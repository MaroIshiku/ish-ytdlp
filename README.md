# YTDLP Client

Self-hosted WebUI fuer `yt-dlp`, gebaut fuer Docker und ZimaOS.

## Hinweis

Diese App wurde von KI erstellt. Feature-Requests werden mit hoher Wahrscheinlichkeit nicht bearbeitet. Bugfixes, Wartung und andere Aenderungen erfolgen unregelmaessig oder moeglicherweise gar nicht.

## Funktionen

- Login-Seite mit Session-Cookie
- erster Benutzer wird beim ersten Start als Admin aus einem Docker-Secret erstellt
- Admins koennen weitere Benutzer erstellen, Passwoerter setzen und Benutzer loeschen
- Download-Queue fuer Video, MP4, MP3 und M4A
- Download-Optionen fuer Auto, Video, Audio, Captions und Thumbnails
- Video-Optionen fuer Container, Codec und maximale Aufloesung
- Audio-Optionen fuer Format und Bitrate
- Caption-Optionen fuer Sprache und Ausgabeformat
- optionaler Playlist-Download
- Live-Status mit Fortschritt, Geschwindigkeit und ETA
- benutzergetrennte Download-Historie: Benutzer sehen nur ihre eigenen Queue-Eintraege
- Dateigroesse und Download-Button direkt an abgeschlossenen Queue-Eintraegen
- System-Footer mit App-Version, Build-Commit, Build-Datum und yt-dlp-Version
- persistente SQLite-Datenbank in `data/` innerhalb von `/media/ZimaOS-HD/AppData/ish_ytdlp`
- Downloads in `downloads/` innerhalb von `/media/ZimaOS-HD/AppData/ish_ytdlp`

## Start auf ZimaOS / Docker

Wichtig: Die ZimaOS/CasaOS-App-UI kann lokale Docker-Builds oft nicht ausfuehren. Dann darf die importierte YAML kein `build:` enthalten, sondern muss auf ein bereits gebautes Image zeigen, zum Beispiel `ghcr.io/dein-name/ish-ytdlp:latest`.

Es gibt zwei Wege:

- Terminal auf ZimaOS: `docker-compose.yml` nutzen und lokal bauen.
- ZimaOS UI: `docker-compose.zimaos-ui.yml` nutzen und vorher ein Image in eine Registry pushen.

1. Projekt nach ZimaOS kopieren:

   ```text
   /media/ZimaOS-HD/AppData/ish_ytdlp
   ```

2. Passwort-Secret anpassen:

   Falls die Ordner noch nicht existieren:

   ```bash
   mkdir -p /media/ZimaOS-HD/AppData/ish_ytdlp/data
   mkdir -p /media/ZimaOS-HD/AppData/ish_ytdlp/downloads
   mkdir -p /media/ZimaOS-HD/AppData/ish_ytdlp/secrets
   ```

   ```powershell
   Set-Content -Path .\secrets\admin_password.txt -Value "ein-sehr-langes-admin-passwort"
   ```

   Auf Linux/macOS:

   ```bash
   printf '%s\n' 'ein-sehr-langes-admin-passwort' > secrets/admin_password.txt
   ```

   Auf ZimaOS/Linux:

   ```bash
   printf '%s\n' 'ein-sehr-langes-admin-passwort' > /media/ZimaOS-HD/AppData/ish_ytdlp/secrets/admin_password.txt
   ```

3. Container per Terminal starten:

   ```bash
   cd /media/ZimaOS-HD/AppData/ish_ytdlp
   docker compose up -d --build
   ```

   Wenn du stattdessen die ZimaOS-UI nutzt, muss das Image vorher durch GitHub Actions gebaut worden sein:

   ```yaml
   image: ghcr.io/maroishiku/ish-ytdlp:latest
   ```

4. WebUI oeffnen:

   ```text
   http://<zimaos-ip>:8180
   ```

5. Initial anmelden:

   ```text
   Benutzer: admin
   Passwort: Inhalt aus secrets/admin_password.txt
   ```

Nach dem ersten Start wird der Admin in SQLite gespeichert. Eine spaetere Aenderung des Secret-Files aendert bestehende Passwoerter nicht automatisch; das erledigst du im Admin-Bereich.

## Docker Compose

Der relevante Teil fuer Terminal-Builds ist in [docker-compose.yml](docker-compose.yml) enthalten:

```yaml
build:
  context: /media/ZimaOS-HD/AppData/ish_ytdlp
environment:
  FIRST_ADMIN_USERNAME: admin
  FIRST_ADMIN_PASSWORD_FILE: /run/secrets/first_admin_password
volumes:
  - /media/ZimaOS-HD/AppData/ish_ytdlp/data:/data
  - /media/ZimaOS-HD/AppData/ish_ytdlp/downloads:/downloads
secrets:
  first_admin_password:
    file: /media/ZimaOS-HD/AppData/ish_ytdlp/secrets/admin_password.txt
ports:
  - "8180:8080"
```

Die Compose-Datei verweist bewusst absolut auf `/media/ZimaOS-HD/AppData/ish_ytdlp`. Dadurch funktioniert sie auch dann eindeutig, wenn ZimaOS/CasaOS die YAML importiert oder aus einem anderen Arbeitsverzeichnis startet.

Fuer die ZimaOS-UI liegt eine separate Datei unter [docker-compose.zimaos-ui.yml](docker-compose.zimaos-ui.yml). Diese enthaelt kein `build:`, sondern nur `image:`. Ohne Registry-Image kann die ZimaOS-UI den Container nicht starten.

## Image fuer ZimaOS-UI bauen

### Automatisch ueber GitHub Actions

Dieses Projekt enthaelt einen Workflow unter `.github/workflows/publish-ghcr.yml`. Wenn du das Projekt nach GitHub pushst, baut GitHub automatisch ein Multi-Arch-Image fuer `linux/amd64` und `linux/arm64`.

Der Image-Name ist:

```text
ghcr.io/maroishiku/ish-ytdlp:latest
```

Diesen Wert traegst du in [docker-compose.zimaos-ui.yml](docker-compose.zimaos-ui.yml) ein:

```yaml
image: ghcr.io/maroishiku/ish-ytdlp:latest
```

Falls das GHCR-Package privat ist, kann ZimaOS es nicht ohne Registry-Login ziehen. Am einfachsten stellst du das Package in GitHub auf public oder meldest Docker auf ZimaOS bei `ghcr.io` an.

## yt-dlp Abhaengigkeiten

Das Docker-Image installiert `yt-dlp[default,curl-cffi]`. Dadurch sind die von yt-dlp empfohlenen Standard-Abhaengigkeiten sowie `curl_cffi` fuer Browser-Impersonation enthalten. Das hilft bei Seiten, die TLS-Fingerprinting einsetzen und sonst Meldungen wie `The extractor is attempting impersonation, but no impersonate target is available` ausgeben.

Zusaetzlich enthaelt das Image:

- `ffmpeg` und `ffprobe` fuer Merging und Post-Processing
- `yt-dlp-ejs` ueber die `default`-Dependency-Gruppe
- `deno` als JavaScript-Runtime fuer yt-dlp-ejs
- `AtomicParsley` fuer bestimmte Thumbnail-/Metadata-Faelle
- `rtmpdump` fuer aeltere RTMP-Sonderfaelle

Das verbessert die Kompatibilitaet deutlich, garantiert aber nicht, dass jede Website jederzeit funktioniert. Manche Seiten erfordern Cookies, Login, PO-Token, regionale IPs oder kurzfristige yt-dlp-Fixes.

### Manuell auf einem Rechner mit Docker

```bash
cd /pfad/zum/projekt
docker build -t ghcr.io/maroishiku/ish-ytdlp:latest .
docker login ghcr.io
docker push ghcr.io/maroishiku/ish-ytdlp:latest
```

Danach `docker-compose.zimaos-ui.yml` in ZimaOS importieren und `image:` auf genau diesen Namen setzen.

Wenn beim ersten Start noch kein Benutzer existiert und das Secret fehlt oder noch `change-me-before-first-start` enthaelt, beendet sich die App absichtlich mit einer Fehlermeldung.

## Lokale Entwicklung

```bash
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
$env:FIRST_ADMIN_PASSWORD="dev-password-with-10-chars"
.\.venv\Scripts\uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

Die WebUI liegt dann auf `http://127.0.0.1:8080`.
