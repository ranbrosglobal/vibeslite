"""Agriculture-focused geospatial engine.

Only what an agriculture pipeline needs: CRS detection/conversion, AOI
validation against a raster, windowed raster clipping, AOI rasterisation and
turning masks back into polygons with real-world areas. This is intentionally
*not* a general GIS system.

Windowed reads matter here: ``clip_raster_to_aoi`` reads only the intersection
of the raster with the AOI (using rasterio windows) and can decimate through
overviews, so a 2 GB scene with one small field does not have to be loaded
whole.
"""
from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Sequence

import numpy as np
import rasterio
from rasterio.features import geometry_mask, shapes
from rasterio.errors import WindowError
from rasterio.windows import Window, from_bounds
from rasterio.warp import transform_bounds
from shapely.geometry import mapping, shape

from config import max_analysis_pixels
from data import AOIError, DataError, NotFoundError, RasterError, geometry_area_hectares


class GeospatialError(DataError):
    """Raised when an AOI and raster cannot be reconciled."""


# --------------------------------------------------------------------------- #
# CRS helpers
# --------------------------------------------------------------------------- #
def _first_axis_unit(crs: Any) -> str | None:
    """Unit name of the first axis of a pyproj-style CRS, or ``None``."""
    try:
        axes = list(getattr(crs, "axis_info", None) or [])
    except Exception:  # pragma: no cover - defensive
        axes = []
    for axis in axes:
        unit = getattr(axis, "unit_name", None)
        if unit:
            return str(unit)
    return None


def _crs_unit(crs: Any, projected: bool) -> str | None:
    """Linear unit for projected CRSs, angular unit otherwise.

    CRS implementations differ: rasterio exposes ``linear_units`` but not
    ``axis_info``, pyproj is the other way round, and neither reports an
    angular unit for a geographic CRS. So try the shortcuts, then the axes,
    then convert through pyproj, and only then give up.
    """
    shortcut = "linear_units" if projected else "angular_units"
    direct = getattr(crs, shortcut, None) or getattr(crs, "linear_units" if not projected else "angular_units", None)
    if projected and direct:
        return str(direct)

    unit = _first_axis_unit(crs)
    if unit:
        return unit

    try:
        import pyproj

        unit = _first_axis_unit(pyproj.CRS.from_user_input(crs))
        if unit:
            return unit
    except Exception:  # pragma: no cover - defensive
        pass
    return str(direct) if direct else None


def crs_info(crs: Any) -> Dict[str, Any]:
    """Normalise a CRS object into a serialisable summary."""
    if crs is None:
        return {"defined": False, "epsg": None, "name": "undefined", "is_projected": False, "unit": None}
    epsg = None
    try:
        epsg = crs.to_epsg()
    except Exception:  # pragma: no cover - defensive
        epsg = None
    is_projected = bool(getattr(crs, "is_projected", False))
    return {
        "defined": True,
        "epsg": epsg,
        "name": getattr(crs, "name", str(crs)),
        "is_projected": is_projected,
        "unit": _crs_unit(crs, is_projected),
    }


def get_crs(path: str | Any) -> Any:
    """CRS of a raster path or an open rasterio dataset."""
    if isinstance(path, (str, bytes)) or hasattr(path, "__fspath__"):
        with rasterio.open(path) as dataset:
            return dataset.crs
    return getattr(path, "crs", None)


def transform_bounds_lonlat(bounds: Sequence[float], crs: Any) -> List[float] | None:
    """Reproject bounds to [west, south, east, north] in EPSG:4326."""
    if crs is None:
        return None
    try:
        west, south, east, north = transform_bounds(crs, "EPSG:4326", *bounds, densify_pts=21)
        return [float(west), float(south), float(east), float(north)]
    except Exception:  # pragma: no cover - defensive
        return None


def raster_bounds(path: str, lonlat: bool = False) -> List[float] | Dict[str, float]:
    """Raster bounds in its native CRS ``[left, bottom, right, top]``."""
    with rasterio.open(path) as dataset:
        bounds = dataset.bounds
        if lonlat:
            projected = transform_bounds_lonlat([bounds.left, bounds.bottom, bounds.right, bounds.top], dataset.crs)
            if projected is None:
                raise GeospatialError("Raster CRS cannot be converted to WGS84")
            return projected
        return [float(bounds.left), float(bounds.bottom), float(bounds.right), float(bounds.top)]


