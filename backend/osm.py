"""OpenStreetMap services for Vibes Lite.

Three providers, all from the OpenStreetMap project, all reached **server-side**:

``Nominatim``   forward geocoding ("where is Emmeloord?") and reverse geocoding
                ("what is at 52.71, 5.74?").
``Overpass``    real map features around a point - roads, waterways, water and
                land use - returned as GeoJSON the map can draw directly.
``OSM tiles``   the raster basemaps, catalogued here once so the frontends, the
                service worker and the Content-Security-Policy allowlist cannot
                drift apart.

Why a server-side proxy instead of calling Nominatim from the browser
---------------------------------------------------------------------
* The Nominatim usage policy requires an identifying ``User-Agent`` and at most
  **one request per second** per application. Both are enforceable in one place
  here and are not enforceable from a tab.
* The browser's CSP stays closed (``connect-src 'self'``): no third-party origin
  is added to it, so geocoding cannot become an exfiltration path.
* Responses are cached, so a repeated lookup costs the public API nothing.

Everything degrades honestly. A disabled provider, an unreachable network or a
malformed upstream reply raises an error naming the provider and the reason -
this module never invents a coordinate, a place name or a map feature.
"""
from __future__ import annotations

import json
import math
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Iterable, List, Mapping, Sequence, Tuple

from config import osm_config
from data import DataError

# --------------------------------------------------------------------------- #
# errors
# --------------------------------------------------------------------------- #
class OSMError(DataError):
    """Base class for OpenStreetMap provider problems (maps to HTTP 400)."""

    status_code = 400


class OSMDisabled(OSMError):
    """The OpenStreetMap providers are switched off in configuration."""

    status_code = 503


class OSMUnavailable(OSMError):
    """The provider could not be reached or answered with something unusable."""

    status_code = 503


