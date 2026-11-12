"""Real weather for Vibes Lite - every date, a forecast, and a second opinion.

Three keyless public services, all reached server-side, none of them filler:

``archive``   ERA5 / ERA5-Land reanalysis through the Open-Meteo archive API.
              This is the "any date" source: 1940 -> today, carrying
              temperature, rain, wind, humidity, radiation, FAO-56 reference
              evapotranspiration and soil moisture in one request.
``forecast``  the Open-Meteo forecast API for live conditions, the days ahead,
              and the handful of recent days a reanalysis archive publishes
              late.
``POWER``     NASA POWER daily agrometeorology (MERRA-2) as an independent
              second opinion, so a number can be challenged rather than merely
              trusted.

Why Windy draws the map and not the numbers
-------------------------------------------
Windy.com was the requested source. It is used - as the map, never as a value.
Its own documentation is what rules it out for the numbers:

* "Point forecast returns exclusively the most recent forecast values. It is
  **not possible to retrieve historical forecasts with past data**."
  (https://api.windy.com/point-forecast/pricing). There is no date parameter at
  all, in any tier, for any model, so "weather for every date" cannot come from
  Windy. Windy staff put it plainly in their forum: "we don't offer any historic
  data at all in our app/API service."
* The free tier advertises that it "Returns randomly shuffled and slightly
  modified data" and is for "Development purpose only, not intended for
  production" - fabricated numbers, which is the one thing this platform must
  never present.
* Paid access is 990 EUR/year, it excludes ECMWF on licensing grounds, and its
  parameter list has no solar radiation, no evapotranspiration and no soil
  moisture: the variables agronomy actually needs.

So every number below is fetched from the reanalysis directly - ERA5/ERA5-Land
is the same Copernicus family Windy's maps render, free, keyless and archived
back to 1940 - and Windy supplies the interactive wind/rain/temperature map in
the console's Geo tab, where it is labelled live-only. Both halves of that
sentence are recorded in :func:`catalogue` (`maps` and `not_used`), so the
division is a stated decision rather than an omission.

Two provider defects are detected, never averaged in
---------------------------------------------------
Both were found by probing the live endpoints, not by reading documentation:

* NASA POWER's ``WD10M`` (wind direction) is out of range across the whole
  record. Real responses returned -5443, -73760 and -96080 degrees for three
  different places and years, while the ``U10M``/``V10M`` components that
  produce a direction were sane. ``WD10M`` is therefore never used to report a
  direction: the direction is derived from the components and the raw value is
  recorded as rejected.
* NASA POWER's ``ALLSKY_SFC_SW_DWN`` came back as its -999 fill value for every
  day of every window tried, so radiation is reported from Open-Meteo and
  POWER's radiation is reported as unavailable rather than as zero.

Nothing is invented
-------------------
A day a provider does not report stays ``null`` and is counted. Fill values are
filtered, never averaged. Every response names the exact endpoint, the model
family, the observation window and the licence, and near-real-time days are
flagged ``provisional`` because a preliminary stream can be revised.
"""
from __future__ import annotations

import json
import math
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from config import weather_config
from data import DataError

# --------------------------------------------------------------------------- #
# errors
# --------------------------------------------------------------------------- #
class WeatherError(DataError):
    """Base class for weather provider problems (maps to HTTP 400)."""

    status_code = 400


class WeatherDisabled(WeatherError):
    """Live weather is switched off in configuration."""

    status_code = 503


class WeatherUnavailable(WeatherError):
    """A provider could not be reached at all."""

    status_code = 503