def guess_utm_epsg(lon: float, lat: float) -> int:
    """Best-effort UTM EPSG code for a lon/lat pair (metric area maths)."""
    zone = int(math.floor((lon + 180) / 6) % 60) + 1
    return (32600 if lat >= 0 else 32700) + zone


def polygon_around_point(lat: float, lon: float, size_m: float, kind: str = "square") -> Dict[str, Any]:
    """A field boundary centred on a real coordinate, as a WGS84 GeoJSON polygon.

    Built in the local UTM zone rather than in degrees: a degree box is not a
    square on the ground (a 1 km box is ~1 km tall everywhere but only ~700 m
    wide at 45° latitude), so the offsets are applied in metres and transformed
    back. The resulting polygon's area matches ``size_m`` squared to within the
    UTM scale factor.

    ``kind`` is ``square`` (four corners) or ``circle`` (a 48-gon; OSM has no
    circle primitive and a rasterised AOI wants vertices either way).
    """
    if not math.isfinite(lat) or not math.isfinite(lon):
        raise AOIError("Latitude and longitude must be finite numbers")
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        raise AOIError("Latitude must be within -90..90 and longitude within -180..180")
    if abs(lat) >= 89.5:
        raise AOIError("Cannot lay out a metric field boundary within 0.5° of a pole (UTM is undefined there)")
    if not math.isfinite(size_m) or size_m <= 0:
        raise AOIError("Field size must be a positive number of metres")

    from pyproj import Transformer

    epsg = guess_utm_epsg(lon, lat)
    forward = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    back = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
    center_x, center_y = forward.transform(lon, lat)
    half = size_m / 2.0

    if kind == "circle":
        offsets = [
            (half * math.cos(2 * math.pi * i / 48), half * math.sin(2 * math.pi * i / 48)) for i in range(48)
        ]
    else:
        offsets = [(-half, -half), (half, -half), (half, half), (-half, half)]

    ring = []
    for offset_x, offset_y in offsets:
        point_lon, point_lat = back.transform(center_x + offset_x, center_y + offset_y)
        ring.append([round(point_lon, 8), round(point_lat, 8)])
    ring.append(ring[0])
    # The geometry is returned bare (GeoJSON geometries carry no properties);
    # the caller wraps it in a Feature and keeps this metadata alongside.
    return {
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "epsg": epsg,
        "size_m": size_m,
        "shape": kind,
        "center": {"lat": lat, "lon": lon},
    }


def reproject_aoi(gdf: Any, dst_crs: Any) -> Any:
    """Reproject an AOI to the raster CRS, keeping it in an equal geometry."""
    if gdf is None or len(gdf) == 0:
        raise AOIError("AOI contains no features")
    working = gdf if gdf.crs is not None else gdf.set_crs("EPSG:4326", allow_override=True)
    if dst_crs is None:
        raise GeospatialError("Cannot reproject an AOI onto a raster without a CRS")
    return working.to_crs(dst_crs)


def aoi_geometry_geojson(gdf: Any, dst_crs: str | Any = "EPSG:4326") -> Dict[str, Any]:
    """AOI as a WGS84 FeatureCollection (for the map layer in the UI)."""
    working = gdf if gdf.crs is None else gdf.to_crs(dst_crs)
    import json

    return json.loads(working.to_json())


def pixel_area_hectares(transform: Any) -> float:
    """Ground area of one pixel in hectares (projected CRS in metres)."""
    return abs(transform.a * transform.e) / 10_000.0