class OSMUpstreamError(OSMError):
    """The provider answered, but rejected the request."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


# --------------------------------------------------------------------------- #
# tile / basemap catalogue
# --------------------------------------------------------------------------- #
# ``tile_host`` is what the Content-Security-Policy ``img-src`` allowlist has to
# carry; ``tile_server_policy`` is the upstream's own usage requirement, which
# the UI repeats next to the attribution.
ATTRIBUTION = "© OpenStreetMap contributors"
LICENCE = "ODbL 1.0"
COPYRIGHT_URL = "https://www.openstreetmap.org/copyright"

BASEMAPS: Dict[str, Dict[str, Any]] = {
    "osm": {
        "key": "osm",
        "label": "OSM Street",
        "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "tile_host": "tile.openstreetmap.org",
        "attribution": ATTRIBUTION,
        "licence": LICENCE,
        "max_zoom": 19,
        "provider": "OpenStreetMap Foundation",
        "style": "street",
        "note": "The reference OpenStreetMap raster style. Volunteer-mapped, so detail varies by region.",
    },
    "osm_hot": {
        "key": "osm_hot",
        "label": "OSM Humanitarian",
        "url": "https://tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
        "tile_host": "tile.openstreetmap.fr",
        "attribution": f"{ATTRIBUTION}, Tiles: Humanitarian OpenStreetMap Team",
        "licence": LICENCE,
        "max_zoom": 20,
        "provider": "Humanitarian OpenStreetMap Team",
        "style": "street",
        "note": "HOT styling emphasises roads, tracks, settlements and water - useful for rural access planning.",
    },
    "osm_topo": {
        "key": "osm_topo",
        "label": "OSM Terrain",
        "url": "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
        "tile_host": "a.tile.opentopomap.org",
        "attribution": f"{ATTRIBUTION}, SRTM | © OpenTopoMap (CC-BY-SA)",
        "licence": f"{LICENCE} + CC-BY-SA 3.0 (OpenTopoMap)",
        "max_zoom": 17,
        "provider": "OpenTopoMap",
        "style": "terrain",
        "note": "Contour lines and hillshade on top of OpenStreetMap data - the drainage read, not the crop read.",
    },
}

# Tile servers are a shared community resource: a browser that hammers them
# gets the whole project blocked. The UI states this next to the switcher.
TILE_SERVER_POLICY = (
    "OpenStreetMap tile servers are donated capacity: they are for interactive "
    "use at a human pace, not for bulk download or prefetching a whole AOI."
)


def basemaps() -> List[Dict[str, Any]]:
    """The OpenStreetMap basemap catalogue, in display order."""
    return [dict(entry) for entry in BASEMAPS.values()]


def tile_hosts() -> List[str]:
    """Every host the OSM basemaps load from (the CSP ``img-src`` allowlist)."""
    hosts = {str(entry["tile_host"]) for entry in BASEMAPS.values()}
    return sorted(hosts)


# --------------------------------------------------------------------------- #
# map feature catalogue (Overpass)
# --------------------------------------------------------------------------- #
# One definition per drawable feature class. ``selectors`` are Overpass QL
# selector expressions evaluated ``around`` the requested point.
FEATURE_KINDS: Dict[str, Dict[str, Any]] = {
    "roads": {
        "label": "Roads and tracks",
        "selectors": ['way["highway"]'],
        "style": {"color": "#ffd12e", "weight": 2},
        "note": "Every highway class, including farm tracks (highway=track) and service ways.",
    },
    "waterways": {
        "label": "Waterways and ditches",
        "selectors": ['way["waterway"]'],
        "style": {"color": "#4aa3ff", "weight": 2},
        "note": "Drains, ditches, canals and streams - the lines that decide where water leaves a field.",
    },
    "water": {
        "label": "Water bodies",
        "selectors": ['nwr["natural"="water"]', 'nwr["landuse"="reservoir"]'],
        "style": {"color": "#2f6fb5", "weight": 1},
        "note": "Standing water: ponds, reservoirs, lakes.",
    },
    "landuse": {
        "label": "Land use",
        "selectors": ['nwr["landuse"]'],
        "style": {"color": "#9ee04a", "weight": 1},
        "note": "Includes farmland, meadow, orchard, forest and industrial ground - the field's real neighbours.",
    },
    "buildings": {
        "label": "Buildings and yards",
        "selectors": ['way["building"]', 'way["man_made"="storage_tank"]'],
        "style": {"color": "#ff8c2b", "weight": 1},
        "note": "Farm buildings, sheds and tanks - useful for yard and access planning.",
    },
    "barriers": {
        "label": "Hedges and fences",
        "selectors": ['way["barrier"="hedge"]', 'way["barrier"="fence"]'],
        "style": {"color": "#cbff3c", "weight": 1},
        "note": "Mapped hedgerows and fences. Real fields are often unbounded in OSM, so absence here means unmapped, not absent.",
    },
}

DEFAULT_KINDS: Tuple[str, ...] = ("roads", "waterways", "water", "landuse")

# Tags worth carrying into the map popup. Everything else is dropped so a
# response cannot balloon into a full OSM tag dump.
_KEEP_TAGS = (
    "name", "highway", "waterway", "water", "landuse", "natural", "building",
    "barrier", "surface", "tracktype", "width", "agricultural", "crop",
    "seasonal", "intermittent", "usage", "ref", "operator", "access",
)
_MAX_PROPERTY_TAGS = 12
_MAX_TAG_CHARS = 120


# --------------------------------------------------------------------------- #
# cache + rate gate
# --------------------------------------------------------------------------- #
_CACHE: Dict[str, Tuple[float, Any]] = {}
_LOCK = threading.Lock()
_LAST_CALL = 0.0
_TELEMETRY: Dict[str, Any] = {"last_error": None, "last_ok_at": None, "last_provider": None, "calls": 0}


def _cache_key(kind: str, params: Mapping[str, Any]) -> str:
    return f"{kind}:" + json.dumps(params, sort_keys=True, default=str)


def _cache_get(key: str, ttl: float) -> Any | None:
    with _LOCK:
        entry = _CACHE.get(key)
    if not entry:
        return None
    stored_at, value = entry
    if ttl <= 0 or (time.monotonic() - stored_at) > ttl:
        with _LOCK:
            _CACHE.pop(key, None)
        return None
    return value


def _cache_put(key: str, value: Any) -> None:
    with _LOCK:
        _CACHE[key] = (time.monotonic(), value)
        # A geocode cache has no reason to grow without bound in a long-lived
        # process; drop the oldest entries once it gets large.
        if len(_CACHE) > 512:
            oldest = sorted(_CACHE.items(), key=lambda item: item[1][0])[:128]
            for existing, _ in oldest:
                _CACHE.pop(existing, None)


def cache_info() -> Dict[str, Any]:
    """Cache size plus the last provider outcome, for ``/api/geo/status``."""
    with _LOCK:
        entries = len(_CACHE)
    return {"cached_entries": entries, **_TELEMETRY}


def clear_cache() -> int:
    """Empty the provider cache (used by tests and tooling). Returns entries dropped."""
    with _LOCK:
        count = len(_CACHE)
        _CACHE.clear()
    return count


def _throttle(min_interval: float) -> None:
    """Space outbound calls so the configured per-second policy holds.

    The wait happens while holding no other lock, so a slow request cannot block
    an unrelated one for longer than the spacing itself.
    """
    global _LAST_CALL
    if min_interval <= 0:
        return
    with _LOCK:
        wait = min_interval - (time.monotonic() - _LAST_CALL)
        if wait > 0:
            # Reserve the slot up front: the next caller waits behind this one.
            _LAST_CALL += min_interval
        else:
            _LAST_CALL = time.monotonic()
            wait = 0.0
    if wait > 0:
        time.sleep(wait)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def _user_agent(cfg: Mapping[str, Any]) -> str:
    """An identifying User-Agent, as the Nominatim policy requires."""
    agent = str(cfg.get("user_agent") or "VibesLite").strip()
    contact = str(cfg.get("contact") or "").strip()
    if contact and contact not in agent:
        agent = f"{agent} ({contact})"
    return agent


def _fetch_json(url: str, params: Mapping[str, Any], *, provider: str, cfg: Mapping[str, Any]) -> Any:
    """One HTTP GET, returning parsed JSON. Kept as a single seam for tests.

    Tests patch this function so the suite never touches the public OSM
    services; production traffic always goes through here.
    """
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    request = urllib.request.Request(
        f"{url}?{query}",
        headers={
            "User-Agent": _user_agent(cfg),
            "Accept": "application/json",
            # Nominatim also accepts a Referer; a UA plus this header is the
            # documented way for a non-browser client to identify itself.
            "Referer": str(cfg.get("contact") or "https://localhost/"),
        },
    )
    timeout = float(cfg.get("timeout_seconds", 10))
    _TELEMETRY["calls"] = int(_TELEMETRY.get("calls", 0)) + 1
    _TELEMETRY["last_provider"] = provider
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https host
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:200]
        except Exception:  # pragma: no cover - defensive
            detail = ""
        _TELEMETRY["last_error"] = f"{provider} HTTP {exc.code}"
        raise OSMUpstreamError(
            f"{provider} refused the request (HTTP {exc.code}). {detail}".strip(),
            429 if exc.code == 429 else 502,
        ) from exc
    except urllib.error.URLError as exc:
        _TELEMETRY["last_error"] = f"{provider} unreachable: {exc.reason}"
        raise OSMUnavailable(
            f"{provider} is unreachable from this host ({exc.reason}). "
            "Check outbound network access, or point the provider URL at a local mirror."
        ) from exc
    except (TimeoutError, OSError) as exc:
        _TELEMETRY["last_error"] = f"{provider} timed out"
        raise OSMUnavailable(f"{provider} did not answer within {timeout:g}s ({exc}).") from exc

    _TELEMETRY["last_ok_at"] = time.time()
    _TELEMETRY["last_error"] = None
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise OSMUnavailable(f"{provider} returned a response that is not JSON.") from exc


# Upstream 5xx and gateway timeouts happen on the shared Overpass instance. A
# single spaced retry turns a blank map into a drawn one; a 429 is never
# retried, because that is the provider telling us to slow down, and retrying
# would be exactly the wrong response.
_RETRY_DELAY_SECONDS = 1.5
_TRANSIENT_STATUSES = frozenset({500, 502, 503, 504})


def _retry_once(operation: Callable[[], Any], provider: str) -> Any:
    """Run ``operation``, retrying once after a pause if the provider stumbled."""
    try:
        return operation()
    except OSMUpstreamError as exc:
        if exc.status_code not in _TRANSIENT_STATUSES:
            raise
        _TELEMETRY["last_error"] = f"{provider} transient {exc.status_code}; retried once"
        time.sleep(_RETRY_DELAY_SECONDS)
        return operation()


def _require_enabled(cfg: Mapping[str, Any]) -> None:
    if not cfg.get("enabled", True):
        raise OSMDisabled(
            "OpenStreetMap services are disabled in configuration (osm.enabled=false). "
            "Set VIBES_OSM_ENABLED=true to re-enable place search, reverse geocoding and map features."
        )


# --------------------------------------------------------------------------- #
# validation
# --------------------------------------------------------------------------- #
def _validate_lat_lon(lat: Any, lon: Any) -> Tuple[float, float]:
    try:
        latitude = float(lat)
        longitude = float(lon)
    except (TypeError, ValueError) as exc:
        raise OSMError("Latitude and longitude must be numbers (WGS84 decimal degrees).") from exc
    if not math.isfinite(latitude) or not math.isfinite(longitude):
        raise OSMError("Latitude and longitude must be finite numbers.")
    if not -90.0 <= latitude <= 90.0:
        raise OSMError("Latitude must be between -90 and 90.")
    if not -180.0 <= longitude <= 180.0:
        raise OSMError("Longitude must be between -180 and 180.")
    return latitude, longitude


def _clean_query(query: Any) -> str:
    """Trim a search string to something safe to hand upstream."""
    text = " ".join(str(query or "").split())
    if len(text) < 3:
        raise OSMError("Enter at least 3 characters to search (a place, address, postcode or coordinates).")
    if len(text) > 200:
        raise OSMError("Search text is too long (limit 200 characters).")
    if any(ord(char) < 32 for char in text):
        raise OSMError("Search text contains control characters.")
    return text


def _clean_kinds(kinds: Any) -> List[str]:
    if kinds is None:
        return list(DEFAULT_KINDS)
    if isinstance(kinds, str):
        requested = [part.strip() for part in kinds.split(",") if part.strip()]
    else:
        requested = [str(part).strip() for part in kinds if str(part).strip()]
    unknown = [key for key in requested if key not in FEATURE_KINDS]
    if unknown:
        raise OSMError(f"Unknown feature kind(s): {', '.join(sorted(unknown))}. Known: {', '.join(FEATURE_KINDS)}.")
    return requested or list(DEFAULT_KINDS)


def _clamp_radius(radius_m: Any, cfg: Mapping[str, Any]) -> Tuple[float, bool]:
    """Clamp a radius to the configured ceiling. Returns (radius, was_clamped)."""
    maximum = float(cfg.get("max_radius_m", 5000))
    try:
        radius = float(radius_m)
    except (TypeError, ValueError):
        radius = min(1000.0, maximum)
    if radius <= 0:
        radius = min(1000.0, maximum)
    if radius > maximum:
        return maximum, True
    return radius, False


# --------------------------------------------------------------------------- #
# Nominatim — forward / reverse geocoding
# --------------------------------------------------------------------------- #
def _place_from_nominatim(entry: Mapping[str, Any]) -> Dict[str, Any]:
    """Normalise one Nominatim record into the platform's shape."""
    bounding = entry.get("boundingbox") or []
    box = None
    try:
        if len(bounding) == 4:
            south, north, west, east = (float(value) for value in bounding)
            box = [west, south, east, north]
    except (TypeError, ValueError):  # pragma: no cover - defensive
        box = None
    address = entry.get("address") if isinstance(entry.get("address"), Mapping) else {}
    return {
        "display_name": entry.get("display_name") or entry.get("name") or "",
        "name": entry.get("name") or (address or {}).get("village") or (address or {}).get("town") or "",
        "lat": float(entry["lat"]) if entry.get("lat") is not None else None,
        "lon": float(entry["lon"]) if entry.get("lon") is not None else None,
        "category": entry.get("category") or entry.get("class") or "",
        "type": entry.get("type") or "",
        "importance": float(entry["importance"]) if entry.get("importance") is not None else None,
        "place_id": entry.get("place_id"),
        "osm_type": entry.get("osm_type"),
        "osm_id": entry.get("osm_id"),
        "bounds": box,
        "address": {str(key): str(value) for key, value in (address or {}).items()},
    }


