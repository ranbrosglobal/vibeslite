"""Visualization engine.

Every figure is written to ``outputs/`` as a PNG (no interactive window: this
runs headless in Docker). Two kinds of output are produced:

* **Figures** - publication-style maps and charts with titles, legends and
  colorbars, for reports and the dashboard.
* **Overlays** - transparent RGBA rasters reprojected to EPSG:4326 with exact
  lon/lat bounds, so the browser can place them on a Leaflet map as an
  ``ImageOverlay`` without any client-side GIS.

Colour scales are defined here once; the frontend mirrors the same hex values
in CSS so a legend always matches the raster it describes.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Mapping, Sequence

import matplotlib

matplotlib.use("Agg")  # headless rendering (required inside Docker)

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from matplotlib.colors import BoundaryNorm, LinearSegmentedColormap, ListedColormap  # noqa: E402
from matplotlib.figure import Figure  # noqa: E402
from PIL import Image  # noqa: E402

from analysis import HEALTH_CLASSES  # noqa: E402
from config import get_config, health_thresholds  # noqa: E402
from data import DataError  # noqa: E402

# --------------------------------------------------------------------------- #
# palette
# --------------------------------------------------------------------------- #
#: Continuous NDVI ramp: water/negative -> soil -> straw -> canopy -> dense.
NDVI_STOPS = [
    (-1.0, "#2f4858"),
    (-0.10, "#6b6b56"),
    (0.00, "#9c8b62"),
    (0.20, "#cdbb78"),
    (0.35, "#b6c96a"),
    (0.50, "#8fbe5f"),
    (0.65, "#5da45f"),
    (0.80, "#2e7d47"),
    (1.00, "#14562f"),
]


def _cmap_from_stops(stops: Sequence[tuple[float, str]], name: str = "vibes_ndvi") -> LinearSegmentedColormap:
    low, high = stops[0][0], stops[-1][0]
    positions = [((value - low) / (high - low), colour) for value, colour in stops]
    return LinearSegmentedColormap.from_list(name, positions)


NDVI_CMAP = _cmap_from_stops(NDVI_STOPS, "vibes_ndvi")
CHANGE_CMAP = LinearSegmentedColormap.from_list(
    "vibes_change", [(0.0, "#a33a1f"), (0.5, "#e8e5dc"), (1.0, "#1d6b3c")]
)
HEALTH_COLOURS = [entry["colour"] for entry in HEALTH_CLASSES]
HEALTH_LABELS = [entry["short"] for entry in HEALTH_CLASSES]
HEALTH_CMAP = ListedColormap(HEALTH_COLOURS, name="vibes_health")
BAR_COLOUR = "#1f6f43"
ACCENT = "#0f766e"
INK = "#14231c"
MUTED = "#5d6b63"
GRID = "#e2e0d8"


def figure_style() -> Dict[str, Any]:
    config = get_config().get("visualization", {})
    return {
        "dpi": int(config.get("dpi", 130)),
        "figsize": tuple(config.get("figure_size", [8.5, 7.0])),
    }


def _masked(array: np.ndarray, valid: np.ndarray | None = None) -> np.ma.MaskedArray:
    data = np.asarray(array, dtype="float32")
    mask = ~np.isfinite(data)
    if valid is not None:
        mask |= ~np.asarray(valid, dtype=bool)
    return np.ma.masked_array(data, mask=mask)


def _extent_from_bounds(bounds: Sequence[float] | None) -> list[float] | None:
    if not bounds:
        return None
    left, bottom, right, top = bounds
    return [left, right, bottom, top]


def _save_figure(figure: Figure, path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(target, dpi=figure.dpi, bbox_inches="tight", facecolor="white", pad_inches=0.25)
    plt.close(figure)
    return target


def _caption(ax: Any, text: str) -> None:
    if not text:
        return
    ax.text(0.0, -0.075, text, transform=ax.transAxes, fontsize=7.5, color=MUTED, va="top", ha="left")


def _draw_boundary(ax: Any, aoi_gdf: Any, colour: str = "#ffd60a") -> None:
    if aoi_gdf is None or len(aoi_gdf) == 0:
        return
    aoi_gdf.boundary.plot(ax=ax, edgecolor=colour, linewidth=1.6, zorder=5)


# --------------------------------------------------------------------------- #
# raster overlays for the web map
# --------------------------------------------------------------------------- #
def save_rgba_overlay(
    array: np.ndarray,
    transform: Any,
    crs: Any,
    path: str | Path,
    *,
    cmap: Any = NDVI_CMAP,
    vmin: float = -0.2,
    vmax: float = 1.0,
    valid: np.ndarray | None = None,
    alpha: float = 0.85,
    discrete: bool = False,
    class_colours: Sequence[str] | None = None,
) -> Dict[str, Any]:
    """Write a transparent, georeferenced PNG for Leaflet image overlays."""
    from geospatial import reproject_to_lonlat

    data = np.asarray(array, dtype="float32")
    if data.ndim == 3:
        data = data[..., 0]
    mask = np.isfinite(data)
    if valid is not None:
        mask &= np.asarray(valid, dtype=bool)
    # Keep the overlay light: cap the long edge at 1400 px.
    height, width = data.shape
    scale = min(1.0, 1400.0 / max(height, width))
    out_shape = (max(1, int(height * scale)), max(1, int(width * scale)))
    projected = reproject_to_lonlat(np.where(mask, data, np.nan), transform, crs, out_shape=out_shape)
    projected_mask = np.isfinite(projected["array"])

    if discrete:
        colours = class_colours or HEALTH_COLOURS
        norm = BoundaryNorm(np.arange(-0.5, len(colours) + 0.5), len(colours))
        rgba = matplotlib.colormaps.get_cmap(ListedColormap(colours))(norm(np.nan_to_num(projected["array"], nan=0)))
    else:
        norm = matplotlib.colors.Normalize(vmin=vmin, vmax=vmax)
        rgba = cmap(norm(np.nan_to_num(projected["array"], nan=0)))
    rgba[..., 3] = np.where(projected_mask, alpha, 0.0)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((np.clip(rgba, 0, 1) * 255).astype("uint8"), mode="RGBA").save(target, optimize=True)
    return {
        "path": target,
        "bounds_lonlat": projected["bounds_lonlat"],
        "shape": projected["shape"],
        "pixel_size_degrees": [
            (projected["bounds_lonlat"][2] - projected["bounds_lonlat"][0]) / projected["shape"][1],
            (projected["bounds_lonlat"][3] - projected["bounds_lonlat"][1]) / projected["shape"][0],
        ],
    }


def save_rgb_png(rgb: np.ndarray, path: str | Path) -> Path:
    """Save an RGB composite as a plain PNG (no axes) - used for before/after views."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.asarray(rgb, dtype="uint8")).save(target, optimize=True)
    return target