def raster_aoi_overlap(aoi_gdf: Any, raster_meta: Dict[str, Any], crs: Any) -> Dict[str, Any]:
    """How much of the AOI is actually covered by the raster."""
    raster_bounds_native = raster_meta.get("bounds")
    if not raster_bounds_native or crs is None:
        return {"overlap_fraction": None, "warnings": ["Raster has no CRS: overlap could not be checked."]}

    from shapely.geometry import box

    aoi_native = reproject_aoi(aoi_gdf, crs)
    raster_poly = box(
        raster_bounds_native["left"],
        raster_bounds_native["bottom"],
        raster_bounds_native["right"],
        raster_bounds_native["top"],
    )
    aoi_geom = aoi_native.geometry.unary_union
    if not aoi_geom.intersects(raster_poly):
        raise GeospatialError("The AOI does not overlap the raster extent")
    covered = aoi_geom.intersection(raster_poly)
    fraction = float(covered.area / aoi_geom.area) if aoi_geom.area else 0.0
    warnings: List[str] = []
    if fraction < 0.999:
        warnings.append(
            f"Only {fraction * 100:.1f}% of the AOI lies inside the raster extent; "
            "analysis covers the overlapping part only."
        )
    if fraction < 0.05:
        warnings.append("Less than 5% of the AOI overlaps the raster - check that the CRS and AOI are correct.")
    return {"overlap_fraction": round(fraction, 5), "warnings": warnings}


# --------------------------------------------------------------------------- #
# clipping and masking
# --------------------------------------------------------------------------- #
def clip_raster_to_aoi(
    path: str,
    aoi_gdf: Any,
    bands: Sequence[int] | None = None,
    all_touched: bool = True,
    max_pixels: int | None = None,
    pad_pixels: int = 0,
) -> Dict[str, Any]:
    """Windowed clip of a raster to an AOI, with an AOI mask and transform.

    Returns raw (unmasked) band data; masking is applied explicitly by the
    caller so preprocessing stays in one place.
    """
    file_path = str(path)
    if aoi_gdf is None or len(aoi_gdf) == 0:
        raise AOIError("AOI contains no features")

    with rasterio.open(file_path) as dataset:
        if dataset.crs is None:
            raise GeospatialError("Raster has no CRS, cannot clip to an AOI")
        if dataset.transform == rasterio.Affine.identity():
            raise GeospatialError("Raster transform is not georeferenced, cannot clip to an AOI")

        aoi = reproject_aoi(aoi_gdf, dataset.crs)
        bounds = aoi.total_bounds
        window = from_bounds(*bounds, transform=dataset.transform).round_offsets().round_lengths()
        if pad_pixels:
            window = Window(
                window.col_off - pad_pixels,
                window.row_off - pad_pixels,
                window.width + 2 * pad_pixels,
                window.height + 2 * pad_pixels,
            )
        try:
            window = window.intersection(Window(0, 0, dataset.width, dataset.height))
        except WindowError as exc:
            raise GeospatialError("The AOI lies outside the raster extent") from exc
        if window.width < 1 or window.height < 1:
            raise GeospatialError("The AOI lies outside the raster extent")

        budget = int(max_pixels or max_analysis_pixels())
        scale = 1.0
        if window.width * window.height > budget:
            scale = math.sqrt(budget / float(window.width * window.height))
        out_height = max(1, int(round(window.height * scale)))
        out_width = max(1, int(round(window.width * scale)))

        band_list = list(bands) if bands else list(range(1, dataset.count + 1))
        for band in band_list:
            if band < 1 or band > dataset.count:
                raise RasterError(f"Band {band} requested but raster has {dataset.count} band(s)")

        array = dataset.read(band_list, window=window, out_shape=(len(band_list), out_height, out_width), masked=False)
        scales = [dataset.scales[b - 1] for b in band_list]
        offsets = [dataset.offsets[b - 1] for b in band_list]
        applied_scaling = False
        if any(s not in (1.0, None) for s in scales) or any(o not in (0.0, None) for o in offsets):
            scale_factor = float(scales[0] or 1.0)
            offset_factor = float(offsets[0] or 0.0)
            array = array.astype("float32") * scale_factor + offset_factor
            applied_scaling = True

        transform = dataset.window_transform(window) * rasterio.Affine.scale(
            window.width / out_width, window.height / out_height
        )
        geoms = [mapping(geom) for geom in aoi.geometry]
        mask = geometry_mask(geoms, out_shape=(out_height, out_width), transform=transform, invert=True, all_touched=all_touched)
        clip_bounds = rasterio.transform.array_bounds(out_height, out_width, transform)
        nodata = None if dataset.nodata is None else float(dataset.nodata)
        descriptions = [dataset.descriptions[b - 1] or "" for b in band_list]

        return {
            "array": np.asarray(array),
            "mask": np.asarray(mask),
            "bands": band_list,
            "band_descriptions": descriptions,
            "transform": transform,
            "crs": dataset.crs,
            "nodata": nodata,
            "shape": (out_height, out_width),
            "window": (int(window.col_off), int(window.row_off), int(window.width), int(window.height)),
            "decimation": round(1.0 / scale, 4) if scale else 1.0,
            "decimated": bool(scale < 1.0),
            "source_shape": (int(window.height), int(window.width)),
            "source": dataset.name.split("/")[-1],
            "clip_bounds": [float(v) for v in clip_bounds],
            "clip_bounds_lonlat": transform_bounds_lonlat(clip_bounds, dataset.crs),
            "pixel_area_ha": pixel_area_hectares(transform),
            "applied_scaling": applied_scaling,
            "aoi_feature_count": int(len(aoi)),
            "masked_pixel_ratio": float(1.0 - (mask.sum() / mask.size)) if mask.size else None,
        }