def search_places(
    query: str,
    *,
    limit: int | None = None,
    country_codes: str | None = None,
) -> Dict[str, Any]:
    """Forward-geocode free text against Nominatim.

    Not an autocomplete service - the Nominatim policy forbids per-keystroke
    querying, so callers submit a completed search string.
    """
    cfg = osm_config()
    _require_enabled(cfg)
    text = _clean_query(query)
    capped = max(1, min(int(limit or cfg["max_results"]), 20))
    countries = "".join(ch for ch in str(country_codes or "").lower() if ch.isalpha() or ch == ",")[:60] or None

    params = {"q": text, "format": "jsonv2", "limit": capped, "addressdetails": 1, "countrycodes": countries}
    key = _cache_key("search", params)
    cached = _cache_get(key, cfg["cache_seconds"])
    if cached is not None:
        return {**cached, "cached": True}

    _throttle(cfg["min_interval_seconds"])
    payload = _retry_once(
        lambda: _fetch_json(f"{str(cfg['nominatim_url']).rstrip('/')}/search", params, provider="Nominatim", cfg=cfg),
        "Nominatim",
    )
    if not isinstance(payload, list):
        raise OSMUnavailable("Nominatim returned an unexpected payload for a search request.")

    results = [_place_from_nominatim(entry) for entry in payload if isinstance(entry, Mapping)]
    payload_out = {
        "query": text,
        "results": results,
        "count": len(results),
        "provider": "Nominatim (OpenStreetMap)",
        "attribution": ATTRIBUTION,
        "licence": LICENCE,
        "copyright_url": COPYRIGHT_URL,
        "cached": False,
        "note": (
            "Geocoding by Nominatim, the OpenStreetMap search service. Results are "
            "volunteer-mapped and ranked by an importance heuristic, so an exact address "
            "can rank below a better-known nearby place."
        ),
    }
    _cache_put(key, payload_out)
    return payload_out