class WeatherUpstreamError(WeatherError):
    """The provider answered, but rejected or could not satisfy the request."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


# --------------------------------------------------------------------------- #
# providers
# --------------------------------------------------------------------------- #
#: Open-Meteo's archive is free and open, and it redistributes Copernicus
#: reanalysis. Both lines have to travel with the numbers.
METEO_LICENCE = (
    "Open-Meteo open data (CC-BY 4.0); archive data contains modified Copernicus "
    "Climate Change Service information (ERA5 / ERA5-Land)"
)
METEO_ATTRIBUTION = (
    "Weather data by Open-Meteo.com - Contains modified Copernicus Climate Change "
    "Service information"
)
POWER_LICENCE = "NASA POWER open data (free, no key; MERRA-2 based)"
POWER_ATTRIBUTION = "NASA POWER (Prediction Of Worldwide Energy Resources)"

ARCHIVE_MODELS = "ERA5 / ERA5-Land reanalysis (Open-Meteo best-match default)"
FORECAST_MODELS = "Open-Meteo forecast models (best-match blend)"

#: The reanalysis archive begins here; anything earlier is refused by name.
ARCHIVE_START = date(1940, 1, 1)
#: How many days the forecast actually carries values for, counting today.
#: Open-Meteo accepts 16 forecast days, but the last one comes back entirely
#: null (verified: every field) - so 15 is the horizon that is worth promising,
#: and asking for the 16th would only add an empty row.
FORECAST_HORIZON_DAYS = 15
#: How far back the forecast endpoint may be asked to reach (its own ceiling).
FORECAST_PAST_DAYS_MAX = 92
#: NASA POWER's fill sentinel for a day it has not processed.
POWER_FILL_DEFAULT = -999.0

#: Canonical field names and units. One entry per requested variable, so a
#: consumer never has to know which provider a number came from.
UNITS: Dict[str, str] = {
    "temperature_max_c": "degC",
    "temperature_min_c": "degC",
    "temperature_mean_c": "degC",
    "humidity_mean_pct": "%",
    "dew_point_mean_c": "degC",
    "precipitation_mm": "mm",
    "rain_mm": "mm",
    "wind_speed_max_kmh": "km/h",
    "wind_speed_mean_kmh": "km/h",
    "wind_gusts_max_kmh": "km/h",
    "wind_direction_deg": "degrees (direction the wind blows FROM)",
    "shortwave_radiation_mj_m2": "MJ/m2",
    "et0_mm": "mm (FAO-56 reference evapotranspiration)",
    "cloud_cover_pct": "%",
    "pressure_hpa": "hPa",
    "soil_moisture_m3_m3": "m3/m3",
    "soil_temperature_c": "degC",
}

#: Open-Meteo daily variable -> canonical field.
METEO_DAILY_FIELDS: Dict[str, str] = {
    "temperature_2m_max": "temperature_max_c",
    "temperature_2m_min": "temperature_min_c",
    "temperature_2m_mean": "temperature_mean_c",
    "relative_humidity_2m_mean": "humidity_mean_pct",
    "dew_point_2m_mean": "dew_point_mean_c",
    "precipitation_sum": "precipitation_mm",
    "rain_sum": "rain_mm",
    "wind_speed_10m_max": "wind_speed_max_kmh",
    "wind_speed_10m_mean": "wind_speed_mean_kmh",
    "wind_gusts_10m_max": "wind_gusts_max_kmh",
    "wind_direction_10m_dominant": "wind_direction_deg",
    "shortwave_radiation_sum": "shortwave_radiation_mj_m2",
    "et0_fao_evapotranspiration": "et0_mm",
    "cloud_cover_mean": "cloud_cover_pct",
    "pressure_msl_mean": "pressure_hpa",
    "soil_moisture_0_to_7cm_mean": "soil_moisture_m3_m3",
    "soil_temperature_0_to_7cm_mean": "soil_temperature_c",
}

#: The archive endpoint carries every variable above. The forecast endpoint
#: does not: it has no daily mean temperature, no daily mean wind speed and no
#: soil moisture, and asking for them returns nothing. Verified by request.
ARCHIVE_DAILY: Tuple[str, ...] = tuple(METEO_DAILY_FIELDS)
FORECAST_DAILY_UNAVAILABLE: Tuple[str, ...] = (
    "temperature_2m_mean",
    "wind_speed_10m_mean",
    "soil_moisture_0_to_7cm_mean",
)
FORECAST_DAILY: Tuple[str, ...] = tuple(
    key for key in METEO_DAILY_FIELDS if key not in FORECAST_DAILY_UNAVAILABLE
)

#: NASA POWER parameters, all confirmed present in the service's own AG/DAILY
#: catalogue. ``WD10M`` is deliberately absent (see the module docstring);
#: ``U10M``/``V10M`` are requested instead and converted into a direction.
POWER_PARAMS: Tuple[str, ...] = (
    "T2M", "T2M_MAX", "T2M_MIN", "T2MDEW", "RH2M", "WS10M",
    "PRECTOTCORR", "GWETTOP", "CLOUD_AMT", "PS", "U10M", "V10M",
)
POWER_FIELDS: Dict[str, str] = {
    "T2M": "temperature_mean_c",
    "T2M_MAX": "temperature_max_c",
    "T2M_MIN": "temperature_min_c",
    "T2MDEW": "dew_point_mean_c",
    "RH2M": "humidity_mean_pct",
    "PRECTOTCORR": "precipitation_mm",
    "CLOUD_AMT": "cloud_cover_pct",
    "GWETTOP": "soil_wetness_top_index",
}
#: Parameters POWER may name but not actually serve. Reported, not faked.
POWER_REPORTABLE_ABSENT: Tuple[str, ...] = ("ALLSKY_SFC_SW_DWN",)

_LOCK = threading.Lock()
_CACHE: Dict[str, Tuple[float, Any]] = {}
_TELEMETRY: Dict[str, int] = {"calls": 0, "cache_hits": 0, "failures": 0}


def telemetry() -> Dict[str, int]:
    """Provider call counters for the current process."""
    with _LOCK:
        return dict(_TELEMETRY)


def _reset_cache() -> None:
    """Drop cached provider responses (used by tests and tooling)."""
    with _LOCK:
        _CACHE.clear()


def _user_agent(cfg: Mapping[str, Any]) -> str:
    contact = str(cfg.get("contact") or "").strip()
    base = str(cfg.get("user_agent") or "VibesLite/0.1")
    return f"{base} ({contact})" if contact else base


def _http_json(url: str, *, provider: str, cfg: Mapping[str, Any], params: Mapping[str, Any] | None = None) -> Any:
    """One HTTP call to a weather provider, returning parsed JSON.

    Kept as a single seam so tests never touch the public endpoints, and cached
    per full URL for ``cache_seconds`` so a screen that re-reads a field does not
    re-bill the providers.
    """
    query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
    target = f"{url}?{query}" if query else url
    ttl = float(cfg.get("cache_seconds") or 0)
    if ttl > 0:
        with _LOCK:
            hit = _CACHE.get(target)
            if hit and hit[0] > time.time():
                _TELEMETRY["cache_hits"] = int(_TELEMETRY["cache_hits"]) + 1
                return hit[1]
    request = urllib.request.Request(
        target,
        headers={"User-Agent": _user_agent(cfg), "Accept": "application/json"},
    )
    timeout = float(cfg.get("timeout_seconds", 20))
    with _LOCK:
        _TELEMETRY["calls"] = int(_TELEMETRY["calls"]) + 1
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https host
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            payload = json.loads(exc.read().decode("utf-8", "replace"))
            detail = str(payload.get("reason") or payload.get("error") or payload.get("detail") or "")
        except Exception:  # noqa: BLE001 - a non-JSON error body is only cosmetic
            detail = ""
        with _LOCK:
            _TELEMETRY["failures"] = int(_TELEMETRY["failures"]) + 1
        message = f"{provider} rejected the request with HTTP {exc.code}"
        raise WeatherUpstreamError(f"{message}: {detail}" if detail else message, exc.code) from exc
    except urllib.error.URLError as exc:
        with _LOCK:
            _TELEMETRY["failures"] = int(_TELEMETRY["failures"]) + 1
        raise WeatherUnavailable(f"{provider} could not be reached ({exc.reason}).") from exc
    except TimeoutError as exc:  # pragma: no cover - depends on the network
        with _LOCK:
            _TELEMETRY["failures"] = int(_TELEMETRY["failures"]) + 1
        raise WeatherUnavailable(f"{provider} did not answer within {timeout:g}s.") from exc

    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WeatherUpstreamError(f"{provider} returned a body that is not JSON.", 502) from exc
    if not isinstance(body, (dict, list)):
        raise WeatherUpstreamError(f"{provider} returned an unexpected JSON shape.", 502)
    if isinstance(body, dict) and body.get("error"):
        raise WeatherUpstreamError(f"{provider}: {body.get('error')}")
    if ttl > 0:
        with _LOCK:
            _CACHE[target] = (time.time() + ttl, body)
    return body


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def _require_enabled(cfg: Mapping[str, Any]) -> None:
    if not cfg.get("enabled", True):
        raise WeatherDisabled("Live weather is disabled in configuration (weather.enabled).")


def _coords(lat: Any, lon: Any) -> Tuple[float, float]:
    try:
        lat_f, lon_f = float(lat), float(lon)
    except (TypeError, ValueError) as exc:
        raise WeatherError("latitude and longitude must be numbers.") from exc
    if not (math.isfinite(lat_f) and math.isfinite(lon_f)):
        raise WeatherError("latitude and longitude must be finite numbers.")
    if not -90.0 <= lat_f <= 90.0 or not -180.0 <= lon_f <= 180.0:
        raise WeatherError(f"({lat_f}, {lon_f}) is not a valid WGS84 coordinate.")
    # A provider rounds to its own grid; refusing both poles avoids a silently
    # meaningless request rather than an error at the far end.
    if abs(lat_f) > 89.9:
        raise WeatherError("weather is not sampled within 0.1 degrees of the poles.")
    return lat_f, lon_f


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _parse_date(value: Any, field: str) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        raise WeatherError(f"'{field}' is required (YYYY-MM-DD).")
    try:
        return date.fromisoformat(text[:10])
    except ValueError as exc:
        raise WeatherError(f"'{field}' must be an ISO date (YYYY-MM-DD), got '{text}'.") from exc


def _num(value: Any) -> Optional[float]:
    """A reported number, or ``None``. Never invents a value for a gap."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _round(value: Optional[float], digits: int = 2) -> Optional[float]:
    return None if value is None else round(value, digits)


