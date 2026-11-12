"""Agronomy decision engine.

The engines below turn the platform's remote-sensing products into the decisions
a farm actually makes: when the crop will hit a stage, whether to irrigate and
how much, which parts of a field are management zones, what to apply where, what
yield to plan around, and when disease pressure is building.

Every function here is a pure function of its arguments — no network, no disk,
no globals — so the same code runs from the API, from the notebooks and from
tests with identical results.

**Honesty contract.** Each model reports how much it can be trusted:

* ``thermal_time`` and ``water_balance`` follow published, widely implemented
  methods (GDD with a cut-out ceiling; FAO-56 dual-step ETc with a soil water
  balance). Their coefficients are indicative regional values, and each response
  says so and lists the coefficients used.
* ``management_zones`` and ``variable_rate_prescription`` are unsupervised and
  descriptive: zones are what the pixels say, not a soil survey.
* ``yield_forecast`` is an **empirical** index-integral model. It is not a
  calibrated crop model and must be calibrated on local history before it is
  trusted for a commercial decision. Its response states this in ``caveats``.
* ``soil_carbon_screening`` is an **estimate**, not a measurement and not a
  certified carbon methodology. It carries ``verification`` metadata saying so.
* ``disease_favour ability`` (see ``disease_risk``) is a weather-favourability
  index, **not a diagnosis**. Confirmation requires scouting.

None of these functions invent data: a missing input is an error or an explicit
``insufficient_data`` verdict, never a substituted default.
"""
from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple

import numpy as np

# --------------------------------------------------------------------------- #
# crop coefficient reference table
# --------------------------------------------------------------------------- #
#: Indicative FAO-56 single crop coefficients and stage lengths (days).
#: **These are regional averages from the FAO-56 tables, not local calibration.**
#: Every response that uses them returns the exact values in
#: ``coefficients_used`` so an agronomist can replace them deliberately.
CROP_COEFFICIENTS: Dict[str, Dict[str, Any]] = {
    "maize":   {"kc_ini": 0.30, "kc_mid": 1.20, "kc_end": 0.35, "stages_days": [30, 40, 50, 30], "gdd_base_c": 10.0, "gdd_maturity": 2700},
    "wheat":   {"kc_ini": 0.30, "kc_mid": 1.15, "kc_end": 0.40, "stages_days": [25, 30, 50, 30], "gdd_base_c": 0.0,  "gdd_maturity": 2100},
    "rice":    {"kc_ini": 1.05, "kc_mid": 1.20, "kc_end": 0.90, "stages_days": [30, 30, 60, 30], "gdd_base_c": 10.0, "gdd_maturity": 2400},
    "soybean": {"kc_ini": 0.40, "kc_mid": 1.15, "kc_end": 0.50, "stages_days": [20, 35, 50, 25], "gdd_base_c": 10.0, "gdd_maturity": 2300},
    "potato":  {"kc_ini": 0.50, "kc_mid": 1.15, "kc_end": 0.75, "stages_days": [25, 30, 45, 30], "gdd_base_c": 7.0,  "gdd_maturity": 1800},
    "cotton":  {"kc_ini": 0.35, "kc_mid": 1.18, "kc_end": 0.60, "stages_days": [30, 50, 60, 55], "gdd_base_c": 12.0, "gdd_maturity": 2600},
    "tomato":  {"kc_ini": 0.60, "kc_mid": 1.15, "kc_end": 0.80, "stages_days": [30, 40, 45, 30], "gdd_base_c": 10.0, "gdd_maturity": 1900},
    "barley":  {"kc_ini": 0.30, "kc_mid": 1.15, "kc_end": 0.25, "stages_days": [20, 30, 50, 30], "gdd_base_c": 0.0,  "gdd_maturity": 1900},
    "grape":   {"kc_ini": 0.30, "kc_mid": 0.85, "kc_end": 0.45, "stages_days": [30, 60, 60, 40], "gdd_base_c": 10.0, "gdd_maturity": 1600},
    "generic": {"kc_ini": 0.40, "kc_mid": 1.10, "kc_end": 0.50, "stages_days": [25, 35, 50, 30], "gdd_base_c": 10.0, "gdd_maturity": 2200},
}

STAGE_NAMES = ["initial", "development", "mid_season", "late_season"]

#: Indicative soil water constants (mm of water per metre of soil) by texture.
SOIL_WATER_HOLDING: Dict[str, float] = {
    "sand": 70.0,
    "sandy_loam": 110.0,
    "loam": 160.0,
    "silt_loam": 180.0,
    "clay_loam": 200.0,
    "clay": 220.0,
    "generic": 150.0,
}


def _clean_series(values: Sequence[float] | np.ndarray, name: str, allow_nan: bool = True) -> np.ndarray:
    """Validate and normalise an input series."""
    array = np.asarray(values, dtype="float64").ravel()
    if array.size == 0:
        raise ValueError(f"{name} is empty")
    if not allow_nan and not np.all(np.isfinite(array)):
        raise ValueError(f"{name} contains non-finite values")
    return array


def _require_same_length(**series: np.ndarray) -> int:
    lengths = {name: arr.size for name, arr in series.items()}
    if len(set(lengths.values())) > 1:
        detail = ", ".join(f"{name}={size}" for name, size in lengths.items())
        raise ValueError(f"Input series must have equal length ({detail})")
    return next(iter(lengths.values()))