def save_rgb_overlay(rgb: np.ndarray, transform: Any, crs: Any, path: str | Path, alpha: float = 0.9) -> Dict[str, Any]:
    """True-colour imagery as a georeferenced RGBA PNG for the web map."""
    from geospatial import reproject_to_lonlat

    data = np.asarray(rgb, dtype="uint8")
    if data.ndim == 2:
        data = np.dstack([data] * 3)
    height, width = data.shape[:2]
    scale = min(1.0, 1400.0 / max(height, width))
    out_shape = (max(1, int(height * scale)), max(1, int(width * scale)))
    channels = []
    bounds_lonlat = None
    shape = None
    for channel in range(3):
        projected = reproject_to_lonlat(data[..., channel].astype("float32"), transform, crs, out_shape=out_shape)
        channels.append(projected["array"])
        bounds_lonlat = projected["bounds_lonlat"]
        shape = projected["shape"]
    stacked = np.stack(channels, axis=-1)
    valid = np.isfinite(stacked).all(axis=-1)
    rgba = np.zeros((*stacked.shape[:2], 4), dtype="uint8")
    rgba[..., :3] = np.where(np.isfinite(stacked), stacked, 0).astype("uint8")
    rgba[..., 3] = np.where(valid, int(alpha * 255), 0).astype("uint8")
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(target, optimize=True)
    return {"path": target, "bounds_lonlat": bounds_lonlat, "shape": shape}


