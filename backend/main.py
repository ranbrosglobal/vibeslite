"""Vibes Lite application entrypoint.

Run locally:
    cd backend && uvicorn main:app --reload --port 8000
or from the project root:
    uvicorn main:app --app-dir backend --reload --port 8000

In Docker the same app is served by uvicorn on port 8000.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

# Load .env before importing config so environment overrides are applied.
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)

from api import router  # noqa: E402  (import after dotenv on purpose)
from config import ensure_directories, get_config, project_info, project_paths  # noqa: E402
from data import DataError  # noqa: E402
from security import SECURITY_HEADERS, RateLimitMiddleware, SecurityHeadersMiddleware  # noqa: E402
from storage import StorageError, jsonable  # noqa: E402

logging.basicConfig(level=os.getenv("VIBES_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("vibes-lite")

DESCRIPTION = """
**Vibes Lite** is a lightweight, independent open agriculture intelligence platform.

It ingests agricultural fields (GeoJSON) and raster imagery (GeoTIFF: RGB, multispectral,
satellite or drone), clips them geospatially, computes vegetation indices (NDVI first),
classifies crop health with configurable thresholds, refines masks with OpenCV, prepares
segmentation-ready outputs and renders maps, charts and GeoJSON exports.

This implementation is inspired by the concepts of Microsoft FarmVibes.AI but is fully
independent: it shares no code and has no runtime dependency on FarmVibes.AI.
"""

app = FastAPI(
    title="Vibes Lite API",
    description=DESCRIPTION,
    version=get_config().get("project", {}).get("version", "0.1.0"),
    contact={"name": "Vibes Lite"},
    license_info={"name": "MIT"},
)

def _cors_origins() -> list[str]:
    """Parse the configured CORS origins.

    ``*`` stays supported (the shipped default suits local development behind
    the Vite proxy) but is never combined with credentials, and it is called
    out loudly at startup so nobody ships it to production by accident — see
    the production check in ``on_startup``.
    """
    raw = str(get_config().get("api", {}).get("cors_origins", "*")).strip()
    if raw in {"*", ""}:
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


_cors = _cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors,
    allow_credentials=False,  # a wildcard origin plus credentials is never valid
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Request-ID"],
    expose_headers=["X-Request-ID", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"],
    max_age=600,
)

# Order matters: the outermost middleware runs first on the way in, so the
# headers are applied even to a 429 produced by the limiter below it.
app.add_middleware(RateLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)

app.include_router(router)


def _mount_outputs() -> None:
    """Serve generated analysis assets (maps, charts, GeoJSON) under /outputs."""
    outputs = ensure_directories()["outputs"]
    app.mount("/outputs", StaticFiles(directory=str(outputs), html=False), name="outputs")


_mount_outputs()


@app.exception_handler(DataError)
async def data_error_handler(_: Request, exc: DataError) -> JSONResponse:
    """User-correctable input problems -> 400/404 with a clean message."""
    status_code = getattr(exc, "status_code", 400)
    return JSONResponse(
        status_code=status_code,
        content={"error": exc.__class__.__name__, "detail": str(exc), "status": status_code},
    )


@app.exception_handler(StorageError)
async def storage_error_handler(_: Request, exc: StorageError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"error": "StorageError", "detail": str(exc), "status": 400},
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(_: Request, exc: Exception) -> JSONResponse:
    """Last-resort handler: log the traceback, never leak internals to the client."""
    logger.exception("Unhandled error: %s", exc)
    return JSONResponse(
        status_code=500,
        content={
            "error": "InternalError",
            "detail": "Unexpected server error while processing the request. Check the backend logs for details.",
            "status": 500,
        },
    )


@app.get("/", include_in_schema=False)
def root() -> Dict[str, Any]:
    info = project_info()
    return {
        "service": info["name"],
        "version": info["version"],
        "docs": "/docs",
        "api": "/api",
        "outputs": "/outputs",
        "endpoints": [
            "/api/health",
            "/api/project",
            "/api/config",
            "/api/security",
            "/api/dashboard",
            "/api/datasets",
            "/api/aoi",
            "/api/geo/status",
            "/api/geo/search",
            "/api/geo/reverse",
            "/api/geo/features",
            "/api/geo/aoi-from-point",
            "/api/satellite/catalogue",
            "/api/satellite/scenes",
            "/api/satellite/fetch",
            "/api/weather/catalogue",
            "/api/weather/current",
            "/api/weather/daily",
            "/api/weather/crosscheck",
            "/api/weather/for-dates",
            "/api/upload",
            "/api/ndvi",
            "/api/crop-health",
            "/api/opencv/process",
            "/api/segmentation",
            "/api/timeseries",
            "/api/agronomy/gdd",
            "/api/agronomy/water-balance",
            "/api/agronomy/zones",
            "/api/agronomy/prescription",
            "/api/agronomy/carbon",
            "/api/agronomy/yield-forecast",
            "/api/agronomy/disease-risk",
            "/api/results",
            "/api/samples/synthetic",
        ],
    }


@app.on_event("startup")
def on_startup() -> None:
    paths = ensure_directories()
    info = project_info()
    logger.info(
        "%s %s starting - raw=%s outputs=%s",
        info["name"],
        info["version"],
        paths["raw_data"],
        paths["outputs"],
    )
    logger.info("OpenCV engine: %s | visualization: %s", info["opencv_enabled"], info["visualization_enabled"])
    logger.info("Security headers active: %d | rate limiting: on", len(SECURITY_HEADERS))
    # Say the unsafe things out loud rather than burying them in a config file.
    if "*" in _cors:
        logger.warning(
            "CORS allows every origin. Fine behind the local Vite proxy; set VIBES_CORS_ORIGINS to your real "
            "origin before exposing this API to the internet."
        )
    if os.getenv("VIBES_RATE_LIMIT_DISABLED", "").lower() in {"1", "true", "yes"}:
        logger.warning("Rate limiting is DISABLED via VIBES_RATE_LIMIT_DISABLED.")


@app.on_event("shutdown")
def on_shutdown() -> None:
    logger.info("Vibes Lite API stopped")


def _run() -> None:  # pragma: no cover - manual entrypoint
    import uvicorn

    config = get_config().get("api", {})
    uvicorn.run(
        "main:app",
        host=os.getenv("VIBES_HOST", config.get("host", "0.0.0.0")),
        port=int(os.getenv("VIBES_PORT", config.get("port", 8000))),
    )


if __name__ == "__main__":  # pragma: no cover
    _run()