def reverse_geocode(lat: Any, lon: Any, *, zoom: int | None = None) -> Dict[str, Any]:
    """Name the place at a coordinate (what the map click is asking)."""
    cfg = osm_config()
    _require_enabled(cfg)
    latitude, longitude = _validate_lat_lon(lat, lon)
    level = max(3, min(int(zoom or 18), 18))
    params = {"lat": round(latitude, 7), "lon": round(longitude, 7), "format": "jsonv2", "zoom": level, "addressdetails": 1}
    key = _cache_key("reverse", params)
    cached = _cache_get(key, cfg["cache_seconds"])
    if cached is not None:
        return {**cached, "cached": True}

    _throttle(cfg["min_interval_seconds"])
    payload = _retry_once(
        lambda: _fetch_json(f"{str(cfg['nominatim_url']).rstrip('/')}/reverse", params, provider="Nominatim", cfg=cfg),
        "Nominatim",
    )
    if not isinstance(payload, Mapping) or payload.get("error"):
        message = (payload or {}).get("error") if isinstance(payload, Mapping) else "unexpected payload"
        return {
            "lat": latitude,
            "lon": longitude,
            "zoom": level,
            "place": None,
            "provider": "Nominatim (OpenStreetMap)",
            "attribution": ATTRIBUTION,
            "licence": LICENCE,
            "copyright_url": COPYRIGHT_URL,
            "cached": False,
            "note": f"OpenStreetMap has no named feature at this point ({message}). The coordinate is still valid - it is simply unmapped.",
        }

    place = _place_from_nominatim(payload)
    result = {
        "lat": latitude,
        "lon": longitude,
        "zoom": level,
        "place": place,
        "provider": "Nominatim (OpenStreetMap)",
        "attribution": ATTRIBUTION,
        "licence": LICENCE,
        "copyright_url": COPYRIGHT_URL,
        "cached": False,
        "note": "Place name and address resolved from OpenStreetMap data by Nominatim.",
    }
    _cache_put(key, result)
    return result