# --------------------------------------------------------------------------- #
# index maps
# --------------------------------------------------------------------------- #
def save_index_map(
    array: np.ndarray,
    path: str | Path,
    *,
    transform: Any = None,
    crs: Any = None,
    aoi_gdf: Any = None,
    bounds: Sequence[float] | None = None,
    valid: np.ndarray | None = None,
    index_name: str = "NDVI",
    title: str | None = None,
    boundaries: Sequence[float] | None = None,
    caption: str = "",
    vmin: float = -0.2,
    vmax: float = 1.0,
) -> Path:
    """NDVI-style continuous index map with a legend and optional boundary."""
    style = figure_style()
    figure, ax = plt.subplots(figsize=(8.0, 6.4), dpi=style["dpi"])
    values = _masked(array, valid)
    image = ax.imshow(values, cmap=NDVI_CMAP, vmin=vmin, vmax=vmax, extent=_extent_from_bounds(bounds), interpolation="nearest")
    _draw_boundary(ax, aoi_gdf)
    if boundaries:
        colorbar = figure.colorbar(image, ax=ax, fraction=0.045, pad=0.02)
        for threshold in boundaries:
            colorbar.ax.axhline(threshold, color="#ffffff", linewidth=1.0, alpha=0.7)
        colorbar.set_label(f"{index_name} (class boundaries in white)", fontsize=8.5)
    else:
        colorbar = figure.colorbar(image, ax=ax, fraction=0.045, pad=0.02)
        colorbar.set_label(index_name, fontsize=8.5)
    ax.set_title(title or f"{index_name} map", fontsize=12, color=INK, loc="left")
    if bounds:
        ax.set_xlabel("Easting / lon", fontsize=8, color=MUTED)
        ax.set_ylabel("Northing / lat", fontsize=8, color=MUTED)
    else:
        ax.set_xticks([])
        ax.set_yticks([])
    ax.tick_params(labelsize=7, colors=MUTED)
    _caption(ax, caption or f"{index_name} derived from red and near-infrared bands. Grey = no data.")
    return _save_figure(figure, path)


def save_health_map(
    classes: np.ndarray,
    path: str | Path,
    *,
    aoi_gdf: Any = None,
    bounds: Sequence[float] | None = None,
    title: str | None = None,
    thresholds: Mapping[str, float] | None = None,
    caption: str = "",
    aoi_geometry: Any = None,
) -> Path:
    """Discrete crop-health class map with a legend of the configured classes."""
    style = figure_style()
    limits = health_thresholds() if thresholds is None else dict(thresholds)
    boundaries = [float(limits["very_low"]), float(limits["low"]), float(limits["moderate"]), float(limits["healthy"])]

    figure, ax = plt.subplots(figsize=(8.0, 6.6), dpi=style["dpi"])
    data = np.asarray(classes, dtype="float32")
    data = np.where(data >= 0, data, np.nan)
    norm = BoundaryNorm(np.arange(-0.5, 5.5, 1.0), HEALTH_CMAP.N)
    ax.imshow(np.ma.masked_invalid(data), cmap=HEALTH_CMAP, norm=norm, extent=_extent_from_bounds(bounds), interpolation="nearest")
    _draw_boundary(ax, aoi_gdf)
    ax.set_title(title or "Crop health classes", fontsize=12, color=INK, loc="left")
    ax.set_xticks([])
    ax.set_yticks([])

    handles = [
        matplotlib.patches.Patch(
            facecolor=entry["colour"],
            edgecolor="#ffffff",
            label=f"{entry['short']}  ({_range_label(index, boundaries)})",
        )
        for index, entry in enumerate(HEALTH_CLASSES)
    ]
    legend = ax.legend(
        handles=handles,
        loc="upper left",
        bbox_to_anchor=(1.02, 1.0),
        fontsize=8,
        frameon=False,
        title="NDVI class",
    )
    legend.get_title().set_fontsize(8.5)
    legend.get_title().set_color(MUTED)
    _caption(ax, caption or "Classes from configurable NDVI thresholds (config.yaml). Not a disease diagnosis.")
    return _save_figure(figure, path)


