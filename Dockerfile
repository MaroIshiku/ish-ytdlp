FROM denoland/deno:bin-2.8.3 AS deno

FROM python:3.12-slim

ARG APP_VERSION=0.1.1
ARG APP_BUILD_SHA=dev
ARG APP_BUILD_DATE=unknown

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ISHIKU_DATA_DIR=/data \
    DOWNLOAD_DIR=/downloads \
    APP_VERSION=${APP_VERSION} \
    APP_BUILD_SHA=${APP_BUILD_SHA} \
    APP_BUILD_DATE=${APP_BUILD_DATE} \
    DENO_DIR=/tmp/deno

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl atomicparsley rtmpdump \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deno /deno /usr/local/bin/deno

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN mkdir -p /data /downloads /run/secrets

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD curl -fsS http://localhost:8080/healthz || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
