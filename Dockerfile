# Vibes Lite - one Dockerfile, two build targets.
#
#   docker build --target backend  -t vibes-lite-backend  .
#   docker build --target frontend -t vibes-lite-frontend .
#
# docker-compose.yml builds both targets, mounts data/ and outputs/ so
# analysis results survive container rebuilds.
#
# The backend stage is deliberately LAST: Vercel's container runtime builds the
# final stage of this file and serves it behind /api and /outputs (see
# vercel.json), so the image it produces has to be the API. docker-compose.yml
# names the stages explicitly, so the order makes no difference there.

# --------------------------------------------------------------------------- #
# Frontend: React + Vite dashboard served by the Vite dev server
# --------------------------------------------------------------------------- #
FROM node:20-alpine AS frontend

ENV NODE_ENV=development

WORKDIR /app

# Install dependencies first so the layer is cached across source changes.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./

EXPOSE 5173

# Vite proxies /api and /outputs to the backend (see vite.config.js), so the
# browser only ever talks to this single origin.
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]

# --------------------------------------------------------------------------- #
# Backend: FastAPI + geospatial + OpenCV + visualization (default/final stage)
# --------------------------------------------------------------------------- #
FROM python:3.11-slim AS backend

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MPLBACKEND=Agg

# Runtime libraries used by the rasterio / geopandas / OpenCV wheels.
# (The wheels bundle GDAL, PROJ and OpenCV themselves - no compilation needed.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgomp1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Project layout inside the image mirrors the repository:
#   /app/backend  engines + API      /app/config.yaml  configuration
#   /app/data     raw + processed    /app/outputs      generated assets
COPY config.yaml ./config.yaml
COPY backend/ backend/
COPY tests/ tests/

# Ship the demo results so a deployed container has something to show in
# /api/results and /outputs before anyone runs a new analysis. They live in
# demo/ because outputs/ is gitignored and would not exist in a fresh clone.
COPY demo/outputs/ outputs/

RUN mkdir -p data/raw data/processed outputs

# Vercel's container router sends traffic to port 80 unless the project sets
# PORT. The image therefore listens on 80 by default; docker-compose.yml sets
# PORT=8000 so the published 8000:8000 mapping keeps working locally.
ENV PORT=80
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-80}/api/health" || exit 1

WORKDIR /app/backend
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-80}"]