def _range_label(index: int, boundaries: Sequence[float]) -> str:
    if index == 0:
        return f"< {boundaries[0]:.2f}"
    if index >= len(boundaries):
        return f"> {boundaries[-1]:.2f}"
    return f"{boundaries[index - 1]:.2f} - {boundaries[index]:.2f}"


def save_weak_vegetation_map(
    ndvi: np.ndarray,
    weak_mask: np.ndarray,
    path: str | Path,
    *,
    aoi_gdf: Any = None,
    bounds: Sequence[float] | None = None,
    threshold: float = 0.4,
    patch_count: int = 0,
    caption: str = "",
) -> Path:
    """Grey NDVI backdrop with detected weak-vegetation patches highlighted."""
    style = figure_style()
    figure, ax = plt.subplots(figsize=(8.0, 6.4), dpi=style["dpi"])
    backdrop = _masked(ndvi)
    ax.imshow(backdrop, cmap="Greys", vmin=0.0, vmax=1.0, extent=_extent_from_bounds(bounds), interpolation="nearest", alpha=0.85)
    highlight = np.ma.masked_array(np.asarray(weak_mask, dtype="float32"), mask=~np.asarray(weak_mask, dtype=bool))
    overlay = matplotlib.colormaps["autumn"](np.where(highlight.mask, 0.0, 0.95))
    overlay[..., 3] = np.where(highlight.mask, 0.0, 0.65)
    ax.imshow(overlay, extent=_extent_from_bounds(bounds), interpolation="nearest")
    _draw_boundary(ax, aoi_gdf)
    ax.set_title("Weak vegetation zones", fontsize=12, color=INK, loc="left")
    ax.set_xticks([])
    ax.set_yticks([])
    handles = [
        matplotlib.patches.Patch(facecolor="#c07a1e", alpha=0.65, label=f"NDVI < {threshold:.2f} ({patch_count} patch(es))"),
        matplotlib.patches.Patch(facecolor="#d9d6ce", label="Vegetation above threshold"),
    ]
    ax.legend(handles=handles, loc="upper left", bbox_to_anchor=(1.02, 1.0), fontsize=8, frameon=False)
    _caption(ax, caption or "Threshold mask refined with OpenCV morphology (open, close, fill, small-object removal).")
    return _save_figure(figure, path)


def save_change_map(
    delta: np.ndarray,
    path: str | Path,
    *,
    aoi_gdf: Any = None,
    bounds: Sequence[float] | None = None,
    title: str = "NDVI change between observations",
    caption: str = "",
    limit: float = 0.4,
) -> Path:
    """Diverging change map (red = decline, green = improvement)."""
    style = figure_style()
    figure, ax = plt.subplots(figsize=(8.2, 6.4), dpi=style["dpi"])
    image = ax.imshow(_masked(delta), cmap=CHANGE_CMAP, vmin=-abs(limit), vmax=abs(limit), extent=_extent_from_bounds(bounds), interpolation="nearest")
    _draw_boundary(ax, aoi_gdf)
    colorbar = figure.colorbar(image, ax=ax, fraction=0.045, pad=0.02)
    colorbar.set_label("Δ index", fontsize=8.5)
    ax.set_title(title, fontsize=12, color=INK, loc="left")
    ax.set_xticks([])
    ax.set_yticks([])
    _caption(ax, caption or "Positive = increased canopy vigour, negative = decline between the two dates.")
    return _save_figure(figure, path)