def rasterize_aoi(aoi_gdf: Any, out_shape: tuple[int, int], transform: Any, all_touched: bool = True) -> np.ndarray:
    """Boolean mask (True inside the AOI) for a given raster grid."""
    if aoi_gdf is None or len(aoi_gdf) == 0:
        raise AOIError("AOI contains no features")
    geoms = [mapping(geom) for geom in aoi_gdf.geometry]
    return np.asarray(
        geometry_mask(geoms, out_shape=out_shape, transform=transform, invert=True, all_touched=all_touched)
    )


def apply_aoi_mask(array: np.ndarray, mask: np.ndarray) -> np.ma.MaskedArray:
    """Mask array cells outside the AOI (returns a masked array)."""
    data = np.asarray(array)
    outside = ~np.asarray(mask, dtype=bool)
    if data.ndim == 2:
        return np.ma.masked_array(data, mask=outside)
    if data.ndim == 3:
        broadcast = np.broadcast_to(outside, data.shape)
        return np.ma.masked_array(data, mask=broadcast)
    raise GeospatialError("Only 2D or 3D arrays can be masked")


def mask_to_polygons(
    mask: np.ndarray,
    transform: Any,
    crs: Any,
    min_area_ha: float = 0.0,
    simplify_pixels: float = 0.0,
    properties: Dict[str, Any] | None = None,
) -> List[Dict[str, Any]]:
    """Turn a boolean mask into polygons with areas and WGS84 centroids."""
    binary = np.asarray(mask, dtype=bool)
    if binary.sum() == 0:
        return []
    import geopandas as gpd
    from shapely.geometry import MultiPolygon, Polygon

    labelled = binary.astype("uint8")
    features = [shape(geom) for geom, value in shapes(labelled, mask=binary, transform=transform) if int(value) == 1]
    if not features:
        return []

    gdf = gpd.GeoDataFrame({"geometry": features}, crs=crs)
    if simplify_pixels:
        gdf["geometry"] = gdf.geometry.simplify(simplify_pixels)
    areas = geometry_area_hectares(gdf)
    gdf["area_ha"] = areas
    if min_area_ha:
        gdf = gdf[gdf["area_ha"] >= min_area_ha].reset_index(drop=True)
    if len(gdf) == 0:
        return []

    # Centroids are computed on the projected grid (geographic centroids are
    # unreliable) and then converted to WGS84 for the map markers.
    centroids_native = gdf.geometry.centroid
    import geopandas as gpd  # noqa: F811 (already imported above, kept explicit)

    centroids = gpd.GeoSeries(centroids_native, crs=gdf.crs).to_crs("EPSG:4326")
    records: List[Dict[str, Any]] = []
    for index, row in gdf.iterrows():
        geom = row.geometry
        if isinstance(geom, MultiPolygon):
            geom = max(geom.geoms, key=lambda part: part.area)
        if not isinstance(geom, Polygon):
            continue
        record = {
            "area_ha": round(float(row["area_ha"]), 4),
            "centroid_lonlat": [round(float(centroids.iloc[index].x), 6), round(float(centroids.iloc[index].y), 6)],
            "geometry_geojson": mapping(geom),
        }
        if properties:
            record.update(properties)
        records.append(record)
    records.sort(key=lambda item: item["area_ha"], reverse=True)
    return records