# --------------------------------------------------------------------------- #
# 1. thermal time / phenology
# --------------------------------------------------------------------------- #
def growing_degree_days(
    tmin: Sequence[float],
    tmax: Sequence[float],
    base_c: float = 10.0,
    upper_c: float | None = 30.0,
    method: str = "average",
) -> Dict[str, Any]:
    """Daily growing degree days with an optional cut-out ceiling.

    Three published conventions are supported because the choice changes the
    accumulated total materially:

    ``average``
        The classic ``(Tmax + Tmin)/2 − Tbase``, clamped at zero. Simple and
        what most extension services quote, but it overestimates on days with a
        large diurnal range.
    ``modified``
        Same as ``average`` but with ``Tmin`` floored at ``Tbase``, which is the
        usual correction for maize in cool climates where Tmin < Tbase routinely.
    ``sine``
        The sine-curve method: integrates the half-sine between Tmin and Tmax
        above Tbase. Most physically defensible of the three.

    When ``upper_c`` is given, temperatures above it are cut to ``upper_c``
    before the calculation (the Baskerville–Emin / corn cut-out convention),
    because development stops rather than accelerating past the optimum.
    """
    if method not in {"average", "modified", "sine"}:
        raise ValueError("method must be 'average', 'modified' or 'sine'")

    lows = _clean_series(tmin, "tmin", allow_nan=False)
    highs = _clean_series(tmax, "tmax", allow_nan=False)
    count = _require_same_length(tmin=lows, tmax=highs)

    # The ceiling applies to both ends of the daily range.
    if upper_c is not None:
        highs = np.minimum(highs, upper_c)
        lows = np.minimum(lows, upper_c)
    # A reversed range is a data error, not a value to guess at.
    swapped = lows > highs
    lows, highs = np.where(swapped, highs, lows), np.where(swapped, lows, highs)

    if method in {"average", "modified"}:
        lows_for_calc = np.maximum(lows, base_c) if method == "modified" else lows
        daily = (highs + lows_for_calc) / 2.0 - base_c
    else:
        # Sine method: closed-form integral of the half-sine above Tbase.
        amplitude = (highs - lows) / 2.0
        mean = (highs + lows) / 2.0

        def _sine_day(t_mean: float, amp: float) -> float:
            if amp <= 1e-9:
                return max(0.0, t_mean - base_c)
            # Entire day below the base.
            if t_mean <= base_c - amp:
                return 0.0
            # Entire day above the base: the integral is the day mean minus base.
            if t_mean >= base_c + amp:
                return t_mean - base_c
            theta = math.asin(max(-1.0, min(1.0, (base_c - t_mean) / amp)))
            return (amp * math.cos(theta) - (base_c - t_mean) * (math.pi / 2 - theta)) / math.pi

        daily = np.array([_sine_day(float(m), float(a)) for m, a in zip(mean, amplitude)], dtype="float64")

    daily = np.maximum(daily, 0.0)
    return {
        "method": method,
        "base_c": float(base_c),
        "upper_c": None if upper_c is None else float(upper_c),
        "daily": [round(float(value), 3) for value in daily],
        "cumulative": [round(float(value), 3) for value in np.cumsum(daily)],
        "total": round(float(daily.sum()), 3),
        "days": count,
        "swapped_ranges": int(np.count_nonzero(swapped)),
        "method_note": {
            "average": "Classic (Tmax+Tmin)/2 - Tbase, clamped at zero.",
            "modified": "As average, with Tmin floored at Tbase (cool-climate correction).",
            "sine": "Sine-curve integration of the half-sine above Tbase (most physical).",
        }[method],
    }


def phenology_from_gdd(
    cumulative_gdd: float,
    crop: str = "generic",
    stage_days: Sequence[float] | None = None,
) -> Dict[str, Any]:
    """Estimate the crop stage from accumulated thermal time.

    ``stage_days`` are converted to heat units using the crop's own daily mean
    requirement, so a caller with local stage dates can override the FAO
    defaults without changing the crop table.
    """
    key = (crop or "generic").strip().lower()
    spec = CROP_COEFFICIENTS.get(key, CROP_COEFFICIENTS["generic"])
    lengths = list(stage_days) if stage_days else list(spec["stages_days"])
    total_days = float(sum(lengths)) or 1.0
    maturity = float(spec["gdd_maturity"])
    # Heat units per stage are proportional to each stage's share of the season.
    stage_heat = [maturity * (length / total_days) for length in lengths]

    accumulated = max(0.0, float(cumulative_gdd))
    boundaries = np.cumsum(stage_heat)
    stage_index = int(np.searchsorted(boundaries, accumulated, side="right"))
    stage_index = min(stage_index, len(STAGE_NAMES) - 1)
    previous = float(boundaries[stage_index - 1]) if stage_index > 0 else 0.0
    span = float(boundaries[stage_index]) - previous or 1.0

    return {
        "crop": key,
        "cumulative_gdd": round(accumulated, 2),
        "maturity_gdd": maturity,
        "stage": STAGE_NAMES[stage_index],
        "stage_index": stage_index,
        "stage_progress_pct": round(min(100.0, max(0.0, (accumulated - previous) / span * 100.0)), 2),
        "season_progress_pct": round(min(100.0, accumulated / maturity * 100.0), 2),
        "stages_gdd": [round(float(value), 1) for value in boundaries],
        "days_to_next_stage_gdd": round(max(0.0, float(boundaries[stage_index]) - accumulated), 1),
        "coefficients_used": {"crop": key, "stage_days": lengths, "maturity_gdd": maturity},
        "caveat": (
            "Thermal-time staging uses indicative FAO stage lengths. Replace stage_days with local "
            "observed dates for a defensible estimate."
        ),
    }