def save_histogram(
    statistics: Mapping[str, Any],
    path: str | Path,
    *,
    index_name: str = "NDVI",
    thresholds: Mapping[str, float] | None = None,
) -> Path:
    """Histogram of index values with the configured class boundaries marked."""
    style = figure_style()
    histogram = statistics.get("histogram") or {}
    bins = np.asarray(histogram.get("bins") or [], dtype="float32")
    counts = np.asarray(histogram.get("counts") or [], dtype="float32")
    figure, ax = plt.subplots(figsize=(7.2, 4.0), dpi=style["dpi"])
    if bins.size > 1 and counts.size:
        centres = (bins[:-1] + bins[1:]) / 2
        colours = [NDVI_CMAP(np.clip((value + 0.2) / 1.2, 0, 1)) for value in centres]
        ax.bar(centres, counts, width=float(bins[1] - bins[0]) * 0.95, color=colours, edgecolor="white", linewidth=0.4)
    limits = health_thresholds() if thresholds is None else dict(thresholds)
    for key in ("very_low", "low", "moderate", "healthy"):
        ax.axvline(float(limits[key]), color=MUTED, linestyle="--", linewidth=0.9)
        ax.text(float(limits[key]), ax.get_ylim()[1] * 0.96, key, rotation=90, fontsize=6.5, color=MUTED, va="top", ha="right")
    mean = statistics.get("mean")
    if mean is not None:
        ax.axvline(float(mean), color=ACCENT, linewidth=1.6)
        ax.text(float(mean), ax.get_ylim()[1] * 0.6, f"mean {float(mean):.3f}", fontsize=7.5, color=ACCENT, rotation=90, va="top")
    ax.set_title(f"{index_name} distribution", fontsize=11, color=INK, loc="left")
    ax.set_xlabel(index_name, fontsize=8.5, color=MUTED)
    ax.set_ylabel("Pixels", fontsize=8.5, color=MUTED)
    ax.grid(color=GRID, linewidth=0.6, axis="y")
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.tick_params(labelsize=7.5, colors=MUTED)
    return _save_figure(figure, path)


def save_class_distribution_chart(health: Mapping[str, Any], path: str | Path, *, index_name: str = "NDVI") -> Path:
    """Horizontal bar chart of the crop-health class distribution."""
    style = figure_style()
    classes = list(health.get("classes") or [])
    figure, ax = plt.subplots(figsize=(7.2, 3.8), dpi=style["dpi"])
    if classes:
        labels = [entry["short"] for entry in classes]
        values = [float(entry["percentage"] or 0) for entry in classes]
        colours = [entry["colour"] for entry in classes]
        bars = ax.barh(labels, values, color=colours, edgecolor="white", height=0.65)
        for bar, value in zip(bars, values):
            ax.text(bar.get_width() + 0.6, bar.get_y() + bar.get_height() / 2, f"{value:.1f}%", va="center", fontsize=8, color=INK)
        ax.set_xlim(0, max(10.0, max(values) * 1.2))
    ax.set_title(f"Crop-health distribution ({index_name})", fontsize=11, color=INK, loc="left")
    ax.set_xlabel("Share of analysed pixels (%)", fontsize=8.5, color=MUTED)
    ax.grid(color=GRID, linewidth=0.6, axis="x")
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.tick_params(labelsize=8, colors=MUTED)
    return _save_figure(figure, path)