def zones_feature_collection(zones: Iterable[Dict[str, Any]], zone_key: str = "zone") -> Dict[str, Any]:
    """Build a FeatureCollection from zone records for the map layer."""
    features = []
    for index, zone in enumerate(zones):
        geometry = zone.get("geometry_geojson")
        if not geometry:
            continue
        properties = {k: v for k, v in zone.items() if k != "geometry_geojson"}
        properties.setdefault(zone_key, properties.get("label") or f"zone_{index + 1}")
        features.append({"type": "Feature", "geometry": geometry, "properties": properties})
    return {"type": "FeatureCollection", "features": features}


def reproject_to_lonlat(
    array: np.ndarray,
    transform: Any,
    crs: Any,
    out_shape: tuple[int, int] | None = None,
) -> Dict[str, Any]:
    """Reproject an array to a regular EPSG:4326 grid.

    Used for web overlays: an image overlay in Leaflet is assumed to be linear
    in lon/lat, so a UTM raster has to be resampled first. The output grid keeps
    the aspect ratio of the source window and returns exact lon/lat bounds.
    """
    from rasterio.warp import calculate_default_transform, reproject, Resampling

    data = np.asarray(array)
    if data.ndim == 2:
        data = data[np.newaxis, :, :]
    left, bottom, right, top = rasterio.transform.array_bounds(data.shape[1], data.shape[2], transform)
    dst_transform, default_width, default_height = calculate_default_transform(
        crs, "EPSG:4326", data.shape[2], data.shape[1], left=left, bottom=bottom, right=right, top=top
    )
    dst_width, dst_height = int(default_width), int(default_height)
    if out_shape is not None:
        # Keep the geographic extent of the default grid, change only the resolution.
        dst_height, dst_width = max(1, int(out_shape[0])), max(1, int(out_shape[1]))
        lon_left, lat_bottom, lon_right, lat_top = rasterio.transform.array_bounds(
            default_height, default_width, dst_transform
        )
        dst_transform = rasterio.transform.from_bounds(lon_left, lat_bottom, lon_right, lat_top, dst_width, dst_height)

    destination = np.full((data.shape[0], dst_height, dst_width), np.nan, dtype="float32")
    for index in range(data.shape[0]):
        source = data[index].astype("float32")
        source = np.where(np.isfinite(source), source, np.nan)
        reproject(
            source=source,
            destination=destination[index],
            src_transform=transform,
            src_crs=crs,
            dst_transform=dst_transform,
            dst_crs="EPSG:4326",
            src_nodata=np.nan,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
    bounds = rasterio.transform.array_bounds(dst_height, dst_width, dst_transform)
    return {
        "array": destination[0] if destination.shape[0] == 1 else destination,
        "transform": dst_transform,
        "bounds_lonlat": [float(bounds[0]), float(bounds[1]), float(bounds[2]), float(bounds[3])],
        "shape": (int(dst_height), int(dst_width)),
    }


def raster_footprint(path: str) -> Dict[str, Any]:
    """Raster extent as a WGS84 polygon plus pixel geometry info."""
    with rasterio.open(path) as dataset:
        bounds = dataset.bounds
        lonlat = transform_bounds_lonlat([bounds.left, bounds.bottom, bounds.right, bounds.top], dataset.crs)
        return {
            "geometry_geojson": mapping(shape({
                "type": "Polygon",
                "coordinates": [[
                    [bounds.left, bounds.bottom],
                    [bounds.right, bounds.bottom],
                    [bounds.right, bounds.top],
                    [bounds.left, bounds.top],
                    [bounds.left, bounds.bottom],
                ]],
            })),
            "bounds": [float(bounds.left), float(bounds.bottom), float(bounds.right), float(bounds.top)],
            "bounds_lonlat": lonlat,
            "crs": crs_info(dataset.crs),
        }


def dataset_names() -> List[str]:  # pragma: no cover - convenience alias
    from data import dataset_names as _names

    return _names(["raster"])


__all__ = [
    "GeospatialError",
    "crs_info",
    "get_crs",
    "transform_bounds_lonlat",
    "raster_bounds",
    "guess_utm_epsg",
    "reproject_aoi",
    "aoi_geometry_geojson",
    "pixel_area_hectares",
    "raster_aoi_overlap",
    "clip_raster_to_aoi",
    "rasterize_aoi",
    "apply_aoi_mask",
    "mask_to_polygons",
    "zones_feature_collection",
    "raster_footprint",
    "reproject_to_lonlat",
]