# --------------------------------------------------------------------------- #
# 2. FAO-56 water balance / irrigation
# --------------------------------------------------------------------------- #
def water_balance(
    et0: Sequence[float],
    rainfall: Sequence[float],
    crop: str = "generic",
    soil: str = "generic",
    kc: Sequence[float] | float | None = None,
    root_depth_m: float = 1.0,
    initial_depletion_mm: float = 0.0,
    depletion_trigger_pct: float = 55.0,
    irrigation_efficiency: float = 0.75,
    rainfall_effectiveness: float = 0.8,
    min_rain_mm: float = 4.0,
) -> Dict[str, Any]:
    """FAO-56 single-coefficient soil water balance with an irrigation schedule.

    Steps:

    1. ``ETc = Kc × ET0``
    2. effective rainfall: a small shower (< ``min_rain_mm``) is treated as
       unavailable, the remainder at ``rainfall_effectiveness`` — the simple
       rule used when only daily totals are available. State it, because a
       USDA/SCS or FAO monthly method gives a different answer.
    3. ``TAW = 1000 × (θfc − θwp) × Zr`` from the indicative table
    4. depletion ``Dr`` updated daily, capped at TAW
    5. water-stress coefficient ``Ks`` from ``RAW = p × TAW``
    6. net irrigation returns the root zone to field capacity when depletion
       passes the trigger, gross = net / ``irrigation_efficiency``
    """
    rain = _clean_series(rainfall, "rainfall", allow_nan=False)
    eto = _clean_series(et0, "et0", allow_nan=False)
    days = _require_same_length(et0=eto, rainfall=rain)

    spec = CROP_COEFFICIENTS.get((crop or "generic").strip().lower(), CROP_COEFFICIENTS["generic"])
    if kc is None:
        # Mid-season Kc is the conservative single value when only ET0 is known;
        # passing a per-day Kc series is the accurate route.
        kc_series = np.full(days, spec["kc_mid"], dtype="float64")
        kc_source = f"crop default (mid-season Kc={spec['kc_mid']})"
    elif np.isscalar(kc):
        kc_series = np.full(days, float(kc), dtype="float64")
        kc_source = f"explicit constant Kc={float(kc)}"
    else:
        kc_series = _clean_series(kc, "kc", allow_nan=False)
        if kc_series.size != days:
            raise ValueError(f"kc has {kc_series.size} values but ET0 has {days}")
        kc_source = "explicit per-day Kc series"
    kc_series = np.maximum(kc_series, 0.0)

    per_metre = SOIL_WATER_HOLDING.get((soil or "generic").strip().lower(), SOIL_WATER_HOLDING["generic"])
    taw = max(1.0, per_metre * max(0.05, float(root_depth_m)))
    raw = taw * max(0.0, min(1.0, float(depletion_trigger_pct) / 100.0))

    etc = kc_series * eto
    effective_rain = np.where(rain >= min_rain_mm, rain * rainfall_effectiveness, 0.0)

    depletion = max(0.0, float(initial_depletion_mm))
    daily: List[Dict[str, Any]] = []
    events: List[Dict[str, Any]] = []
    for index in range(days):
        depletion = depletion + float(etc[index]) - float(effective_rain[index])
        # Rain cannot make depletion negative; surplus is deep percolation.
        percolation = max(0.0, -depletion)
        depletion = min(taw, max(0.0, depletion))

        stress = 1.0
        if depletion > raw:
            stress = max(0.0, (taw - depletion) / max(1e-6, taw - raw))

        irrigation_mm = 0.0
        if depletion >= raw:
            net = depletion
            irrigation_mm = round(net / max(0.05, float(irrigation_efficiency)), 2)
            events.append({"day_index": index, "net_mm": round(net, 2), "gross_mm": irrigation_mm})
            depletion = 0.0

        daily.append(
            {
                "day_index": index,
                "etc_mm": round(float(etc[index]), 2),
                "effective_rain_mm": round(float(effective_rain[index]), 2),
                "depletion_mm": round(depletion, 2),
                "deficit_pct": round(depletion / taw * 100.0, 1),
                "ks": round(float(stress), 3),
                "irrigation_mm": irrigation_mm,
                "percolation_mm": round(percolation, 2),
            }
        )

    stress_days = sum(1 for row in daily if row["ks"] < 0.999)
    total_irrigation = round(sum(event["gross_mm"] for event in events), 2)
    total_etc = round(float(etc.sum()), 2)

    return {
        "method": "FAO-56 single crop coefficient (Kc), daily soil water balance",
        "crop": (crop or "generic").strip().lower(),
        "soil": (soil or "generic").strip().lower(),
        "days": days,
        "taw_mm": round(taw, 1),
        "raw_mm": round(raw, 1),
        "root_depth_m": float(root_depth_m),
        "kc_source": kc_source,
        "etc_total_mm": total_etc,
        "effective_rain_total_mm": round(float(effective_rain.sum()), 2),
        "rainfall_total_mm": round(float(rain.sum()), 2),
        "irrigation_total_mm": total_irrigation,
        "irrigation_events": events,
        "event_count": len(events),
        "stress_days": stress_days,
        "stress_days_pct": round(stress_days / days * 100.0, 1),
        "daily": daily,
        "verdict": _irrigation_verdict(total_irrigation, stress_days, days),
        "coefficients_used": {
            "crop_mid_kc": spec["kc_mid"],
            "soil_water_per_metre_mm": per_metre,
            "depletion_trigger_pct": float(depletion_trigger_pct),
            "irrigation_efficiency": float(irrigation_efficiency),
            "rainfall_effectiveness": float(rainfall_effectiveness),
            "min_rain_mm": float(min_rain_mm),
        },
        "caveats": [
            "FAO-56 crop coefficients are regional averages — replace them with local values before acting.",
            "The daily rainfall-effectiveness rule is a simplification; a USDA/SCS or FAO monthly method differs.",
            "A balance model describes the root zone, not the plant. Confirm with a soil probe where one is installed.",
        ],
    }


def _irrigation_verdict(total_irrigation_mm: float, stress_days: int, days: int) -> str:
    if days == 0:
        return "insufficient data"
    share = stress_days / days
    if share >= 0.35:
        return "chronic deficit — the schedule does not keep up with demand"
    if share >= 0.15:
        return "intermittent stress — tighten the trigger interval"
    if total_irrigation_mm <= 0:
        return "no irrigation required over this window"
    return "schedule is keeping pace with demand"