# --------------------------------------------------------------------------- #
# time series
# --------------------------------------------------------------------------- #
def save_timeseries_chart(
    series: Mapping[str, Any],
    path: str | Path,
    *,
    trend: Mapping[str, Any] | None = None,
    index_name: str | None = None,
    title: str | None = None,
) -> Path:
    """Mean index over time with a least-squares trend and healthy-area share."""
    style = figure_style()
    label = index_name or series.get("index", "NDVI")
    dates = [str(value) for value in series.get("dates", [])]
    means = series.get("means", [])
    healthy = series.get("healthy_pct", [])
    x = np.arange(len(dates))

    figure, ax = plt.subplots(figsize=(8.6, 4.4), dpi=style["dpi"])
    valid_points = [(i, float(value)) for i, value in enumerate(means) if value is not None]
    if valid_points:
        xs, ys = zip(*valid_points)
        ax.plot(xs, ys, marker="o", markersize=5.5, linewidth=2.0, color=BAR_COLOUR, label=f"Mean {label}")
        ax.fill_between(xs, 0.0, ys, color=BAR_COLOUR, alpha=0.10)
        for xi, yi in zip(xs, ys):
            ax.annotate(f"{yi:.3f}", (xi, yi), textcoords="offset points", xytext=(0, 9), ha="center", fontsize=7.5, color=INK)
        if trend and trend.get("slope_per_day") is not None and len(xs) >= 2:
            slope = float(trend["slope_per_day"])
            intercept = float(trend["intercept"])
            first_day = float(series["day_indices"][0])
            trend_y = [slope * (float(series["day_indices"][xi]) - first_day) + intercept for xi in xs]
            ax.plot(xs, trend_y, linestyle="--", linewidth=1.3, color=ACCENT, label=f"Trend {trend['direction']} ({trend.get('slope_per_30_days'):+.3f}/30d)")
    ax.set_xticks(x)
    ax.set_xticklabels(dates, rotation=30, ha="right", fontsize=7.5)
    ax.set_ylabel(label, fontsize=9, color=MUTED)
    ax.set_ylim(0, 1.0)
    ax.grid(color=GRID, linewidth=0.6, axis="y")
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.tick_params(labelsize=8, colors=MUTED)

    has_secondary = any(value is not None for value in healthy)
    if has_secondary:
        secondary = ax.twinx()
        healthy_points = [(i, float(value)) for i, value in enumerate(healthy) if value is not None]
        if healthy_points:
            hx, hy = zip(*healthy_points)
            secondary.plot(hx, hy, marker="s", markersize=4.0, linewidth=1.2, linestyle=":", color="#c07a1e", label="Healthy area %")
        secondary.set_ylabel("Healthy area (%)", fontsize=8.5, color="#c07a1e")
        secondary.set_ylim(0, 100)
        secondary.tick_params(labelsize=7.5, colors="#c07a1e")
        for spine in ("top",):
            secondary.spines[spine].set_visible(False)

    handles, labels = ax.get_legend_handles_labels()
    if has_secondary:
        secondary_handles, secondary_labels = secondary.get_legend_handles_labels()
        handles += secondary_handles
        labels += secondary_labels
    if handles:
        ax.legend(handles, labels, loc="lower right", fontsize=8, frameon=False)
    ax.set_title(title or f"{label} over time", fontsize=12, color=INK, loc="left")
    _caption(ax, f"{series.get('count', 0)} observation(s) between {series.get('first_date')} and {series.get('last_date')}.")
    return _save_figure(figure, path)


def save_observation_comparison(
    before_rgb: np.ndarray | None,
    after_rgb: np.ndarray | None,
    before_index: np.ndarray | None,
    after_index: np.ndarray | None,
    path: str | Path,
    *,
    before_label: str = "Before",
    after_label: str = "After",
    index_name: str = "NDVI",
) -> Path:
    """Side-by-side comparison grid of two observations (RGB on top, index below)."""
    style = figure_style()
    figure, axes = plt.subplots(2, 2, figsize=(9.0, 7.4), dpi=style["dpi"])
    panels = [
        (axes[0][0], before_rgb, before_label + " - imagery", True),
        (axes[0][1], after_rgb, after_label + " - imagery", True),
        (axes[1][0], before_index, before_label + f" - {index_name}", False),
        (axes[1][1], after_index, after_label + f" - {index_name}", False),
    ]
    for ax, data, title, is_rgb in panels:
        if data is None:
            ax.text(0.5, 0.5, "not available", ha="center", va="center", fontsize=9, color=MUTED)
        elif is_rgb:
            ax.imshow(np.asarray(data, dtype="uint8"))
        else:
            ax.imshow(_masked(data), cmap=NDVI_CMAP, vmin=-0.2, vmax=1.0)
        ax.set_title(title, fontsize=9.5, color=INK, loc="left")
        ax.set_xticks([])
        ax.set_yticks([])
    figure.tight_layout()
    return _save_figure(figure, path)