def _mean(values: Iterable[Optional[float]]) -> Optional[float]:
    real = [v for v in values if v is not None]
    return sum(real) / len(real) if real else None


def _sum(values: Iterable[Optional[float]]) -> Optional[float]:
    real = [v for v in values if v is not None]
    return sum(real) if real else None


def _direction_from_components(u: Optional[float], v: Optional[float]) -> Optional[float]:
    """Meteorological direction (the way the wind blows *from*) from u/v.

    NASA POWER's published ``WD10M`` cannot be used (out of range across its
    whole record), but the component winds it serves alongside are sound, and a
    direction is exactly recoverable from them: ``atan2`` of the northward and
    eastward components, rotated to the compass convention.
    """
    if u is None or v is None or (u == 0.0 and v == 0.0):
        return None
    degrees = (270.0 - math.degrees(math.atan2(v, u))) % 360.0
    return round(degrees, 1)


def _blank_day(day: date) -> Dict[str, Any]:
    """A day with nothing known about it. Every field is present and null."""
    row: Dict[str, Any] = {
        "date": day.isoformat(),
        "reported": False,
        "source": None,
        "kind": None,
        "provisional": False,
    }
    row.update({field: None for field in UNITS})
    return row


# --------------------------------------------------------------------------- #
# Open-Meteo (archive + forecast)
# --------------------------------------------------------------------------- #
def _is_transient(exc: WeatherError) -> bool:
    """A failure worth retrying: the provider's own 5xx, a throttle, or a dead connection."""
    if isinstance(exc, WeatherUnavailable):
        return True
    if isinstance(exc, WeatherUpstreamError):
        code = int(getattr(exc, "status_code", 0) or 0)
        return code == 0 or code >= 500 or code == 429
    return False


def _archive_rows(lat: float, lon: float, start: date, end: date) -> List[Dict[str, Any]]:
    """The reanalysis request, retried - because that host is not reliable.

    Measured on a normal working day, four attempts to the archive host gave
    502, 200, 200 and a stall past 60 seconds, while the forecast host of the
    same service answered in under a second every time. A transient failure is
    therefore retried with backoff before any of it is reported as missing.
    """
    cfg = weather_config()
    attempts = max(1, int(cfg.get("retry_attempts", 2)))
    delay = max(0.0, float(cfg.get("retry_delay_seconds", 1.5)))
    last: Optional[WeatherError] = None
    for attempt in range(attempts):
        try:
            body = _http_json(
                str(cfg["archive_url"]),
                provider="Open-Meteo archive",
                cfg=cfg,
                params={
                    "latitude": round(lat, 4),
                    "longitude": round(lon, 4),
                    "start_date": start.isoformat(),
                    "end_date": end.isoformat(),
                    "daily": ",".join(ARCHIVE_DAILY),
                    "timezone": "UTC",
                },
            )
            return _meteo_rows(
                body, ARCHIVE_DAILY, source="open-meteo-archive", kind="reanalysis"
            )
        except WeatherError as exc:
            if not _is_transient(exc):
                raise
            last = exc
            if attempt + 1 < attempts and delay:
                time.sleep(delay * (2 ** attempt))
    raise last if last is not None else WeatherUnavailable(
        "the reanalysis archive could not be reached."
    )


def _fetch_meteo(
    lat: float,
    lon: float,
    start: date,
    end: date,
    *,
    forecast_past_days: int = 0,
    forecast_days: int = 0,
    use_archive: bool = True,
) -> List[Dict[str, Any]]:
    """One Open-Meteo request, normalised to canonical day rows.

    The archive and the forecast endpoints publish different daily variable
    sets, so each is asked for exactly what it serves; that is why a forecast
    row can legitimately carry no daily mean temperature while an archive row
    does.
    """
    cfg = weather_config()
    rows: List[Dict[str, Any]] = []
    if use_archive:
        rows.extend(_archive_rows(lat, lon, start, end))
    if forecast_past_days or forecast_days:
        body = _http_json(
            str(cfg["forecast_url"]),
            provider="Open-Meteo forecast",
            cfg=cfg,
            params={
                "latitude": round(lat, 4),
                "longitude": round(lon, 4),
                "daily": ",".join(FORECAST_DAILY),
                "past_days": max(0, min(FORECAST_PAST_DAYS_MAX, int(forecast_past_days))),
                "forecast_days": max(0, min(FORECAST_HORIZON_DAYS, int(forecast_days))),
                "timezone": "UTC",
            },
        )
        rows.extend(
            _meteo_rows(body, FORECAST_DAILY, source="open-meteo-forecast", kind="forecast")
        )
    if not rows:
        raise WeatherError("no Open-Meteo request was possible for this window.")
    return rows


def _meteo_rows(
    body: Any,
    variables: Sequence[str],
    *,
    source: str,
    kind: str,
) -> List[Dict[str, Any]]:
    """One endpoint's daily block as canonical day rows.

    ``source``/``kind`` are recorded here, from the request that actually
    answered, so provenance can never drift from the number.
    """
    daily = (body or {}).get("daily") if isinstance(body, Mapping) else None
    if not isinstance(daily, Mapping):
        raise WeatherUpstreamError("Open-Meteo returned no 'daily' block.", 502)
    times = daily.get("time") or []
    if not isinstance(times, list):
        raise WeatherUpstreamError("Open-Meteo returned a malformed 'daily.time'.", 502)
    rows: List[Dict[str, Any]] = []
    for index, stamp in enumerate(times):
        try:
            day = date.fromisoformat(str(stamp)[:10])
        except ValueError:
            continue
        row = _blank_day(day)
        row["source"] = source
        row["kind"] = kind
        for key in variables:
            column = daily.get(key)
            if not isinstance(column, list) or index >= len(column):
                continue
            row[METEO_DAILY_FIELDS[key]] = _num(column[index])
        row["reported"] = any(row[field] is not None for field in UNITS)
        rows.append(row)
    return rows