# --------------------------------------------------------------------------- #
# 3. management zones (unsupervised)
# --------------------------------------------------------------------------- #
def _kmeans(matrix: np.ndarray, k: int, iterations: int = 40, seed: int = 42) -> Tuple[np.ndarray, np.ndarray]:
    """Deterministic k-means++ with a fixed seed, numpy only."""
    rng = np.random.default_rng(seed)
    n = matrix.shape[0]
    k = max(1, min(k, n))

    # k-means++ seeding.
    centres = np.empty((k, matrix.shape[1]), dtype="float64")
    centres[0] = matrix[rng.integers(n)]
    closest = np.sum((matrix - centres[0]) ** 2, axis=1)
    for index in range(1, k):
        total = float(closest.sum())
        if total <= 0:
            centres[index] = matrix[rng.integers(n)]
        else:
            probs = closest / total
            centres[index] = matrix[rng.choice(n, p=probs)]
        closest = np.minimum(closest, np.sum((matrix - centres[index]) ** 2, axis=1))

    labels = np.zeros(n, dtype="int32")
    for _ in range(max(1, iterations)):
        distances = np.stack([np.sum((matrix - centre) ** 2, axis=1) for centre in centres], axis=1)
        new_labels = np.argmin(distances, axis=1).astype("int32")
        if np.array_equal(new_labels, labels):
            labels = new_labels
            break
        labels = new_labels
        for index in range(k):
            member = matrix[labels == index]
            if member.size:
                centres[index] = member.mean(axis=0)
    return labels, centres


def management_zones(
    index_array: np.ndarray,
    mask: np.ndarray | None = None,
    n_zones: int = 3,
    spatial_weight: float = 0.35,
    max_pixels: int = 250_000,
    seed: int = 42,
) -> Dict[str, Any]:
    """Partition a field into contiguous management zones.

    Clusters on ``[index value, y, x]`` where the coordinates are scaled to unit
    range and multiplied by ``spatial_weight``. Without a spatial term the zones
    come out as speckled patches of equal value scattered across the field,
    which is not something a spreader can follow; the spatial term trades a
    little statistical purity for zones that are actually contiguous.

    ``max_pixels`` caps the work on large rasters by striding the grid. Because
    the stride is uniform, the shape of the zones is preserved; only the ridge
    between two nearly-equal zones can shift.
    """
    data = np.asarray(index_array, dtype="float32")
    if data.ndim != 2:
        raise ValueError("index_array must be 2-D")
    valid = np.isfinite(data)
    if mask is not None:
        valid &= np.asarray(mask, dtype=bool)
    if not valid.any():
        return {
            "verdict": "insufficient_data",
            "detail": "No valid pixels in the analysis mask — nothing to cluster.",
            "n_zones": 0,
            "zones": [],
        }

    height, width = data.shape
    stride = max(1, int(math.ceil(math.sqrt(valid.sum() / max(1, max_pixels)))))
    rows = np.arange(0, height, stride)
    cols = np.arange(0, width, stride)
    grid_rows, grid_cols = np.meshgrid(rows, cols, indexing="ij")
    sample_valid = valid[::stride, ::stride]

    values = data[::stride, ::stride][sample_valid]
    row_coords = grid_rows[sample_valid].astype("float64") / max(1, height - 1)
    col_coords = grid_cols[sample_valid].astype("float64") / max(1, width - 1)

    value_min = float(np.min(values))
    value_span = float(np.max(values) - value_min) or 1.0
    features = np.stack(
        [
            (values - value_min) / value_span,
            row_coords * spatial_weight,
            col_coords * spatial_weight,
        ],
        axis=1,
    )

    labels, centres = _kmeans(features, n_zones, seed=seed)

    # Relabel so zone 0 is always the weakest (lowest index) — a stable contract
    # for the UI, and what makes prescriptions reproducible.
    order = np.argsort(centres[:, 0])
    remap = np.zeros(len(order), dtype="int32")
    remap[order] = np.arange(len(order), dtype="int32")
    labels = remap[labels]

    pixel_area_ha = 1.0  # caller rescales; zones report shares as well as raw counts
    zones: List[Dict[str, Any]] = []
    total = int(labels.size)
    for zone in range(len(order)):
        member = labels == zone
        count = int(np.count_nonzero(member))
        if count == 0:
            zones.append({"zone": zone, "name": f"Zone {zone + 1}", "pixels": 0, "share_pct": 0.0, "index_mean": None})
            continue
        zone_values = values[member]
        # Spatial extent of the zone, in normalised field coordinates.
        zr = row_coords[member]
        zc = col_coords[member]
        zones.append(
            {
                "zone": zone,
                "name": f"Zone {zone + 1}" + (" (weakest)" if zone == 0 else " (strongest)" if zone == len(order) - 1 else ""),
                "pixels": count,
                "share_pct": round(count / total * 100.0, 2),
                "index_mean": round(float(zone_values.mean()), 4),
                "index_median": round(float(np.median(zone_values)), 4),
                "index_min": round(float(zone_values.min()), 4),
                "index_max": round(float(zone_values.max()), 4),
                "index_std": round(float(zone_values.std()), 4),
                "centroid_normalised": [round(float(zr.mean()), 4), round(float(zc.mean()), 4)],
                "extent_normalised": [
                    round(float(zr.min()), 4), round(float(zc.min()), 4),
                    round(float(zr.max()), 4), round(float(zc.max()), 4),
                ],
                "pixel_area_ha": pixel_area_ha,
            }
        )

    spread = max(zone["index_mean"] for zone in zones if zone["index_mean"] is not None) - min(
        zone["index_mean"] for zone in zones if zone["index_mean"] is not None
    ) if any(zone["index_mean"] is not None for zone in zones) else 0.0

    # Rebuild a full-resolution zone map by assigning every valid pixel to the
    # nearest cluster centre in the same feature space.
    zone_map = np.full((height, width), -1, dtype="int16")
    full_rows, full_cols = np.nonzero(valid)
    full_values = data[valid]
    full_features = np.stack(
        [
            (full_values - value_min) / value_span,
            full_rows / max(1, height - 1) * spatial_weight,
            full_cols / max(1, width - 1) * spatial_weight,
        ],
        axis=1,
    )
    # Undo the sort so the full-resolution assignment uses the original centres.
    unsorted_centres = centres[order]
    if full_features.size:
        distances = np.stack(
            [np.sum((full_features - centre) ** 2, axis=1) for centre in unsorted_centres], axis=1
        )
        zone_map[full_rows, full_cols] = np.argmin(distances, axis=1).astype("int16")

    return {
        "verdict": "ok",
        "method": "k-means++ (value + weighted spatial position)",
        "n_zones": len(order),
        "pixels_sampled": total,
        "stride": stride,
        "spatial_weight": float(spatial_weight),
        "index_spread": round(float(spread), 4),
        "separation": "strong" if spread >= 0.10 else "weak" if spread >= 0.04 else "marginal",
        "zones": zones,
        "zone_map": zone_map,
        "sample_values": values,
        "sample_labels": labels,
        "sample_shape": (len(rows), len(cols)),
        "caveats": [
            f"Zones come from the index raster alone{f' with a spatial contiguity weight of {spatial_weight}' if spatial_weight else ''}.",
            "Unsupervised zones are descriptive, not a soil survey — ground-truth them before writing a prescription.",
            "Changing the number of zones changes the boundaries; there is no single correct count.",
        ],
    }