def save_legend_png(path: str | Path, *, index_name: str = "NDVI") -> Path:
    """Standalone colour-bar legend (handy for reports and slide decks)."""
    style = figure_style()
    figure, ax = plt.subplots(figsize=(5.6, 1.4), dpi=style["dpi"])
    gradient = np.linspace(-0.2, 1.0, 256).reshape(1, -1)
    ax.imshow(gradient, aspect="auto", cmap=NDVI_CMAP, extent=[-0.2, 1.0, 0, 1])
    ax.set_yticks([])
    ax.set_xticks([-0.2, 0.0, 0.2, 0.4, 0.6, 0.8, 1.0])
    ax.tick_params(labelsize=7.5, colors=MUTED)
    for spine in ("top", "right", "left"):
        ax.spines[spine].set_visible(False)
    ax.set_xlabel(index_name, fontsize=8.5, color=MUTED)
    return _save_figure(figure, path)


# --------------------------------------------------------------------------- #
# convenience bundle
# --------------------------------------------------------------------------- #
def render_result_bundle(
    output_dir: Path,
    *,
    rgb: np.ndarray | None = None,
    index_array: np.ndarray | None = None,
    classes: np.ndarray | None = None,
    weak_mask: np.ndarray | None = None,
    weak_threshold: float = 0.4,
    weak_patch_count: int = 0,
    statistics: Mapping[str, Any] | None = None,
    health: Mapping[str, Any] | None = None,
    transform: Any = None,
    crs: Any = None,
    aoi_gdf: Any = None,
    bounds: Sequence[float] | None = None,
    valid: np.ndarray | None = None,
    index_name: str = "NDVI",
    dataset_label: str = "",
    extra_caption: str = "",
) -> Dict[str, Dict[str, Any]]:
    """Generate every visual asset for one analysis and return their metadata."""
    if not get_config().get("visualization", {}).get("enabled", True):
        return {}
    # Without a CRS/transform the figures are still useful (pixel coordinates),
    # but map overlays are skipped: they must be georeferenced to be placed.
    georeferenced = transform is not None and crs is not None

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    assets: Dict[str, Dict[str, Any]] = {}
    caption = " ".join(part for part in [dataset_label, extra_caption] if part).strip()
    clip_bounds = None
    if bounds is not None:
        clip_bounds = list(bounds)

    if rgb is not None:
        assets["rgb_figure"] = {
            "path": save_rgb_png(rgb, output_dir / "field_rgb.png"),
            "label": "Field imagery (true colour)",
            "kind": "image",
        }
        if georeferenced:
            overlay = save_rgb_overlay(rgb, transform, crs, output_dir / "field_rgb_overlay.png")
            assets["rgb_overlay"] = {"path": overlay["path"], "bounds_lonlat": overlay["bounds_lonlat"], "label": "Imagery overlay", "kind": "overlay"}

    if index_array is not None:
        assets["index_map"] = {
            "path": save_index_map(
                index_array,
                output_dir / f"{index_name.lower()}_map.png",
                transform=transform,
                crs=crs,
                aoi_gdf=aoi_gdf,
                bounds=clip_bounds,
                valid=valid,
                index_name=index_name,
                title=f"{index_name} - {dataset_label}" if dataset_label else f"{index_name} map",
                boundaries=health_class_boundaries_safe(),
                caption=caption,
            ),
            "label": f"{index_name} map",
            "kind": "image",
        }
        if georeferenced:
            overlay = save_rgba_overlay(
                index_array,
                transform,
                crs,
                output_dir / f"{index_name.lower()}_overlay.png",
                cmap=NDVI_CMAP,
                vmin=-0.2,
                vmax=1.0,
                valid=valid,
            )
            assets["index_overlay"] = {"path": overlay["path"], "bounds_lonlat": overlay["bounds_lonlat"], "label": f"{index_name} overlay", "kind": "overlay"}
        if statistics:
            assets["histogram"] = {
                "path": save_histogram(statistics, output_dir / "index_histogram.png", index_name=index_name),
                "label": "Value distribution",
                "kind": "chart",
            }

    if classes is not None:
        assets["health_map"] = {
            "path": save_health_map(
                classes,
                output_dir / "crop_health_map.png",
                aoi_gdf=aoi_gdf,
                bounds=clip_bounds,
                title=f"Crop health classes - {dataset_label}" if dataset_label else "Crop health classes",
                caption=caption,
            ),
            "label": "Crop health map",
            "kind": "image",
        }
        if georeferenced:
            overlay = save_rgba_overlay(
                classes,
                transform,
                crs,
                output_dir / "crop_health_overlay.png",
                discrete=True,
                alpha=0.8,
            )
            assets["health_overlay"] = {"path": overlay["path"], "bounds_lonlat": overlay["bounds_lonlat"], "label": "Crop health overlay", "kind": "overlay"}
        if health:
            assets["health_distribution"] = {
                "path": save_class_distribution_chart(health, output_dir / "crop_health_distribution.png", index_name=index_name),
                "label": "Health distribution",
                "kind": "chart",
            }

    if weak_mask is not None and np.asarray(weak_mask).any():
        assets["weak_vegetation"] = {
            "path": save_weak_vegetation_map(
                index_array if index_array is not None else np.zeros(np.asarray(weak_mask).shape, dtype="float32"),
                weak_mask,
                output_dir / "weak_vegetation_map.png",
                aoi_gdf=aoi_gdf,
                bounds=clip_bounds,
                threshold=weak_threshold,
                patch_count=weak_patch_count,
                caption=caption,
            ),
            "label": "Weak vegetation zones",
            "kind": "image",
        }
        if georeferenced:
            overlay = save_rgba_overlay(
                np.asarray(weak_mask, dtype="float32"),
                transform,
                crs,
                output_dir / "weak_vegetation_overlay.png",
                discrete=True,
                class_colours=["#d9d6ce", "#c07a1e"],
                alpha=0.75,
            )
            assets["weak_vegetation_overlay"] = {"path": overlay["path"], "bounds_lonlat": overlay["bounds_lonlat"], "label": "Weak zones overlay", "kind": "overlay"}

    return assets


def health_class_boundaries_safe() -> list[float]:
    limits = health_thresholds()
    return [float(limits["very_low"]), float(limits["low"]), float(limits["moderate"]), float(limits["healthy"])]


def ndvi_colour_for(value: float) -> str:
    """Hex colour for a single index value (used by API summaries)."""
    if value is None or not np.isfinite(value):
        return "#d9d6ce"
    normalised = float(np.clip((value + 0.2) / 1.2, 0.0, 1.0))
    rgba = NDVI_CMAP(normalised)
    return matplotlib.colors.to_hex(rgba)


def available_charts() -> Dict[str, str]:
    return {
        "index_map": "Continuous vegetation index map with legend",
        "index_overlay": "Transparent EPSG:4326 overlay for the web map",
        "health_map": "Discrete crop-health class map",
        "health_distribution": "Class share bar chart",
        "histogram": "Index value histogram with class boundaries",
        "weak_vegetation": "Weak-vegetation zones",
        "timeseries": "Index over time with trend and healthy-area share",
        "change_map": "Diverging change map between two observations",
        "observation_comparison": "2x2 comparison grid of two observations",
    }