def _daily_series(
    lat: float,
    lon: float,
    start: date,
    end: date,
    cfg: Mapping[str, Any],
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """The day-by-day record for a window, with honest per-day provenance.

    The archive answers first because it is the settled record. Days it has not
    published yet - and any day still ahead - are filled from the forecast
    endpoint instead, and each such day says so. A day is never blended from
    two sources, and a gap is never interpolated.
    """
    warnings: List[str] = []
    today = _today()
    # The horizon counts today as day one, so the last fetchable day is
    # today + 15; beyond that the provider has nothing to give.
    horizon = today + timedelta(days=FORECAST_HORIZON_DAYS - 1)
    if start > horizon:
        raise WeatherError(
            f"the forecast reaches {FORECAST_HORIZON_DAYS} days ahead "
            f"(to {horizon.isoformat()}); {start.isoformat()} is beyond it."
        )

    # The archive is asked only up to *today*: its own parameter range ends
    # there, and it answers a request past that with HTTP 400. Days still ahead
    # can only come from the forecast endpoint.
    archive_end = min(end, today)
    by_day: Dict[str, Dict[str, Any]] = {}
    if start <= archive_end:
        by_day = {
            row["date"]: row
            for row in _fetch_meteo(lat, lon, start, archive_end, use_archive=True)
        }

    # Which days still need a source? Anything the archive has not published,
    # plus every day ahead of it up to the forecast horizon.
    covered_end = min(end, horizon)
    wanted = [
        (start + timedelta(days=offset)).isoformat()
        for offset in range((covered_end - start).days + 1)
    ]
    missing = [day for day in wanted if not (by_day.get(day) or {}).get("reported")]
    if missing:
        earliest = date.fromisoformat(min(missing))
        latest = date.fromisoformat(max(missing))
        back = min(FORECAST_PAST_DAYS_MAX, (today - earliest).days + 1) if earliest <= today else 0
        forward = min(FORECAST_HORIZON_DAYS, (latest - today).days + 1) if latest >= today else 0
        if back or forward:
            window = set(wanted)
            for row in _fetch_meteo(
                lat, lon, start, covered_end,
                forecast_past_days=back, forecast_days=forward, use_archive=False,
            ):
                # The endpoint answers a wider span than was asked for (it
                # starts at the widest past_days it was given); only days in
                # the requested window belong in the record.
                if row["date"] not in window:
                    continue
                existing = by_day.get(row["date"])
                if existing is None or not existing.get("reported"):
                    by_day[row["date"]] = row
            # Only the *past* days are late; days ahead are simply ahead, and
            # each one already says so through its own 'kind'.
            lagging = len([day for day in missing if date.fromisoformat(day) <= today])
            if lagging:
                warnings.append(
                    f"{lagging} day(s) in this window have already happened but the reanalysis "
                    "archive has not published them yet, so they come from the forecast endpoint's "
                    "recent-model record instead."
                )

    if end > horizon:
        warnings.append(
            f"{(end - horizon).days} day(s) after {horizon.isoformat()} lie beyond the "
            f"{FORECAST_HORIZON_DAYS}-day forecast horizon and are reported as missing rather than filled."
        )

    recent = int(cfg.get("recent_days", 14))
    ordered: List[Dict[str, Any]] = []
    for offset in range((end - start).days + 1):
        day = start + timedelta(days=offset)
        row = by_day.get(day.isoformat()) or _blank_day(day)
        if day > today and row.get("source") != "open-meteo-forecast":
            # The archive cannot answer for a day that has not happened.
            row["source"], row["kind"] = "open-meteo-forecast", "forecast"
        # The last few days come from a preliminary stream and can be revised;
        # flagging them is cheaper than pretending they are settled.
        row["provisional"] = day <= today and (today - day).days <= recent
        ordered.append(row)

    unreported = [row["date"] for row in ordered if not row.get("reported")]
    if unreported:
        warnings.append(
            f"{len(unreported)} day(s) are reported by no source ({', '.join(unreported[:4])}"
            f"{', ...' if len(unreported) > 4 else ''}); they stay null rather than being estimated."
        )
    return ordered, [w for w in warnings if w]


# --------------------------------------------------------------------------- #
# public: catalogue
# --------------------------------------------------------------------------- #
def catalogue() -> Dict[str, Any]:
    """What this module can actually fetch, and on whose authority."""
    cfg = weather_config()
    return {
        "enabled": bool(cfg["enabled"]),
        "coverage": {
            "archive_from": ARCHIVE_START.isoformat(),
            "archive_to": "today (a preliminary stream; the most recent days can be revised)",
            "forecast_from": "today",
            "forecast_to": f"today + {FORECAST_HORIZON_DAYS - 1} days",
            "any_date": True,
            "note": (
                "One endpoint answers every request: the archive for any past date back to 1940, "
                "the forecast for today and the days ahead."
            ),
        },
        "providers": [
            {
                "id": "open-meteo-archive",
                "label": "ERA5 / ERA5-Land reanalysis (Open-Meteo archive)",
                "kind": "reanalysis",
                "product": "Hourly reanalysis aggregated to daily, 1940 -> today, ~9-31 km",
                "endpoint": cfg["archive_url"],
                "auth": "none",
                "licence": METEO_LICENCE,
                "attribution": METEO_ATTRIBUTION,
                "fields": sorted(METEO_DAILY_FIELDS.values()),
                "note": (
                    "A reanalysis is a model reconstruction of the past, not a rain gauge. "
                    "It is the right basis for a season's weather; a field measurement is the "
                    "right basis for what fell on one field."
                ),
            },
            {
                "id": "open-meteo-forecast",
                "label": "Open-Meteo forecast + recent analysis",
                "kind": "forecast",
                "product": "Live conditions, 16 days ahead, and the recent days the archive lags on",
                "endpoint": cfg["forecast_url"],
                "auth": "none",
                "licence": METEO_LICENCE,
                "attribution": METEO_ATTRIBUTION,
                "fields": sorted({METEO_DAILY_FIELDS[key] for key in FORECAST_DAILY}),
                "note": (
                    "Supplies the last few days and the days ahead; it has no daily mean "
                    "temperature, no daily mean wind and no soil moisture, so those stay null "
                    "on days this endpoint answers."
                ),
            },
            {
                "id": "nasa-power",
                "label": "NASA POWER daily agrometeorology",
                "kind": "reanalysis",
                "product": "MERRA-2 daily temperature, rain, humidity, wind components, cloud and topsoil wetness",
                "endpoint": cfg["power_url"],
                "auth": "none",
                "licence": POWER_LICENCE,
                "attribution": POWER_ATTRIBUTION,
                "fields": sorted(POWER_FIELDS.values()) + ["wind_direction_deg (derived from U10M/V10M)"],
                "note": (
                    "Independent of ERA5 - a different model family - which is what makes it a "
                    "cross-check rather than a second copy. Its WD10M is out of range across the "
                    "whole record and is rejected; direction is derived from U10M/V10M instead."
                ),
            },
        ],
        # Windy's role, stated precisely: the console embeds Windy's own map for
        # live wind/rain/temperature layers. It is not a data source here and
        # these endpoints never read a number from it.
        "maps": [
            {
                "id": "windy",
                "label": "Windy.com forecast map",
                "role": "visualisation",
                "kind": "forecast-map",
                "archive": False,
                "endpoint": "https://embed.windy.com/embed2.html",
                "attribution": "Weather map by Windy.com",
                "attribution_url": "https://www.windy.com",
                "terms_url": "https://account.windy.com/agreements/windy-terms-of-use",
                "overlays": ["wind", "gust", "rain", "temp", "rh", "clouds", "pressure"],
                "note": (
                    "Live forecast layers only, drawn by Windy for the field's own coordinates. "
                    "Windy holds no archive, so the map can never show a past date: every value "
                    "these endpoints return comes from the reanalysis archive above. Windy's "
                    "terms also require its logo to stay visible and clickable on the embed."
                ),
                "source": "https://api.windy.com/point-forecast/docs",
            }
        ],
        "not_used": [
            {
                "id": "windy-point-forecast",
                "label": "Windy Point Forecast API (as a data source)",
                "reason": (
                    "Windy's API returns forecasts only - 'It is not possible to retrieve "
                    "historical forecasts with past data' - and its free tier returns 'randomly "
                    "shuffled and slightly modified data' for development only. Its paid tier "
                    "(990 EUR/year) excludes ECMWF and has no solar radiation, no "
                    "evapotranspiration and no soil moisture. So Windy draws the map (see "
                    "'maps') while the reanalysis behind that same map - the same physics, free, "
                    "keyless and archived to 1940 - is what answers every number here."
                ),
                "source": "https://api.windy.com/point-forecast/pricing",
            }
        ],
        "units": UNITS,
        "limits": {
            "max_days_per_request": int(cfg["max_days"]),
            "power_max_days": int(cfg["power_max_days"]),
            "cache_seconds": int(cfg["cache_seconds"]),
        },
    }


# --------------------------------------------------------------------------- #
# public: current conditions
# --------------------------------------------------------------------------- #
#: The live block the forecast endpoint serves, mapped to canonical names.
_CURRENT_FIELDS: Dict[str, str] = {
    "temperature_2m": "temperature_c",
    "apparent_temperature": "apparent_temperature_c",
    "relative_humidity_2m": "humidity_pct",
    "dew_point_2m": "dew_point_c",
    "precipitation": "precipitation_mm",
    "et0_fao_evapotranspiration": "et0_mm",
    "wind_speed_10m": "wind_speed_kmh",
    "wind_gusts_10m": "wind_gusts_kmh",
    "wind_direction_10m": "wind_direction_deg",
    "cloud_cover": "cloud_cover_pct",
    "pressure_msl": "pressure_hpa",
    "shortwave_radiation": "shortwave_radiation_w_m2",
    "weather_code": "weather_code",
}


def current(lat: Any, lon: Any) -> Dict[str, Any]:
    """Live conditions at a point, plus today's totals.

    Soil moisture is reported as Open-Meteo's own m3/m3 *and* as a percentage,
    with the provider's fill value (exactly 0) filtered out: real soil is never
    at 0% volumetric water content, so a non-positive reading is a model gap and
    must stay null rather than raise a false bone-dry alert.
    """
    cfg = weather_config()
    _require_enabled(cfg)
    lat_f, lon_f = _coords(lat, lon)
    body = _http_json(
        str(cfg["forecast_url"]),
        provider="Open-Meteo forecast",
        cfg=cfg,
        params={
            "latitude": round(lat_f, 4),
            "longitude": round(lon_f, 4),
            "current": ",".join(_CURRENT_FIELDS) + ",soil_moisture_0_to_1cm,soil_moisture_3_9cm",
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,rain_sum,"
                     "et0_fao_evapotranspiration,shortwave_radiation_sum",
            "past_days": 1,
            "forecast_days": 2,
            "timezone": "UTC",
        },
    )
    live = body.get("current") if isinstance(body, Mapping) else None
    if not isinstance(live, Mapping):
        raise WeatherUpstreamError("Open-Meteo returned no 'current' block.", 502)

    reading: Dict[str, Any] = {
        field: _num(live.get(key)) for key, field in _CURRENT_FIELDS.items()
    }
    reading["soil_moisture_surface_m3_m3"] = _num(live.get("soil_moisture_0_to_1cm"))
    reading["soil_moisture_root_m3_m3"] = _num(live.get("soil_moisture_3_9cm"))
    for key, source in (
        ("soil_moisture_surface_pct", "soil_moisture_surface_m3_m3"),
        ("soil_moisture_root_pct", "soil_moisture_root_m3_m3"),
    ):
        value = reading[source]
        reading[key] = round(value * 100, 1) if value is not None and value > 0 else None

    warnings: List[str] = []
    if reading["soil_moisture_root_m3_m3"] is not None and reading["soil_moisture_root_m3_m3"] <= 0:
        warnings.append(
            "Open-Meteo reported 0 m3/m3 for root-zone soil moisture, which is its fill value "
            "rather than a dry field; it is reported as null."
        )

    today_row = None
    daily = body.get("daily") if isinstance(body, Mapping) else None
    if isinstance(daily, Mapping):
        served = [key for key in daily if key in METEO_DAILY_FIELDS]
        for row in _meteo_rows(
            body, served, source="open-meteo-forecast", kind="forecast"
        ):
            if row["date"] == _today().isoformat():
                today_row = row
    reading["today"] = today_row
    reading["observed_at"] = live.get("time")
    reading["interval_seconds"] = _num(live.get("interval"))
    return {
        "centre": {"lat": lat_f, "lon": lon_f},
        "current": reading,
        "warnings": warnings,
        "provenance": [_provenance(cfg, "open-meteo-forecast")],
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def _provenance(cfg: Mapping[str, Any], provider_id: str) -> Dict[str, Any]:
    """The record a number has to travel with: source, endpoint, licence."""
    if provider_id == "nasa-power":
        return {
            "source": "nasa-power",
            "label": "NASA POWER daily agrometeorology",
            "endpoint": cfg["power_url"],
            "licence": POWER_LICENCE,
            "attribution": POWER_ATTRIBUTION,
        }
    if provider_id == "open-meteo-archive":
        return {
            "source": "open-meteo-archive",
            "label": "ERA5 / ERA5-Land reanalysis (Open-Meteo archive)",
            "endpoint": cfg["archive_url"],
            "model_family": ARCHIVE_MODELS,
            "licence": METEO_LICENCE,
            "attribution": METEO_ATTRIBUTION,
        }
    return {
        "source": "open-meteo-forecast",
        "label": "Open-Meteo forecast",
        "endpoint": cfg["forecast_url"],
        "model_family": FORECAST_MODELS,
        "licence": METEO_LICENCE,
        "attribution": METEO_ATTRIBUTION,
    }


# --------------------------------------------------------------------------- #
# public: any date
# --------------------------------------------------------------------------- #
def daily(
    lat: Any,
    lon: Any,
    start: Any = None,
    end: Any = None,
    *,
    cross_check: bool = False,
) -> Dict[str, Any]:
    """The daily record for any window from 1940 to the forecast horizon.

    ``cross_check`` adds NASA POWER's independent numbers for the same days
    (see :func:`cross_check`), which is the difference between a weather feed
    and a weather feed you can audit.
    """
    cfg = weather_config()
    _require_enabled(cfg)
    lat_f, lon_f = _coords(lat, lon)
    today = _today()
    start_d = _parse_date(start, "start") if start not in (None, "") else today - timedelta(days=6)
    end_d = _parse_date(end, "end") if end not in (None, "") else today
    if start_d < ARCHIVE_START:
        raise WeatherError(
            f"the reanalysis archive starts on {ARCHIVE_START.isoformat()}; "
            f"{start_d.isoformat()} is before it."
        )
    if end_d < start_d:
        raise WeatherError(f"start ({start_d.isoformat()}) is after end ({end_d.isoformat()}).")
    span = (end_d - start_d).days + 1
    if span > int(cfg["max_days"]):
        raise WeatherError(
            f"a single request may span at most {int(cfg['max_days'])} days; {span} were asked for."
        )

    days, warnings = _daily_series(lat_f, lon_f, start_d, end_d, cfg)
    reported = [row for row in days if row.get("reported")]
    # Totals cover the days that have already happened. Folding a forecast day
    # into a rain total would present a prediction as a measurement.
    past = [row for row in reported if row.get("kind") != "forecast"]
    provisional = [row for row in reported if row.get("provisional")]
    if provisional:
        warnings = list(warnings) + [
            f"{len(provisional)} day(s) in this window come from the preliminary stream that fills "
            "the most recent days and can still be revised."
        ]

    out: Dict[str, Any] = {
        "centre": {"lat": lat_f, "lon": lon_f},
        "window": {
            "from": start_d.isoformat(),
            "to": end_d.isoformat(),
            "days": span,
        },
        "days": days,
        "summary": {
            "days_reported": len(reported),
            "days_past": len(past),
            "days_ahead": len(reported) - len(past),
            "days_provisional": len(provisional),
            "days_missing": span - len(reported),
            "rain_sum_mm": _round(_sum(row.get("precipitation_mm") for row in past), 1),
            "et0_sum_mm": _round(_sum(row.get("et0_mm") for row in past), 1),
            "temperature_mean_c": _round(_mean(row.get("temperature_mean_c") for row in past), 2),
            "temperature_max_c": _round(max([row["temperature_max_c"] for row in past if row.get("temperature_max_c") is not None], default=None), 2),
            "temperature_min_c": _round(min([row["temperature_min_c"] for row in past if row.get("temperature_min_c") is not None], default=None), 2),
        },
        "units": UNITS,
        "warnings": warnings,
        "provenance": [
            _provenance(cfg, "open-meteo-archive"),
            _provenance(cfg, "open-meteo-forecast"),
        ],
        "note": (
            "Daily values are a reanalysis of the past (ERA5/ERA5-Land) and the forecast model for "
            "the days ahead, and every day says which it is. The summary totals cover only days "
            "that have already happened - a forecast day is never added to a rain total - and days "
            "from the preliminary stream are counted as provisional because they can be revised."
        ),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    rain, et0 = out["summary"]["rain_sum_mm"], out["summary"]["et0_sum_mm"]
    out["summary"]["water_balance_mm"] = (
        _round(rain - et0, 1) if rain is not None and et0 is not None else None
    )
    if cross_check:
        out["cross_check"] = cross_check_daily(lat_f, lon_f, start_d, end_d)
        out["provenance"].append(_provenance(cfg, "nasa-power"))
        if out["cross_check"].get("warnings"):
            out["warnings"] = list(out["warnings"]) + [
                f"cross-check: {item}" for item in out["cross_check"]["warnings"]
            ]
    return out


def for_dates(lat: Any, lon: Any, dates: Sequence[Any]) -> Dict[str, Any]:
    """Weather on a set of specific dates, one day per date.

    This is the join that makes imagery interpretable: a satellite acquisition
    is a single moment, and whether the field was waterlogged, heat-stressed or
    simply mid-season is a question only the weather on that day can answer.
    """
    cfg = weather_config()
    _require_enabled(cfg)
    lat_f, lon_f = _coords(lat, lon)
    if not dates:
        raise WeatherError("at least one date is required.")
    parsed = [_parse_date(value, f"dates[{index}]") for index, value in enumerate(dates)]
    ordered = sorted(set(parsed))
    if ordered[0] < ARCHIVE_START:
        raise WeatherError(
            f"the reanalysis archive starts on {ARCHIVE_START.isoformat()}; "
            f"{ordered[0].isoformat()} is before it."
        )
    if (ordered[-1] - ordered[0]).days + 1 > int(cfg["max_days"]):
        raise WeatherError(
            f"the requested dates span more than {int(cfg['max_days'])} days; "
            "request them in batches."
        )
    days, warnings = _daily_series(lat_f, lon_f, ordered[0], ordered[-1], cfg)
    index = {row["date"]: row for row in days}
    # A date no provider answered is 'missing', never a day of nulls dressed up
    # as a result: the caller asked for these dates, so it has to be told which
    # ones came back.
    matched = [
        index[d.isoformat()]
        for d in ordered
        if (index.get(d.isoformat()) or {}).get("reported")
    ]
    missing = [d.isoformat() for d in ordered if not (index.get(d.isoformat()) or {}).get("reported")]
    return {
        "centre": {"lat": lat_f, "lon": lon_f},
        "requested": [d.isoformat() for d in parsed],
        "dates": [row["date"] for row in matched],
        "days": matched,
        "missing": missing,
        "units": UNITS,
        "warnings": warnings,
        "provenance": [
            _provenance(cfg, "open-meteo-archive"),
            _provenance(cfg, "open-meteo-forecast"),
        ],
        "note": (
            "Each requested date is matched to its own daily record. A date no provider reports "
            "is listed in 'missing' - never interpolated from its neighbours."
        ),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


# --------------------------------------------------------------------------- #
# public: the second opinion
# --------------------------------------------------------------------------- #
def _power_rows(lat_f: float, lon_f: float, start: date, end: date) -> Dict[str, Any]:
    """NASA POWER daily values for a window, in the same canonical fields.

    Two jobs, one request shape: it is the independent second opinion for a
    cross-check, and it is the fallback that serves a window when the reanalysis
    archive is down. Both need the same mapping, so the mapping lives here.
    """
    cfg = weather_config()
    span = (end - start).days + 1
    if span > int(cfg["power_max_days"]):
        raise WeatherError(
            f"NASA POWER cross-checks are limited to {int(cfg['power_max_days'])} days per request; "
            f"{span} were asked for."
        )
    body = _http_json(
        str(cfg["power_url"]),
        provider="NASA POWER",
        cfg=cfg,
        params={
            "parameters": ",".join(POWER_PARAMS),
            "community": "AG",
            "latitude": round(lat_f, 4),
            "longitude": round(lon_f, 4),
            "start": start.strftime("%Y%m%d"),
            "end": end.strftime("%Y%m%d"),
            "format": "JSON",
            "time-standard": "UTC",
        },
    )
    parameters = (((body or {}).get("properties") or {}).get("parameter")) if isinstance(body, Mapping) else None
    if not isinstance(parameters, Mapping) or not parameters:
        raise WeatherUpstreamError("NASA POWER returned no 'parameter' block.", 502)
    reported_fill = _num((body.get("header") or {}).get("fill_value"))
    fill = POWER_FILL_DEFAULT if reported_fill is None else reported_fill

    def clean(values: Any) -> Dict[str, Optional[float]]:
        if not isinstance(values, Mapping):
            return {}
        out: Dict[str, Optional[float]] = {}
        for stamp, value in values.items():
            number = _num(value)
            if number is None or number <= fill + 1:
                continue
            out[str(stamp)] = number
        return out

    fields: Dict[str, Dict[str, Optional[float]]] = {
        key: clean(parameters.get(key)) for key in POWER_PARAMS
    }
    rejected: List[Dict[str, Any]] = []
    unavailable: List[Dict[str, Any]] = []

    # WD10M is never trusted: the whole record is out of range. If it appears,
    # it is reported as rejected with a sample, so the exclusion is visible.
    raw_direction = parameters.get("WD10M")
    if isinstance(raw_direction, Mapping) and raw_direction:
        samples = [_num(v) for v in raw_direction.values()]
        in_range = [s for s in samples if s is not None and 0.0 <= s <= 360.0]
        if len(in_range) != len([s for s in samples if s is not None]):
            rejected.append(
                {
                    "parameter": "WD10M",
                    "reason": (
                        "NASA POWER's wind direction is out of the 0-360 degree range across its "
                        "record, so it is not used; direction comes from the U10M/V10M components."
                    ),
                    "sample": next((s for s in samples if s is not None), None),
                    "usable_values": len(in_range),
                }
            )
    for key in POWER_REPORTABLE_ABSENT:
        block = parameters.get(key)
        returned = len(clean(block)) if isinstance(block, Mapping) else 0
        if returned == 0:
            unavailable.append(
                {
                    "parameter": key,
                    "reason": (
                        "returned only its fill value for this window, so it carries no "
                        "information to compare against"
                    ),
                }
            )

    days: List[Dict[str, Any]] = []
    for offset in range(span):
        day = (start + timedelta(days=offset)).strftime("%Y%m%d")
        row = _blank_day(date.fromisoformat(f"{day[:4]}-{day[4:6]}-{day[6:]}"))
        row["source"] = "nasa-power"
        row["kind"] = "reanalysis-merra2"
        for key, field in POWER_FIELDS.items():
            row[field] = fields.get(key, {}).get(day)
        wind_ms = fields.get("WS10M", {}).get(day)
        row["wind_speed_mean_kmh"] = round(wind_ms * 3.6, 1) if wind_ms is not None else None
        # Never WD10M: it is out of range across the whole record. The component
        # winds it serves alongside are sound, and a direction is exactly
        # recoverable from them.
        row["wind_direction_deg"] = _direction_from_components(
            fields.get("U10M", {}).get(day), fields.get("V10M", {}).get(day)
        )
        pressure_kpa = fields.get("PS", {}).get(day)
        row["pressure_hpa"] = round(pressure_kpa * 10.0, 1) if pressure_kpa is not None else None
        reported_fields = list(POWER_FIELDS.values()) + ["wind_speed_mean_kmh", "wind_direction_deg", "pressure_hpa"]
        row["reported"] = any(row.get(field) is not None for field in reported_fields)
        days.append(row)

    return {
        "days": days,
        "fill_value": fill,
        "rejected": rejected,
        "unavailable": unavailable,
        "raw_parameter_names": sorted(parameters.keys()),
    }


def cross_check_daily(lat: Any, lon: Any, start: Any, end: Any) -> Dict[str, Any]:
    """Open-Meteo reanalysis vs NASA POWER over the days *both* report.

    The value of this is that the two are different model families (ERA5 vs
    MERRA-2). Days POWER has not processed carry its -999 fill and are excluded
    and counted, never averaged in; the comparison happens only over shared real
    days, and the agreement verdict is stated rather than implied.
    """
    cfg = weather_config()
    _require_enabled(cfg)
    lat_f, lon_f = _coords(lat, lon)
    start_d = _parse_date(start, "start")
    end_d = _parse_date(end, "end")
    if end_d < start_d:
        raise WeatherError(f"start ({start_d.isoformat()}) is after end ({end_d.isoformat()}).")
    if end_d > _today():
        raise WeatherError(
            "a cross-check needs two reports of the same day; "
            f"{end_d.isoformat()} is still ahead, so there is nothing to compare yet."
        )

    primary = _archive_rows(lat_f, lon_f, start_d, end_d)
    primary_by_day = {row["date"]: row for row in primary}
    power = _power_rows(lat_f, lon_f, start_d, end_d)
    power_by_day = {row["date"]: row for row in power["days"]}

    warnings: List[str] = list(
        f"{item['parameter']}: {item['reason']}" for item in power["unavailable"]
    )
    if power["rejected"]:
        sample = power["rejected"][0]
        warnings.append(
            f"{sample['parameter']} rejected (sample {sample['sample']}); "
            "wind direction is derived from the U10M/V10M components instead."
        )

    shared = [
        day for day in sorted(primary_by_day)
        if primary_by_day[day].get("reported") and (power_by_day.get(day) or {}).get("reported")
    ]
    if not shared:
        raise WeatherError(
            "no day in this window is reported by both Open-Meteo and NASA POWER; "
            "NASA POWER marks days it has not processed with its fill value, so try an earlier window."
        )

    def pair(left_field: str, right_field: str) -> List[Tuple[float, float]]:
        """Days where BOTH providers report the field, as (open-meteo, power)."""
        rows: List[Tuple[float, float]] = []
        for key in shared:
            left = primary_by_day[key].get(left_field)
            right = power_by_day[key].get(right_field)
            if left is not None and right is not None:
                rows.append((left, right))
        return rows

    temp_pairs = pair("temperature_mean_c", "temperature_mean_c")
    temp_note = None
    if not temp_pairs:
        temp_note = (
            "no day in this window carries a daily mean temperature from BOTH providers, so "
            "temperature was not compared; the other fields still were"
        )
    rain_pairs = pair("precipitation_mm", "precipitation_mm")
    humidity_pairs = pair("humidity_mean_pct", "humidity_mean_pct")
    wind_pairs = pair("wind_speed_mean_kmh", "wind_speed_mean_kmh")

    def mean_pair(pairs: List[Tuple[float, float]], digits: int = 2) -> Tuple[Optional[float], Optional[float], Optional[float]]:
        if not pairs:
            return None, None, None
        left = _mean([a for a, _ in pairs])
        right = _mean([b for _, b in pairs])
        delta = left - right if left is not None and right is not None else None
        return _round(left, digits), _round(right, digits), _round(delta, digits)

    primary_temp, power_temp, delta_temp = mean_pair(temp_pairs)
    primary_humidity, power_humidity, delta_humidity = mean_pair(humidity_pairs, 1)
    primary_wind, power_wind, delta_wind = mean_pair(wind_pairs, 2)
    # Sums use only the days both providers report, for the same reason the
    # means do: a day only one side saw is not a disagreement.
    primary_rain = _round(sum(a for a, _ in rain_pairs), 2) if rain_pairs else None
    power_rain = _round(sum(b for _, b in rain_pairs), 2) if rain_pairs else None
    delta_rain = (
        _round(primary_rain - power_rain, 2)
        if primary_rain is not None and power_rain is not None
        else None
    )

    verdict = "close"
    if delta_temp is not None and abs(delta_temp) > 3.0:
        verdict = "divergent"
    if delta_rain is not None and abs(delta_rain) > 10.0:
        verdict = "divergent"
    if delta_humidity is not None and abs(delta_humidity) > 15.0:
        verdict = "divergent"

    return {
        "window": {"from": start_d.isoformat(), "to": end_d.isoformat()},
        "days_compared": len(shared),
        "days_requested": (end_d - start_d).days + 1,
        "primary": {
            "source": "open-meteo-archive",
            "product": "ERA5 / ERA5-Land",
            "mean_temperature_c": primary_temp,
            "rain_sum_mm": primary_rain,
            "mean_humidity_pct": primary_humidity,
            "mean_wind_kmh": primary_wind,
        },
        "crosscheck": {
            "source": "nasa-power",
            "product": "MERRA-2",
            "mean_temperature_c": power_temp,
            "rain_sum_mm": power_rain,
            "mean_humidity_pct": power_humidity,
            "mean_wind_kmh": power_wind,
            "soil_wetness_top_index": _round(
                _mean(power_by_day[day].get("soil_wetness_top_index") for day in shared), 3
            ),
        },
        "delta": {
            "mean_temperature_c": delta_temp,
            "rain_sum_mm": delta_rain,
            "mean_humidity_pct": delta_humidity,
            "mean_wind_kmh": delta_wind,
        },
        "agreement": verdict,
        "skipped": {
            "nasa_power_fill_days": len(power_by_day) - len([d for d in power_by_day if power_by_day[d].get("reported")]),
            "open_meteo_missing_days": len(primary_by_day) - len([d for d in primary_by_day if primary_by_day[d].get("reported")]),
            "fill_value": power["fill_value"],
        },
        "rejected": power["rejected"],
        "unavailable": power["unavailable"],
        "warnings": ([temp_note] if temp_note else []) + warnings,
        "days": [
            {
                "date": day,
                "open_meteo": {
                    key: primary_by_day[day].get(key)
                    for key in ("temperature_mean_c", "temperature_max_c", "temperature_min_c",
                                "precipitation_mm", "humidity_mean_pct", "wind_speed_mean_kmh")
                },
                "nasa_power": {
                    key: power_by_day[day].get(key)
                    for key in ("temperature_mean_c", "temperature_max_c", "temperature_min_c",
                                "precipitation_mm", "humidity_mean_pct", "wind_speed_mean_kmh",
                                "soil_wetness_top_index")
                },
            }
            for day in shared
        ],
        "provenance": [_provenance(cfg, "open-meteo-archive"), _provenance(cfg, "nasa-power")],
        "note": (
            "The two sides are different model families (ERA5 vs MERRA-2), so they are expected to "
            "disagree in detail and should agree in pattern. Rain is the hardest field: a gridded "
            "reanalysis is not a rain gauge, and both are quoted as estimates."
        ),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