# --------------------------------------------------------------------------- #
# 4. variable-rate prescription
# --------------------------------------------------------------------------- #
def variable_rate_prescription(
    zones: Sequence[Mapping[str, Any]],
    product: str,
    base_rate: float,
    target_index: float,
    rate_unit: str = "kg/ha",
    min_rate: float | None = None,
    max_rate: float | None = None,
    response_per_index: float = 1.0,
) -> Dict[str, Any]:
    """Turn management zones into a variable-rate application plan.

    The rate for a zone is ``base_rate × (1 + response_per_index × (target_index
    − zone_index) / target_index)`` — a proportional-deficit rule: a zone below
    target receives more than the base rate, a zone above it receives less.

    ``response_per_index`` is the agronomic judgement in the model (how much
    extra product one index unit of deficit justifies). It is deliberately a
    single explicit number rather than a hidden constant, so it can be set from
    a local trial and audited later.
    """
    usable = [zone for zone in zones if zone.get("index_mean") is not None]
    if not usable:
        return {
            "verdict": "insufficient_data",
            "detail": "No zones with an index mean — nothing to prescribe.",
            "rows": [],
        }
    if base_rate <= 0:
        raise ValueError("base_rate must be positive")
    if target_index == 0:
        raise ValueError("target_index must be non-zero")

    lo = min_rate if min_rate is not None else base_rate * 0.5
    hi = max_rate if max_rate is not None else base_rate * 1.5

    rows: List[Dict[str, Any]] = []
    for zone in usable:
        deficit = target_index - float(zone["index_mean"])
        factor = 1.0 + response_per_index * (deficit / target_index)
        raw = base_rate * factor
        clamped = max(lo, min(hi, raw))
        rows.append(
            {
                "zone": zone.get("zone"),
                "name": zone.get("name"),
                "index_mean": zone["index_mean"],
                "share_pct": zone.get("share_pct"),
                "deficit": round(deficit, 4),
                "rate": round(clamped, 2),
                "rate_unit": rate_unit,
                "unclamped_rate": round(raw, 2),
                "clamped": round(abs(clamped - raw), 4) > 1e-9,
                "direction": "increase" if clamped > base_rate else "reduce" if clamped < base_rate else "hold",
            }
        )

    rows.sort(key=lambda row: row["zone"] if isinstance(row["zone"], int) else 0)
    weighted = sum(row["rate"] * (row["share_pct"] or 0) for row in rows) / max(
        1e-9, sum(row["share_pct"] or 0 for row in rows)
    )
    total_share = sum(row["share_pct"] or 0 for row in rows)
    baseline_total = base_rate * total_share / 100.0
    prescribed_total = sum(row["rate"] * (row["share_pct"] or 0) / 100.0 for row in rows)
    direction = "increase" if prescribed_total > baseline_total else "reduce" if prescribed_total < baseline_total else "hold"

    return {
        "verdict": "ok",
        "product": product,
        "rate_unit": rate_unit,
        "base_rate": float(base_rate),
        "target_index": float(target_index),
        "response_per_index": float(response_per_index),
        "clamp_range": [round(lo, 2), round(hi, 2)],
        "rows": rows,
        "area_weighted_rate": round(weighted, 2),
        "vs_flat_rate": {
            "direction": direction,
            "baseline_total_units": round(baseline_total, 2),
            "prescribed_total_units": round(prescribed_total, 2),
            "delta_units": round(prescribed_total - baseline_total, 2),
            "delta_pct": round((prescribed_total - baseline_total) / baseline_total * 100.0, 2) if baseline_total else None,
        },
        "caveats": [
            "A prescription is only as good as the zone map it is built from — ground-truth the zones first.",
            "Clamping protects against a physically absurd rate; check the 'clamped' flag on each row.",
            "This plan is a recommendation, not an agronomic or legal guarantee. Local nutrient rules apply.",
        ],
    }