# --------------------------------------------------------------------------- #
# Overpass — real map features as GeoJSON
# --------------------------------------------------------------------------- #
def build_overpass_query(lat: float, lon: float, radius_m: float, kinds: Sequence[str], limit: int, timeout: int) -> str:
    """Assemble an Overpass QL query for the requested feature classes."""
    lines: List[str] = [f"[out:json][timeout:{int(timeout)}];", "("]
    for kind in kinds:
        for selector in FEATURE_KINDS[kind]["selectors"]:
            lines.append(f"  {selector}(around:{radius_m:g},{lat:.6f},{lon:.6f});")
    lines.append(");")
    # ``out geom`` returns each element with its coordinates inline, so no
    # second round-trip is needed to resolve node references.
    lines.append(f"out geom {int(limit)};")
    return "\n".join(lines)


def _feature_from_element(element: Mapping[str, Any], kind: str) -> Dict[str, Any] | None:
    """Convert one Overpass element into a GeoJSON feature (or None to skip)."""
    element_type = element.get("type")
    osm_id = element.get("id")
    tags = element.get("tags") if isinstance(element.get("tags"), Mapping) else {}
    properties: Dict[str, Any] = {
        "osm_id": f"{element_type}/{osm_id}",
        "osm_type": element_type,
        "kind": kind,
        "kind_label": FEATURE_KINDS[kind]["label"],
        "label": tags.get("name") or FEATURE_KINDS[kind]["label"],
    }
    kept = [(key, str(tags[key])[:_MAX_TAG_CHARS]) for key in _KEEP_TAGS if tags.get(key) not in (None, "")]
    if tags.get("name") and not any(key == "name" for key, _ in kept):
        kept.insert(0, ("name", str(tags["name"])[:_MAX_TAG_CHARS]))
    properties["tags"] = dict(kept[:_MAX_PROPERTY_TAGS])

    if element_type == "node":
        if element.get("lat") is None or element.get("lon") is None:
            return None
        geometry = {"type": "Point", "coordinates": [float(element["lon"]), float(element["lat"])]}
    elif element_type == "way":
        geometry_points = element.get("geometry")
        if not isinstance(geometry_points, list) or len(geometry_points) < 2:
            return None
        coordinates = [
            [float(point["lon"]), float(point["lat"])]
            for point in geometry_points
            if isinstance(point, Mapping) and point.get("lon") is not None and point.get("lat") is not None
        ]
        if len(coordinates) < 2:
            return None
        closed = coordinates[0] == coordinates[-1] and len(coordinates) >= 4
        geometry = (
            {"type": "Polygon", "coordinates": [coordinates]}
            if closed
            else {"type": "LineString", "coordinates": coordinates}
        )
    else:
        # Relations arrive without a single ring; drawing them from members
        # would misrepresent geometry, so they are reported as skipped instead.
        return None

    return {"type": "Feature", "geometry": geometry, "properties": properties}


