"""Time-series engine.

One observation = one date + one AOI + index statistics (+ health statistics).
Stack several observations of the same field and you get the crop's trajectory:
mean index over time, health trend, change between dates and a growth slope.

Everything is plain NumPy/Pandas maths on statistics - no raster juggling -
so a season of observations is computed instantly. When both rasters of a pair
are available, ``compare_index_rasters`` adds a pixel-level change map on top.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, Iterable, List, Mapping, Sequence

import numpy as np

from config import get_config
from data import DataError

DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y", "%Y%m%d", "%Y-%m-%dT%H:%M:%S")


def parse_date(value: Any) -> date:
    """Parse a date from a string / date / datetime, raising a clear error."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        raise DataError("Each observation requires a date")
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text[: len(fmt) + 4] if "T" in text else text, fmt).date()
        except ValueError:
            continue
    raise DataError(f"Could not parse date '{value}'. Use ISO format (YYYY-MM-DD).")


# --------------------------------------------------------------------------- #
# observations
# --------------------------------------------------------------------------- #
def build_observation(
    observation_date: Any,
    *,
    index_name: str = "NDVI",
    statistics: Mapping[str, Any] | None = None,
    health: Mapping[str, Any] | None = None,
    aoi: str | None = None,
    dataset: str | None = None,
    result_id: str | None = None,
    source: str = "analysis",
    label: str | None = None,
    extra: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    """Normalise one observation into the time-series schema."""
    parsed = parse_date(observation_date)
    stats = dict(statistics or {})
    health_stats = dict(health or {})
    observation = {
        "date": parsed.isoformat(),
        "day_index": parsed.toordinal(),
        "index": index_name,
        "mean": stats.get("mean"),
        "median": stats.get("median"),
        "min": stats.get("min"),
        "max": stats.get("max"),
        "std": stats.get("std"),
        "valid_pixels": stats.get("valid_pixels"),
        "valid_ratio": stats.get("valid_ratio"),
        "healthy_pct": health_stats.get("healthy_pct"),
        "weak_pct": health_stats.get("weak_pct"),
        "dominant_class": health_stats.get("dominant_class"),
        "health_classes": health_stats.get("classes"),
        "aoi": aoi,
        "dataset": dataset,
        "result_id": result_id,
        "source": source,
        "label": label or parsed.isoformat(),
    }
    if extra:
        observation.update(extra)
    return observation


def build_timeseries(observations: Iterable[Mapping[str, Any]], index_name: str = "NDVI") -> Dict[str, Any]:
    """Sort observations by date and build the series arrays."""
    records: List[Dict[str, Any]] = []
    for item in observations:
        record = dict(item)
        if "day_index" not in record:
            parsed = parse_date(record.get("date"))
            record["date"] = parsed.isoformat()
            record["day_index"] = parsed.toordinal()
        if record.get("mean") is None and record.get("ndvi_mean") is not None:
            record["mean"] = record["ndvi_mean"]
        records.append(record)
    records.sort(key=lambda item: item["day_index"])
    if not records:
        raise DataError("At least one observation is required")

    usable = [record for record in records if record.get("mean") is not None]
    return {
        "index": index_name,
        "observations": records,
        "count": len(records),
        "usable_count": len(usable),
        "dates": [record["date"] for record in records],
        "day_indices": [int(record["day_index"]) for record in records],
        "means": [None if record.get("mean") is None else float(record["mean"]) for record in records],
        "medians": [None if record.get("median") is None else float(record["median"]) for record in records],
        "healthy_pct": [None if record.get("healthy_pct") is None else float(record["healthy_pct"]) for record in records],
        "weak_pct": [None if record.get("weak_pct") is None else float(record["weak_pct"]) for record in records],
        "first_date": records[0]["date"],
        "last_date": records[-1]["date"],
        "span_days": int(records[-1]["day_index"] - records[0]["day_index"]),
    }


# --------------------------------------------------------------------------- #
# trend / change
# --------------------------------------------------------------------------- #
def compute_trend(series: Mapping[str, Any]) -> Dict[str, Any]:
    """Least-squares trend of mean index over time (index units per day)."""
    days = [int(day) for day, value in zip(series["day_indices"], series["means"]) if value is not None]
    values = [float(value) for value in series["means"] if value is not None]
    if len(values) < 2:
        return {
            "slope_per_day": None,
            "slope_per_30_days": None,
            "r_squared": None,
            "direction": "insufficient_data",
            "observations_used": len(values),
            "note": "At least two observations with valid statistics are needed for a trend.",
        }
    offsets = np.asarray(days, dtype="float64") - float(days[0])
    y = np.asarray(values, dtype="float64")
    slope, intercept = np.polyfit(offsets, y, 1)
    predicted = slope * offsets + intercept
    residual = float(np.sum((y - predicted) ** 2))
    total = float(np.sum((y - np.mean(y)) ** 2))
    r_squared = 1.0 - residual / total if total > 0 else 1.0
    direction = "increasing" if slope > 0.0015 else "decreasing" if slope < -0.0015 else "stable"
    return {
        "slope_per_day": round(float(slope), 6),
        "slope_per_30_days": round(float(slope) * 30, 4),
        "intercept": round(float(intercept), 4),
        "r_squared": round(float(r_squared), 4),
        "direction": direction,
        "observations_used": len(values),
        "interpretation": _trend_sentence(direction, float(slope)),
    }


def _trend_sentence(direction: str, slope: float) -> str:
    per_month = slope * 30
    if direction == "increasing":
        return f"Canopy vigour is increasing at roughly {per_month:+.3f} index units per 30 days."
    if direction == "decreasing":
        return f"Canopy vigour is decreasing at roughly {per_month:+.3f} index units per 30 days - review irrigation, nutrition and stress."
    return "Canopy vigour is stable over the observed period (change under 0.0015 index units per day)."


def compute_change(series: Mapping[str, Any], change_threshold: float = 0.05) -> Dict[str, Any]:
    """Change between consecutive observations and overall (first to last)."""
    records = [record for record in series["observations"] if record.get("mean") is not None]
    intervals: List[Dict[str, Any]] = []
    for previous, current in zip(records, records[1:]):
        delta = float(current["mean"]) - float(previous["mean"])
        intervals.append(
            {
                "from": previous["date"],
                "to": current["date"],
                "days": int(current["day_index"] - previous["day_index"]),
                "mean_from": round(float(previous["mean"]), 4),
                "mean_to": round(float(current["mean"]), 4),
                "delta": round(delta, 4),
                "change_pct": round(delta / abs(float(previous["mean"])) * 100, 2) if float(previous["mean"]) else None,
                "direction": "increase" if delta > change_threshold else "decrease" if delta < -change_threshold else "stable",
            }
        )
    if len(records) < 2:
        return {
            "intervals": intervals,
            "total_change": None,
            "total_change_pct": None,
            "direction": "insufficient_data",
            "threshold": change_threshold,
        }
    first, last = records[0], records[-1]
    total_delta = float(last["mean"]) - float(first["mean"])
    return {
        "intervals": intervals,
        "first_date": first["date"],
        "last_date": last["date"],
        "first_mean": round(float(first["mean"]), 4),
        "last_mean": round(float(last["mean"]), 4),
        "total_change": round(total_delta, 4),
        "total_change_pct": round(total_delta / abs(float(first["mean"])) * 100, 2) if float(first["mean"]) else None,
        "direction": "increase" if total_delta > change_threshold else "decrease" if total_delta < -change_threshold else "stable",
        "threshold": change_threshold,
        "largest_increase": max(intervals, key=lambda item: item["delta"]) if intervals else None,
        "largest_decrease": min(intervals, key=lambda item: item["delta"]) if intervals else None,
    }


def health_trend(series: Mapping[str, Any]) -> Dict[str, Any]:
    """Healthy-area and weak-area share over the season."""
    healthy = [(record["date"], record["healthy_pct"]) for record in series["observations"] if record.get("healthy_pct") is not None]
    weak = [(record["date"], record["weak_pct"]) for record in series["observations"] if record.get("weak_pct") is not None]
    payload: Dict[str, Any] = {"healthy_series": healthy, "weak_series": weak}
    if len(healthy) >= 2:
        delta = float(healthy[-1][1]) - float(healthy[0][1])
        payload["healthy_change_pp"] = round(delta, 3)
        payload["healthy_direction"] = "improving" if delta > 1.0 else "declining" if delta < -1.0 else "stable"
    else:
        payload["healthy_change_pp"] = None
        payload["healthy_direction"] = "insufficient_data"
    if len(weak) >= 2:
        delta = float(weak[-1][1]) - float(weak[0][1])
        payload["weak_change_pp"] = round(delta, 3)
        payload["weak_direction"] = "increasing" if delta > 1.0 else "decreasing" if delta < -1.0 else "stable"
    else:
        payload["weak_change_pp"] = None
        payload["weak_direction"] = "insufficient_data"
    return payload


def analyze_timeseries(observations: Iterable[Mapping[str, Any]], index_name: str = "NDVI", change_threshold: float = 0.05) -> Dict[str, Any]:
    """Full time-series analysis payload: series, trend, change and health trend."""
    minimum = int(get_config().get("timeseries", {}).get("min_observations", 2))
    series = build_timeseries(observations, index_name=index_name)
    trend = compute_trend(series)
    change = compute_change(series, change_threshold=change_threshold)
    health = health_trend(series)
    warnings: List[str] = []
    if series["count"] < minimum:
        warnings.append(f"Only {series['count']} observation(s) supplied; at least {minimum} are recommended.")
    if series["usable_count"] < series["count"]:
        warnings.append(f"{series['count'] - series['usable_count']} observation(s) had no usable statistics and were skipped.")
    if series["span_days"] < 7:
        warnings.append("Observations span less than a week; seasonal trends need a longer baseline.")
    largest_gap = max((item["days"] for item in change.get("intervals", [])), default=0)
    if largest_gap > 60:
        warnings.append(f"Largest gap between observations is {largest_gap} days; interpolation between them is not attempted.")

    return {
        "index": index_name,
        "series": series,
        "trend": trend,
        "change": change,
        "health_trend": health,
        "summary": {
            "observation_count": series["count"],
            "first_date": series["first_date"],
            "last_date": series["last_date"],
            "span_days": series["span_days"],
            "mean_first": series["means"][0] if series["means"] else None,
            "mean_last": series["means"][-1] if series["means"] else None,
            "mean_min": min([v for v in series["means"] if v is not None], default=None),
            "mean_max": max([v for v in series["means"] if v is not None], default=None),
            "total_change": change.get("total_change"),
            "total_change_pct": change.get("total_change_pct"),
            "trend_direction": trend["direction"],
            "slope_per_30_days": trend.get("slope_per_30_days"),
            "healthy_change_pp": health.get("healthy_change_pp"),
            "change_threshold": change_threshold,
        },
        "warnings": warnings,
        "interpretation": _interpret_series(series, trend, change, health),
    }


def _interpret_series(series: Mapping[str, Any], trend: Mapping[str, Any], change: Mapping[str, Any], health: Mapping[str, Any]) -> Dict[str, Any]:
    points: List[str] = []
    if series["count"]:
        points.append(
            f"{series['count']} observation(s) between {series['first_date']} and {series['last_date']} "
            f"({series['span_days']} days)."
        )
    if change.get("total_change") is not None:
        points.append(
            f"Mean {series['index']} moved from {change['first_mean']:.3f} to {change['last_mean']:.3f} "
            f"({change['total_change']:+.3f}, {change.get('total_change_pct')}%)."
        )
    if trend.get("interpretation"):
        points.append(trend["interpretation"])
    if health.get("healthy_change_pp") is not None:
        points.append(
            f"Healthy-area share changed by {health['healthy_change_pp']:+.1f} percentage points "
            f"({health['healthy_direction']})."
        )
    return {
        "points": points,
        "disclaimer": (
            "Trends describe canopy greenness between acquisition dates. Differences can also come from "
            "phenology, cloud contamination, view geometry, or irrigation events - not necessarily from crop stress."
        ),
    }


# --------------------------------------------------------------------------- #
# raster-level comparison
# --------------------------------------------------------------------------- #
def compare_index_rasters(before: np.ndarray, after: np.ndarray, valid: np.ndarray | None = None) -> Dict[str, Any]:
    """Pixel-level change between two index rasters (change detection)."""
    from analysis import ndvi_change

    return ndvi_change(before, after, valid=valid)


# --------------------------------------------------------------------------- #
# CSV ingestion (field-level history, or weather joined later)
# --------------------------------------------------------------------------- #
def observations_from_csv(path: str, index_name: str = "NDVI", date_column: str = "date", value_column: str = "ndvi_mean") -> Dict[str, Any]:
    """Build observations from a CSV of per-date field statistics."""
    import pandas as pd

    frame = pd.read_csv(path)
    if date_column not in frame.columns:
        raise DataError(f"CSV has no '{date_column}' column. Found: {list(frame.columns)}")
    if value_column not in frame.columns:
        candidates = [column for column in frame.columns if "ndvi" in str(column).lower() or "index" in str(column).lower()]
        if not candidates:
            raise DataError(f"CSV has no '{value_column}' column and no obvious index column. Found: {list(frame.columns)}")
        value_column = candidates[0]

    observations: List[Dict[str, Any]] = []
    group_column = "field" if "field" in frame.columns else None
    for group, subset in (frame.groupby(group_column) if group_column else [("field", frame)]):
        for _, row in subset.iterrows():
            statistics = {
                "mean": float(row[value_column]) if pd.notna(row[value_column]) else None,
                "median": float(row["ndvi_median"]) if "ndvi_median" in frame.columns and pd.notna(row.get("ndvi_median")) else None,
            }
            extra = {
                key: (None if pd.isna(value) else value)
                for key, value in row.items()
                if key not in {date_column, value_column, group_column}
            }
            observations.append(
                build_observation(
                    row[date_column],
                    index_name=index_name,
                    statistics=statistics,
                    label=f"{group} {row[date_column]}",
                    source="csv",
                    dataset=path.split("/")[-1],
                    extra={"group": group, **extra},
                )
            )
    return {"observations": observations, "rows": int(len(frame)), "columns": [str(c) for c in frame.columns], "group_column": group_column}


def series_from_result_records(records: Sequence[Mapping[str, Any]], index_name: str = "NDVI") -> Dict[str, Any]:
    """Build a series from stored NDVI result payloads (no re-processing needed)."""
    observations: List[Dict[str, Any]] = []
    for record in records:
        payload = record.get("payload", {}) if isinstance(record, Mapping) else {}
        statistics = payload.get("statistics") or {}
        health = payload.get("health") or {}
        observation_date = payload.get("observation_date") or record.get("observation_date") or (record.get("created_at") or "")[:10]
        observations.append(
            build_observation(
                observation_date,
                index_name=index_name,
                statistics=statistics,
                health=health,
                dataset=record.get("dataset"),
                result_id=record.get("id"),
                source="stored_result",
            )
        )
    return build_timeseries(observations, index_name=index_name)