# --------------------------------------------------------------------------- #
# 5. soil carbon screening
# --------------------------------------------------------------------------- #
def soil_carbon_screening(
    index_values: Sequence[float],
    crop: str = "generic",
    tillage: str = "unknown",
    cover_crop: bool = False,
    residue_retained: bool = True,
    years_in_practice: float = 3.0,
) -> Dict[str, Any]:
    """Screen a field for soil-carbon trajectory under a management practice.

    **This is not a measurement and not a certified carbon methodology.** Soil
    organic carbon cannot be inferred from a vegetation index; what can be said
    honestly is whether the practice set is likely to *gain*, *hold* or *lose*
    carbon, and roughly how large the annual change could be relative to
    literature ranges for the practice combination.

    The result is reported as a range with the practice combination that
    produced it, plus ``verification`` metadata stating what is missing for an
    MRV-grade number (soil sampling, bulk density, baseline stock).
    """
    values = np.asarray(index_values, dtype="float64").ravel()
    values = values[np.isfinite(values)]
    if values.size == 0:
        return {"verdict": "insufficient_data", "detail": "No valid index values supplied."}

    canopy_integral = float(np.mean(values)) * float(values.size)
    vigour = float(np.clip(np.mean(values), -1.0, 1.0))

    practices: List[Tuple[str, float]] = []
    key = (tillage or "unknown").strip().lower()
    if key in {"no_till", "notill", "no-till", "zero"}:
        practices.append(("no-till", 0.45))
    elif key in {"reduced", "minimum", "min_till", "strip"}:
        practices.append(("reduced tillage", 0.22))
    elif key in {"conventional", "plough", "plow", "conventional_till"}:
        practices.append(("conventional tillage (residue oxidation)", -0.30))
    else:
        practices.append(("tillage practice unknown", -0.08))

    if cover_crop:
        practices.append(("cover crop", 0.35))
    practices.append(("residue retained", 0.25) if residue_retained else ("residue removed/burned", -0.40))
    # A vigorous, long canopy deposits more root and rhizodeposit carbon.
    practices.append((f"canopy vigour {vigour:+.2f}", float(np.clip(vigour * 0.30, -0.15, 0.30))))

    score = sum(weight for _, weight in practices)
    years = max(0.0, float(years_in_practice))
    # Saturation: a practice change does not accrue linearly forever.
    saturation = 1.0 - math.exp(-years / 12.0)
    # Indicative t C/ha/yr for a temperate arable system; the spread is honest
    # uncertainty about soil texture, climate and baseline stock, none of which
    # are inputs to this screen.
    central = score * 1.1 * saturation
    low = central * 0.45
    high = central * 1.75

    trajectory = "gaining" if central > 0.08 else "losing" if central < -0.08 else "roughly stable"
    return {
        "verdict": "screening_estimate",
        "trajectory": trajectory,
        "estimate_t_c_per_ha_per_year": {
            "central": round(central, 3),
            "low": round(low, 3),
            "high": round(high, 3),
        },
        "cumulative_t_c_per_ha": {
            "central": round(central * years, 2),
            "low": round(low * years, 2),
            "high": round(high * years, 2),
        },
        "practice_score": round(score, 3),
        "saturation_factor": round(saturation, 3),
        "years_in_practice": years,
        "canopy_integral": round(canopy_integral, 2),
        "contributions": [{"practice": name, "weight": round(weight, 3)} for name, weight in practices],
        "verification": {
            "grade": "screening — not MRV-grade, not a certified carbon methodology",
            "uses_remote_observations": True,
            "missing_for_verification": [
                "baseline soil organic carbon stock (requires soil sampling)",
                "bulk density by depth",
                "soil texture and clay content",
                "local climate and drainage class",
                "measured residue and root inputs",
            ],
        },
        "caveats": [
            "A vegetation index cannot measure soil carbon. Treat this as a practice screen, not a stock estimate.",
            "The t C/ha/yr range is indicative for temperate arable land and is not a credit instrument.",
            "For a reportable number, use a recognised methodology (e.g. a soil-sampling-based MRV programme).",
        ],
    }