def features_near(
    lat: Any,
    lon: Any,
    *,
    radius_m: float | None = None,
    kinds: Any = None,
    limit: int | None = None,
) -> Dict[str, Any]:
    """Real OpenStreetMap features around a point, as a GeoJSON FeatureCollection."""
    cfg = osm_config()
    _require_enabled(cfg)
    latitude, longitude = _validate_lat_lon(lat, lon)
    radius, clamped = _clamp_radius(radius_m, cfg)
    requested = _clean_kinds(kinds)
    capped = max(1, min(int(limit or cfg["max_features"]), 2000))

    query = build_overpass_query(latitude, longitude, radius, requested, capped, int(cfg["timeout_seconds"]))
    key = _cache_key("overpass", {"query": query})
    cached = _cache_get(key, cfg["cache_seconds"])
    if cached is not None:
        return {**cached, "cached": True}

    _throttle(cfg["min_interval_seconds"])
    payload = _retry_once(lambda: _overpass_query(query, cfg), "Overpass API")

    elements = payload.get("elements") if isinstance(payload, Mapping) else None
    if not isinstance(elements, list):
        raise OSMUnavailable("The Overpass API returned an unexpected payload for a feature query.")

    features: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {kind: 0 for kind in requested}
    skipped = 0
    for element in elements:
        if not isinstance(element, Mapping):
            continue
        tags = element.get("tags") if isinstance(element.get("tags"), Mapping) else {}
        # An element can satisfy several selectors; attribute it to the first
        # requested class that matches so counts add up to the feature list.
        matched = next((kind for kind in requested if _element_matches(kind, element, tags)), None)
        if matched is None:
            skipped += 1
            continue
        feature = _feature_from_element(element, matched)
        if feature is None:
            skipped += 1
            continue
        features.append(feature)
        counts[matched] += 1

    # The query already asks Overpass to cap its output, but the cap is enforced
    # here too: an upstream that ignores it must not turn into an unbounded
    # response (and an unbounded SVG for the map to draw).
    truncated = len(features) >= capped
    if len(features) > capped:
        features = features[:capped]
        counts = {kind: 0 for kind in requested}
        for feature in features:
            counts[feature["properties"]["kind"]] += 1
        truncated = True
    result = {
        "center": {"lat": latitude, "lon": longitude},
        "radius_m": radius,
        "radius_clamped": clamped,
        "kinds": requested,
        "kinds_available": [
            {"key": key_name, "label": value["label"], "note": value["note"], "style": value["style"]}
            for key_name, value in FEATURE_KINDS.items()
        ],
        "geojson": {
            "type": "FeatureCollection",
            # The catalogue above is the source of truth for how each class is
            # drawn, so a client never hardcodes a colour.
            "features": features,
        },
        "feature_count": len(features),
        "counts": counts,
        "skipped": skipped,
        "truncated": truncated,
        "provider": "Overpass API (OpenStreetMap)",
        "attribution": ATTRIBUTION,
        "licence": LICENCE,
        "copyright_url": COPYRIGHT_URL,
        "cached": False,
        "note": (
            f"Real OpenStreetMap features within {radius:g} m, queried live from the Overpass API. "
            "OSM is volunteer-mapped: a missing hedge means unmapped, not absent, and field boundaries "
            "in particular are far from complete in most regions."
        ),
    }
    _cache_put(key, result)
    return result


