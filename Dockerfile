# syntax=docker/dockerfile:1
#
# Stage 8A: production-ready container image only. No docker-compose, no
# Traefik, no deployment, no PostgreSQL/Qdrant topology change here — see
# the accepted-baseline production decisions this build honors:
#   - runtime command is `python service_main.py` (unified Telegram+web
#     composition root — see that module's own docstring), never
#     web_main.py/main.py alone;
#   - exactly one application replica, ever: service_main.py's embedded
#     Qdrant client (rag/index.py, `QdrantClient(path=...)`) holds an
#     exclusive on-disk storage lock for its whole process lifetime, so a
#     second replica sharing the same mounted data/qdrant would fail to
#     start;
#   - migrations (alembic/) are shipped for an operator to run explicitly
#     inside the container (`alembic upgrade head`) — NEVER invoked
#     automatically by this image's own ENTRYPOINT/CMD or by application
#     startup code;
#   - inside the container the web server binds 0.0.0.0:8000 (see the
#     WEB_HOST/WEB_PORT ENV below) — the 127.0.0.1 default in
#     service_main.py/web_main.py/web_config.py remains correct for local,
#     non-containerized use and is intentionally left unchanged.

########################################################################
# Stage 1/2: frontend build (Stage 7B-1 compiled React app)
########################################################################
FROM node:24-alpine AS frontend-builder

WORKDIR /frontend

# Reproducible install from the committed lockfile only — never a plain
# `npm install`, which could silently resolve different dependency
# versions than CI/local development use.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build
# -> /frontend/dist (Vite's content-hashed build output; web/frontend.py's
# FRONTEND_DIST_DIR expects this at <repo-root>/frontend/dist).

########################################################################
# Stage 2/2: Python runtime
########################################################################
FROM python:3.12-slim-bookworm AS runtime

# ffmpeg: NOT a pip package — services/stt.py shells out to it via pydub
# to convert Telegram voice OGG uploads to WAV before Whisper transcription.
# Nothing else here needs a system package: pypdf/docx2txt/qdrant-client/
# psycopg[binary] all ship manylinux wheels for this base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=8000

# Runtime dependencies only (requirements.txt) — requirements-dev.txt
# (pytest/pytest-asyncio/pytest-socket) is deliberately never installed
# or copied into this image. --no-compile: pip precompiles installed
# packages to .pyc under site-packages by default regardless of
# PYTHONDONTWRITEBYTECODE (that only governs bytecode written by the
# interpreter at import time, not pip's own install-time compileall
# pass) — without this flag, third-party dependency bytecode is the
# only source of __pycache__/.pyc left in the image.
COPY requirements.txt ./
RUN pip install --no-cache-dir --no-compile -r requirements.txt

# Application source, copied explicitly by path rather than `COPY . .` so
# the exact contents of this image stay reviewable here regardless of
# .dockerignore. No .env/secrets, no venv/, no tests/, no VCS metadata.
COPY alembic.ini ./
COPY alembic/ ./alembic/
COPY app/ ./app/
COPY db/ ./db/
COPY handlers/ ./handlers/
COPY rag/ ./rag/
COPY scripts/ ./scripts/
COPY services/ ./services/
COPY utils/ ./utils/
COPY web/ ./web/
COPY bot.py config.py github_oauth_config.py main.py service_main.py \
     session_config.py telegram_config.py telegram_link_config.py \
     web_config.py web_main.py ./

# Committed reference documents for RAG — copied by exact filename
# (never a whole-directory COPY) so nothing else that might exist under
# data/documents/ locally (uploads/, .gitkeep, an ignored/private file)
# can ever reach the image, regardless of .dockerignore. These four names
# are rag/constants.BUILTIN_REFERENCE_FILES verbatim; the uploads
# directory is recreated empty, runtime-writable, below instead.
COPY data/documents/python-fundamentals.md \
     data/documents/functions-classes-errors.md \
     data/documents/testing-debugging.md \
     data/documents/async-python-and-apis.md \
     ./data/documents/

# Compiled frontend from stage 1, at the exact path web/frontend.py reads
# per request (FRONTEND_DIST_DIR = <repo-root>/frontend/dist).
COPY --from=frontend-builder /frontend/dist ./frontend/dist

# The upstream python:3.12-slim-bookworm base image itself ships ~97
# pre-existing __pycache__/ directories under its own stdlib
# (/usr/local/lib/python3.12/...), already empty (zero .pyc/.pyo inside,
# verified against the pristine base image) — not produced by this build,
# not application code, not a host-path leak. `-empty -delete` here is a
# no-op for interpreter behavior (Python only creates __pycache__ on
# demand to write bytecode, which PYTHONDONTWRITEBYTECODE=1 above
# already disables) and only removes directories confirmed to hold
# nothing.
RUN find /usr/local/lib -depth -type d -name '__pycache__' -empty -delete

# Non-root runtime user (Stage 8A requirement). Ownership is granted only
# on the three paths the application actually writes at runtime — never
# `chown -R /app` — so application source, Alembic config/migrations, the
# compiled frontend, and the reference corpus stay root-owned and
# immutable to the runtime account:
#   - data/qdrant            (rag/index.py's embedded QdrantClient storage)
#   - data/documents/uploads (handlers/document_upload.py managed uploads)
#   - bot.log                (utils/logging.py's configure_logging() opens
#                              BASE_DIR / "bot.log", i.e. /app/bot.log, in
#                              append mode; pre-creating it here means the
#                              runtime user only needs write on the file
#                              itself, never on /app's directory listing)
# Directories are 700 and the log file is 600 — owner-only, never
# world- or group-writable. A fixed numeric UID/GID (not an auto-assigned
# one) so a future bind mount of data/qdrant or data/documents/uploads
# from the host can be chowned to a known, stable id ahead of time.
RUN groupadd --gid 10001 appgroup \
    && useradd --uid 10001 --gid appgroup --home-dir /app --no-create-home \
        --shell /usr/sbin/nologin appuser \
    && mkdir -p data/qdrant data/documents/uploads \
    && touch bot.log \
    && chown -R appuser:appgroup data/qdrant data/documents/uploads bot.log \
    && chmod 700 data/qdrant data/documents/uploads \
    && chmod 600 bot.log

USER appuser

# Documentation only — does not publish/bind a host port (that remains an
# explicit `docker run -p` / future Traefik decision, out of scope here).
EXPOSE 8000

# Liveness only (web/routes.py's healthz() docstring: "no authentication,
# no database access") — deliberately not treated as a readiness probe in
# this slice. Plain stdlib urllib, no curl dependency added solely for
# this: urlopen() raises on a non-2xx status or connection failure, which
# Python then reports as a non-zero exit code, exactly what HEALTHCHECK
# needs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"]

# Unified Telegram+web composition root (Stage 7A-3) — the production
# runtime entrypoint. Never web_main.py/main.py alone in this image.
CMD ["python", "service_main.py"]