# --------------------------------------------------------------------------- #
# 6. empirical yield forecast
# --------------------------------------------------------------------------- #
def yield_forecast(
    index_series: Sequence[float],
    crop: str = "generic",
    coefficient: float = 0.0,
    intercept: float = 0.0,
    calibration: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    """Empirical yield estimate from a seasonal index integral.

    The model is deliberately trivial and transparent:

        yield = intercept + coefficient × Σ(index observations)

    Nothing is hidden behind a default that looks calibrated when it is not. With
    the shipped defaults (``coefficient=0``) the function returns the *index
    integral* and an explicit ``requires_calibration`` verdict instead of a
    fabricated tonnage. Supply ``coefficient``/``intercept`` from a local
    regression of yield against index integral to obtain a tonnage, and pass
    ``calibration`` (r², n, rmse) so the uncertainty band is honest.
    """
    values = np.asarray(index_series, dtype="float64").ravel()
    values = values[np.isfinite(values)]
    if values.size == 0:
        return {"verdict": "insufficient_data", "detail": "No valid index observations supplied."}

    integral = float(values.sum())
    peak = float(values.max())
    mean = float(values.mean())

    if coefficient == 0.0:
        return {
            "verdict": "requires_calibration",
            "index_integral": round(integral, 4),
            "index_mean": round(mean, 4),
            "index_peak": round(peak, 4),
            "observations": int(values.size),
            "crop": (crop or "generic").strip().lower(),
            "detail": (
                "Fit yield = intercept + coefficient x index_integral on local yield history, then pass both "
                "values. Returning a tonnage from an uncalibrated coefficient would be a fabricated number."
            ),
            "how_to_calibrate": [
                "Collect 3+ seasons of measured yield and the matching seasonal index integral for this field.",
                "Regress yield on the integral; pass the fitted slope as 'coefficient' and intercept as 'intercept'.",
                "Pass the fit statistics in 'calibration' so the uncertainty band reflects the real residual spread.",
                "Re-fit when the cultivar, sensor platform or irrigation regime changes.",
            ],
        }

    estimate = intercept + coefficient * integral
    rmse = None
    r_squared = None
    n = None
    if calibration:
        rmse = calibration.get("rmse")
        r_squared = calibration.get("r_squared")
        n = calibration.get("n")

    # The band widens with the calibration residual; without one, ±25% is stated
    # as an assumption rather than presented as knowledge.
    spread = float(rmse) if isinstance(rmse, (int, float)) and rmse > 0 else abs(estimate) * 0.25
    basis = "calibration rmse" if isinstance(rmse, (int, float)) and rmse > 0 else "assumed 25% of the estimate"

    return {
        "verdict": "ok",
        "crop": (crop or "generic").strip().lower(),
        "index_integral": round(integral, 4),
        "index_mean": round(mean, 4),
        "index_peak": round(peak, 4),
        "observations": int(values.size),
        "estimate": round(estimate, 3),
        "uncertainty": {
            "low": round(estimate - spread, 3),
            "high": round(estimate + spread, 3),
            "basis": basis,
            "r_squared": r_squared,
            "n": n,
        },
        "coefficients_used": {"coefficient": float(coefficient), "intercept": float(intercept)},
        "caveats": [
            "Empirical index-integral model — not a process-based crop simulation.",
            "Any tonnage is only as good as the calibration behind it; an uncalibrated coefficient produces a plausible-looking error.",
            "Does not model lodging, hail, frost, pests or harvest loss.",
        ],
    }


# --------------------------------------------------------------------------- #
# 7. weather-driven disease favour ability
# --------------------------------------------------------------------------- #
#: Transparent rule sets. ``temp_range_c`` is the window favouring infection,
#: ``wet_hours`` the minimum consecutive leaf-wetness hours, ``rh_min`` the
#: humidity threshold that can substitute for measured wetness.
DISEASE_RULES: Dict[str, List[Dict[str, Any]]] = {
    "wheat": [
        {"disease": "Septoria leaf blotch", "pathogen": "Zymoseptoria tritici", "temp_range_c": (15.0, 25.0), "wet_hours": 6, "rh_min": 85.0, "severity": 1.0},
        {"disease": "Yellow (stripe) rust", "pathogen": "Puccinia striiformis", "temp_range_c": (8.0, 18.0), "wet_hours": 4, "rh_min": 80.0, "severity": 1.1},
        {"disease": "Brown rust", "pathogen": "Puccinia triticina", "temp_range_c": (15.0, 25.0), "wet_hours": 4, "rh_min": 80.0, "severity": 0.9},
        {"disease": "Fusarium head blight", "pathogen": "Fusarium spp.", "temp_range_c": (18.0, 30.0), "wet_hours": 12, "rh_min": 85.0, "severity": 1.2},
    ],
    "grape": [
        {"disease": "Downy mildew", "pathogen": "Plasmopara viticola", "temp_range_c": (11.0, 25.0), "wet_hours": 4, "rh_min": 85.0, "severity": 1.2},
        {"disease": "Powdery mildew", "pathogen": "Erysiphe necator", "temp_range_c": (15.0, 28.0), "wet_hours": 2, "rh_min": 70.0, "severity": 1.0},
        {"disease": "Botrytis bunch rot", "pathogen": "Botrytis cinerea", "temp_range_c": (15.0, 25.0), "wet_hours": 8, "rh_min": 90.0, "severity": 1.0},
    ],
    "potato": [
        {"disease": "Late blight", "pathogen": "Phytophthora infestans", "temp_range_c": (10.0, 24.0), "wet_hours": 6, "rh_min": 90.0, "severity": 1.3},
        {"disease": "Early blight", "pathogen": "Alternaria solani", "temp_range_c": (20.0, 30.0), "wet_hours": 8, "rh_min": 80.0, "severity": 0.9},
    ],
    "maize": [
        {"disease": "Northern leaf blight", "pathogen": "Exserohilum turcicum", "temp_range_c": (17.0, 27.0), "wet_hours": 6, "rh_min": 85.0, "severity": 1.0},
        {"disease": "Gray leaf spot", "pathogen": "Cercospora zeae-maydis", "temp_range_c": (22.0, 30.0), "wet_hours": 12, "rh_min": 90.0, "severity": 1.0},
    ],
    "rice": [
        {"disease": "Rice blast", "pathogen": "Magnaporthe oryzae", "temp_range_c": (20.0, 28.0), "wet_hours": 8, "rh_min": 90.0, "severity": 1.2},
        {"disease": "Sheath blight", "pathogen": "Rhizoctonia solani", "temp_range_c": (25.0, 32.0), "wet_hours": 10, "rh_min": 90.0, "severity": 1.0},
    ],
    "tomato": [
        {"disease": "Late blight", "pathogen": "Phytophthora infestans", "temp_range_c": (10.0, 24.0), "wet_hours": 6, "rh_min": 90.0, "severity": 1.3},
        {"disease": "Early blight", "pathogen": "Alternaria solani", "temp_range_c": (20.0, 30.0), "wet_hours": 8, "rh_min": 80.0, "severity": 0.9},
    ],
    "generic": [
        {"disease": "Foliar fungal complex", "pathogen": "mixed", "temp_range_c": (14.0, 26.0), "wet_hours": 8, "rh_min": 85.0, "severity": 0.8},
    ],
}


def disease_risk(
    tmin: Sequence[float],
    tmax: Sequence[float],
    humidity: Sequence[float],
    crop: str = "generic",
    leaf_wetness_hours: Sequence[float] | None = None,
    rainfall: Sequence[float] | None = None,
) -> Dict[str, Any]:
    """Weather-favourability index for the main foliar diseases of a crop.

    A transparent rule set: for each disease, a day is *favourable* when the
    daily mean temperature sits inside the pathogen's window **and** the wetness
    requirement is met — either measured leaf-wetness hours or, as a proxy,
    humidity at or above ``rh_min`` combined with ≥1 mm of rain.

    The output is a **favourability index, not a diagnosis**. It says the weather
    is/was conducive; it cannot see a lesion. That distinction is returned in
    ``caveats`` and in ``verdict`` on purpose.
    """
    lows = _clean_series(tmin, "tmin", allow_nan=False)
    highs = _clean_series(tmax, "tmax", allow_nan=False)
    humid = _clean_series(humidity, "humidity", allow_nan=False)
    days = _require_same_length(tmin=lows, tmax=highs, humidity=humid)

    if leaf_wetness_hours is None:
        wet = None
    else:
        wet = _clean_series(leaf_wetness_hours, "leaf_wetness_hours", allow_nan=False)
        if wet.size != days:
            raise ValueError("leaf_wetness_hours must match the length of tmin")

    if rainfall is None:
        rain = np.zeros(days, dtype="float64")
    else:
        rain = _clean_series(rainfall, "rainfall", allow_nan=False)
        if rain.size != days:
            raise ValueError("rainfall must match the length of tmin")

    mean_temp = (lows + highs) / 2.0
    key = (crop or "generic").strip().lower()
    rules = DISEASE_RULES.get(key, DISEASE_RULES["generic"])

    results: List[Dict[str, Any]] = []
    for rule in rules:
        low_temp, high_temp = rule["temp_range_c"]
        in_temp = (mean_temp >= low_temp) & (mean_temp <= high_temp)
        if wet is not None:
            wet_ok = wet >= rule["wet_hours"]
            wetness_basis = f"measured leaf wetness >= {rule['wet_hours']} h"
        else:
            wet_ok = (humid >= rule["rh_min"]) & (rain >= 1.0)
            wetness_basis = f"humidity >= {rule['rh_min']}% with >= 1 mm rain (leaf-wetness proxy)"

        favourable = np.logical_and(in_temp, wet_ok)
        favourable_days = int(np.count_nonzero(favourable))
        share = favourable_days / days * 100.0

        # Consecutive favourable days matter far more than isolated ones: an
        # infection needs an uninterrupted wet window, so run length drives risk.
        longest, current = 0, 0
        for flag in favourable:
            current = current + 1 if flag else 0
            longest = max(longest, current)

        raw = (share * 0.6 + min(longest, 7) / 7.0 * 100.0 * 0.4) * rule["severity"]
        score = max(0.0, min(100.0, raw))
        level = "high" if score >= 60 else "moderate" if score >= 35 else "low" if score >= 15 else "minimal"

        results.append(
            {
                "disease": rule["disease"],
                "pathogen": rule["pathogen"],
                "favourability_index": round(score, 1),
                "level": level,
                "favourable_days": favourable_days,
                "favourable_share_pct": round(share, 1),
                "longest_favourable_run_days": longest,
                "rule": {
                    "temp_range_c": list(rule["temp_range_c"]),
                    "wetness_basis": wetness_basis,
                    "severity_weight": rule["severity"],
                },
            }
        )

    results.sort(key=lambda row: row["favourability_index"], reverse=True)
    worst = results[0]["level"] if results else "minimal"
    return {
        "verdict": "weather_favourability — not a diagnosis",
        "crop": key,
        "days": days,
        "diseases": results,
        "highest_level": worst,
        "next_action": _disease_action(worst, results[0]["disease"] if results else None),
        "inputs": {
            "mean_temp_c": [round(float(value), 1) for value in mean_temp],
            "humidity_pct": [round(float(value), 1) for value in humid],
            "leaf_wetness_source": "measured" if wet is not None else "humidity+rain proxy",
            "rainfall_used": rainfall is not None,
        },
        "caveats": [
            "A weather-favourability index cannot see a lesion — confirm by scouting before spraying.",
            "Thresholds are indicative published ranges for each pathogen, not local validated models.",
            "Variety resistance, canopy density and previous inoculum all modify real risk and are not inputs here.",
        ],
    }


def _disease_action(level: str, disease: str | None) -> str:
    if disease is None:
        return "No disease rules available for this crop."
    if level == "high":
        return f"High weather favourability for {disease} — scout now and review the protectant interval."
    if level == "moderate":
        return f"Moderate favourability for {disease} — include it in the next scouting round."
    if level == "low":
        return f"Low favourability for {disease} — routine monitoring is sufficient."
    return "No meaningful disease pressure from weather in this window."


# --------------------------------------------------------------------------- #
# catalogue
# --------------------------------------------------------------------------- #
def model_catalogue() -> List[Dict[str, Any]]:
    """Describe every agronomy model for the API and the dashboard."""
    return [
        {
            "id": "thermal_time",
            "label": "Thermal time & phenology",
            "method": "GDD (average / modified / sine) with a cut-out ceiling",
            "outputs": ["daily GDD", "cumulative GDD", "crop stage", "days to next stage"],
            "confidence": "published method, indicative stage lengths",
            "needs": ["daily Tmin/Tmax", "crop"],
        },
        {
            "id": "water_balance",
            "label": "FAO-56 water balance & irrigation",
            "method": "Single Kc ETc with a root-zone depletion balance",
            "outputs": ["ETc", "depletion", "Kc/Ks", "irrigation events", "stress days"],
            "confidence": "published method, indicative coefficients",
            "needs": ["daily ET0", "rainfall", "crop", "soil"],
        },
        {
            "id": "management_zones",
            "label": "Management zones",
            "method": "k-means++ on index + weighted spatial position",
            "outputs": ["zone map", "per-zone statistics", "separation strength"],
            "confidence": "descriptive — ground-truth required",
            "needs": ["vegetation index raster"],
        },
        {
            "id": "variable_rate",
            "label": "Variable-rate prescription",
            "method": "Proportional-deficit rule over management zones",
            "outputs": ["per-zone rate", "area-weighted rate", "delta vs flat rate"],
            "confidence": "advisory — depends on the zone map",
            "needs": ["zones", "product", "base rate", "target index"],
        },
        {
            "id": "soil_carbon",
            "label": "Soil carbon screening",
            "method": "Practice-weighted screening with saturation over time",
            "outputs": ["trajectory", "t C/ha/yr range", "practice contributions"],
            "confidence": "screening only — not MRV-grade",
            "needs": ["index observations", "tillage", "cover crop", "residue practice"],
        },
        {
            "id": "yield_forecast",
            "label": "Yield forecast (empirical)",
            "method": "Linear index-integral regression",
            "outputs": ["estimate", "uncertainty band", "calibration requirement"],
            "confidence": "requires local calibration",
            "needs": ["index series", "fitted coefficient + intercept"],
        },
        {
            "id": "disease_risk",
            "label": "Disease weather favourability",
            "method": "Per-pathogen temperature + wetness rule sets",
            "outputs": ["per-disease index", "favourable days", "longest run"],
            "confidence": "favourability only — not a diagnosis",
            "needs": ["daily Tmin/Tmax", "humidity or leaf wetness"],
        },
    ]