def _overpass_query(query: str, cfg: Mapping[str, Any]) -> Any:
    """POST one Overpass QL query and return the parsed JSON document."""
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    request = urllib.request.Request(
        str(cfg["overpass_url"]),
        data=body,
        headers={
            "User-Agent": _user_agent(cfg),
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )
    _TELEMETRY["calls"] = int(_TELEMETRY.get("calls", 0)) + 1
    _TELEMETRY["last_provider"] = "Overpass API"
    timeout = float(cfg.get("timeout_seconds", 10)) + 5
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed configured host
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        _TELEMETRY["last_error"] = f"Overpass API HTTP {exc.code}"
        raise OSMUpstreamError(
            f"The Overpass API refused the query (HTTP {exc.code}). Large radii and many feature classes "
            "are expensive for a public instance - narrow the request or retry shortly.",
            429 if exc.code == 429 else exc.code,
        ) from exc
    except urllib.error.URLError as exc:
        _TELEMETRY["last_error"] = f"Overpass API unreachable: {exc.reason}"
        raise OSMUnavailable(
            f"The Overpass API is unreachable from this host ({exc.reason}). Map features need outbound network access."
        ) from exc
    except (TimeoutError, OSError) as exc:
        _TELEMETRY["last_error"] = "Overpass API timed out"
        raise OSMUnavailable(f"The Overpass API did not answer within {timeout:g}s ({exc}).") from exc

    _TELEMETRY["last_ok_at"] = time.time()
    _TELEMETRY["last_error"] = None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise OSMUnavailable("The Overpass API returned a response that is not JSON.") from exc


def _element_matches(kind: str, element: Mapping[str, Any], tags: Mapping[str, Any]) -> bool:
    """Whether an element belongs to a requested feature class."""
    if not tags:
        return False
    if kind == "roads":
        return "highway" in tags
    if kind == "waterways":
        return "waterway" in tags
    if kind == "water":
        return tags.get("natural") == "water" or tags.get("landuse") == "reservoir"
    if kind == "landuse":
        return "landuse" in tags
    if kind == "buildings":
        return "building" in tags or tags.get("man_made") == "storage_tank"
    if kind == "barriers":
        return tags.get("barrier") in {"hedge", "fence"}
    return False


# --------------------------------------------------------------------------- #
# posture
# --------------------------------------------------------------------------- #
def status() -> Dict[str, Any]:
    """What the OpenStreetMap integration actually provides, and under what terms."""
    cfg = osm_config()
    info = cache_info()
    last_error = info.get("last_error")
    return {
        "enabled": bool(cfg["enabled"]),
        "providers": [
            {
                "name": "Nominatim",
                "role": "forward and reverse geocoding",
                "url": cfg["nominatim_url"],
                "licence": LICENCE,
                "attribution": ATTRIBUTION,
                "policy": "Maximum 1 request per second and an identifying User-Agent - both enforced here.",
            },
            {
                "name": "Overpass API",
                "role": "map features (roads, water, land use) as GeoJSON",
                "url": cfg["overpass_url"],
                "licence": LICENCE,
                "attribution": ATTRIBUTION,
                "policy": "Shared public instance: queries are radius-capped and cached rather than streamed per pan.",
            },
            {
                "name": "OSM raster tiles",
                "role": "basemaps",
                "hosts": tile_hosts(),
                "licence": LICENCE,
                "attribution": ATTRIBUTION,
                "policy": TILE_SERVER_POLICY,
            },
        ],
        "basemaps": basemaps(),
        "feature_kinds": [
            {"key": key, "label": value["label"], "note": value["note"]} for key, value in FEATURE_KINDS.items()
        ],
        "default_kinds": list(DEFAULT_KINDS),
        "limits": {
            "requests_per_second": round(1.0 / cfg["min_interval_seconds"], 2) if cfg["min_interval_seconds"] else None,
            "cache_seconds": cfg["cache_seconds"],
            "max_results": cfg["max_results"],
            "max_radius_m": cfg["max_radius_m"],
            "max_features": cfg["max_features"],
            "timeout_seconds": cfg["timeout_seconds"],
            "retry_once_on_gateway_errors": True,
            "retry_statuses": sorted(_TRANSIENT_STATUSES),
            "never_retried": [429],
        },
        "reachable": None if info.get("last_ok_at") else False if last_error else None,
        "last_ok_at": info.get("last_ok_at"),
        "last_error": last_error,
        "cached_entries": info["cached_entries"],
        "upstream_calls": info.get("calls", 0),
        "note": (
            "A 5xx from a provider is retried once after a pause; a 429 is never retried, because that is the "
            "provider asking us to slow down. "
            "All OpenStreetMap access is server-side: the browser talks only to this API, which spaces "
            "requests to the public per-second policy, caches replies, and reports the attribution and "
            "licence the map must carry. Data is © OpenStreetMap contributors under ODbL 1.0 - attribution "
            "is a licence condition, not a courtesy."
        ),
    }


def feature_kinds() -> Iterable[str]:
    """The drawable feature classes, for callers that just need the keys."""
    return tuple(FEATURE_KINDS)
