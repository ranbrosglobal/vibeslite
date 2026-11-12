"""Security middleware for the Vibes Lite API.

Two ASGI middlewares, both dependency-free:

``SecurityHeadersMiddleware``
    Adds the hardening headers, including a Content-Security-Policy scoped to
    what this API actually serves. It also attaches a request id so a client
    report can be tied to a log line without exposing internals.

``RateLimitMiddleware``
    A fixed-window token bucket keyed by client address and route class. Read
    routes get a generous budget; the analysis endpoints (which decode rasters
    and can burn hundreds of MB) get a tighter one. A 429 always says when to
    retry.

Both are intentionally small and observable: ``/api/security`` publishes exactly
the limits and headers that are live, so the posture can be asserted in tests
instead of described in prose.
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from typing import Callable, Dict, Iterable, Tuple

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

# Basemap tile hosts. Taken from the same catalogue the map layers are built
# from (``osm.BASEMAPS``) instead of being retyped here, so adding or removing a
# basemap cannot silently leave the policy pointing at a host nothing loads -
# or block a host the frontend does load.
def _basemap_hosts() -> str:
    hosts = {"server.arcgisonline.com", "mt1.google.com"}  # non-OSM basemaps the frontends offer
    try:
        from osm import tile_hosts

        hosts.update(tile_hosts())
    except Exception:  # pragma: no cover - a broken import must not weaken the rest of the policy
        hosts.add("tile.openstreetmap.org")
    return " ".join(f"https://{host}" for host in sorted(hosts))


# Origins the API's own documentation and OpenAPI bundles need.
_CSP = "; ".join(
    [
        "default-src 'self'",
        # Swagger UI and ReDoc ship their own inline bootstrap scripts.
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        f"img-src 'self' data: blob: https://fastapi.tiangolo.com {_basemap_hosts()}",
        # Geocoding and map features are proxied through this API, so the
        # browser still only ever talks to 'self'.
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)

SECURITY_HEADERS: Dict[str, str] = {
    "Content-Security-Policy": _CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(self), camera=(self), microphone=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
    "X-XSS-Protection": "0",
    # Generated assets are maps and charts; a strict CSP plus an explicit
    # content type is enough, and `sandbox` would break the map tiles' images.
    "X-Permitted-Cross-Domain-Policies": "none",
}

# Route classes and their default per-minute budgets. Anything not listed falls
# into the read bucket.
_ANALYSIS_PREFIXES = (
    "/api/ndvi",
    "/api/crop-health",
    "/api/opencv",
    "/api/segmentation",
    "/api/timeseries",
    "/api/upload",
    "/api/samples",
    "/api/agronomy",
)
_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def route_class(path: str, method: str) -> str:
    """Bucket a request into ``read``, ``analysis`` or ``write``."""
    if path.startswith(_ANALYSIS_PREFIXES):
        return "analysis"
    if method.upper() in _WRITE_METHODS:
        return "write"
    return "read"


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Attach hardening headers and a request id to every response."""

    def __init__(self, app: ASGIApp, headers: Dict[str, str] | None = None) -> None:
        super().__init__(app)
        self._headers = dict(headers or SECURITY_HEADERS)

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        try:
            response = await call_next(request)
        except Exception:  # pragma: no cover - the app's own handler renders this
            raise
        for key, value in self._headers.items():
            response.headers.setdefault(key, value)
        response.headers["X-Request-ID"] = request_id
        forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
        if request.url.scheme == "https" or forwarded == "https":
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response


class _Bucket:
    __slots__ = ("count", "reset")

    def __init__(self) -> None:
        self.count = 0
        self.reset = time.monotonic()


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Fixed-window rate limiting per client address and route class.

    The window is a monotonic clock, so a wall-clock change cannot hand out a
    free burst. State is process-local — with multiple workers each holds its
    own budget, which is the honest trade-off for a dependency-free limiter and
    is stated as such in ``/api/security``.
    """

    def __init__(
        self,
        app: ASGIApp,
        window_seconds: int = 60,
        limits: Dict[str, int] | None = None,
        enabled: bool = True,
        exempt_paths: Iterable[str] = ("/api/security",),
    ) -> None:
        super().__init__(app)
        self.window = max(1, int(window_seconds))
        self.limits = dict(
            limits
            or {
                "read": _env_int("VIBES_RATE_LIMIT_READ", 1200),
                "write": _env_int("VIBES_RATE_LIMIT_WRITE", 240),
                "analysis": _env_int("VIBES_RATE_LIMIT_ANALYSIS", 120),
            }
        )
        self.enabled = enabled and os.getenv("VIBES_RATE_LIMIT_DISABLED", "").lower() not in {"1", "true", "yes"}
        self.exempt_paths = set(exempt_paths)
        self._buckets: Dict[Tuple[str, str], _Bucket] = {}
        self._lock = threading.Lock()
        self._swept = 0.0

    # -- internals ---------------------------------------------------------
    def _client(self, request: Request) -> str:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip() or "unknown"
        client = request.client
        return client.host if client and client.host else "unknown"

    def _sweep(self, now: float) -> None:
        if now - self._swept < self.window:
            return
        self._swept = now
        stale = [key for key, bucket in self._buckets.items() if now - bucket.reset >= self.window * 2]
        for key in stale:
            self._buckets.pop(key, None)

    # -- middleware --------------------------------------------------------
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        if not self.enabled or request.url.path in self.exempt_paths:
            return await call_next(request)

        kind = route_class(request.url.path, request.method)
        limit = self.limits.get(kind, self.limits["read"])
        key = (self._client(request), kind)
        now = time.monotonic()

        with self._lock:
            self._sweep(now)
            bucket = self._buckets.get(key)
            if bucket is None or now - bucket.reset >= self.window:
                bucket = _Bucket()
                bucket.reset = now
                self._buckets[key] = bucket
            bucket.count += 1
            used = bucket.count
            elapsed = now - bucket.reset

        remaining = max(0, limit - used)
        headers = {
            "RateLimit-Limit": str(limit),
            "RateLimit-Remaining": str(remaining),
            "RateLimit-Reset": str(int(self.window - elapsed) + 1),
        }

        if used > limit:
            retry_after = max(1, int(self.window - elapsed) + 1)
            headers["Retry-After"] = str(retry_after)
            return JSONResponse(
                status_code=429,
                headers=headers,
                content={
                    "error": "TooManyRequests",
                    "detail": f"Rate limit exceeded for {kind} requests — retry in {retry_after}s.",
                    "status": 429,
                    "retryAfter": retry_after,
                },
            )

        response = await call_next(request)
        for name, value in headers.items():
            response.headers[name] = value
        return response
