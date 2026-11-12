"""Vibes Lite HTTP API.

This module is the orchestration layer: it validates user input with Pydantic,
drives the engines (data -> geospatial -> preprocessing -> indices -> analysis
-> segmentation -> visualization) and stores results. No analysis maths lives
here - every number comes from an engine module, so the same code runs from the
notebooks, from tests, and from the API.

Endpoints
---------
GET  /api/health                     service status + capabilities
GET  /api/project                    project descriptor
GET  /api/config                     thresholds, indices, operations
GET  /api/dashboard                  aggregate metrics for the dashboard
GET  /api/datasets                   datasets available in data/raw
GET  /api/datasets/{name}            dataset metadata / validation
GET  /api/datasets/{name}/preview    PNG preview of a raster
GET  /api/datasets/{name}/footprint  raster extent as GeoJSON
GET  /api/aoi                        AOIs available in data/raw
GET  /api/aoi/{name}                 AOI geometry + summary
POST /api/upload                     upload raster / GeoJSON / CSV
POST /api/aoi                        validate (and optionally store) an AOI
GET  /api/geo/status                 OpenStreetMap providers, policy limits and attribution
GET  /api/geo/search                 forward geocoding (Nominatim)
GET  /api/geo/reverse                reverse geocoding (Nominatim)
GET  /api/geo/features               real OSM features near a point, as GeoJSON (Overpass)
POST /api/geo/aoi-from-point         field boundary around a location picked on the map
GET  /api/satellite/catalogue        real satellite collections, bands and read limits
GET  /api/satellite/scenes           real Sentinel acquisitions over a field (STAC)
POST /api/satellite/fetch            download a real scene window into data/raw
GET  /api/weather/catalogue          real weather providers, coverage, licences and limits
GET  /api/weather/current            live conditions at a point
GET  /api/weather/daily              any date or window, 1940 -> forecast horizon
GET  /api/weather/crosscheck         the same days from a second, independent model
POST /api/weather/for-dates          weather on a specific set of dates (e.g. scene dates)
POST /api/ndvi                       full NDVI field analysis
POST /api/crop-health                crop-health analysis (NDVI based)
POST /api/opencv/process             OpenCV processing pipeline
POST /api/segmentation               segmentation (classical, models pluggable)
POST /api/timeseries                 multi-date index time series
GET  /api/results                    stored results
GET  /api/results/{id}               one stored result
GET  /api/results/{id}/assets/{file} download a generated asset
POST /api/samples/synthetic          labelled synthetic demo scene (not real imagery)
"""
from __future__ import annotations

import json
import math
import os
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Mapping, Optional, Sequence

import numpy as np
from fastapi import APIRouter, File, Form, Query, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field, field_validator

import agronomy
import analysis
import geospatial
import indices
import opencv as cv
import osm
import preprocessing
import satellite
import segmentation
import timeseries as ts
import visualization
import weather
from config import ensure_directories, health_thresholds, project_info, project_paths, security_config
from data import (
    AOIError,
    DataError,
    NotFoundError,
    RasterError,
    get_raster_metadata,
    kind_for_filename,
    list_datasets,
    load_aoi,
    load_dataset,
    load_geojson,
    resolve_dataset,
    safe_filename,
    save_aoi,
    save_processed_raster,
    save_upload,
    validate_raster,
)
from storage import (
    add_asset,
    asset_path,
    build_analysis_key,
    create_result,
    find_cached,
    jsonable,
    list_results,
    load_result,
    result_directory,
    save_result,
    stats_summary,
)

router = APIRouter(prefix="/api", tags=["vibes-lite"])

DISCLAIMER = (
    "Vibes Lite computes vegetation indices and index-based health classes. "
    "These describe canopy greenness and density and are not a diagnosis of crop disease, "
    "pest pressure or nutrient deficiency."
)


# --------------------------------------------------------------------------- #
# Pydantic models
# --------------------------------------------------------------------------- #
class BandSelection(BaseModel):
    """Explicit 1-based band numbers (overrides automatic band detection)."""

    blue: Optional[int] = Field(None, ge=1)
    green: Optional[int] = Field(None, ge=1)
    red: Optional[int] = Field(None, ge=1)
    red_edge: Optional[int] = Field(None, ge=1)
    nir: Optional[int] = Field(None, ge=1)

    def as_map(self) -> Dict[str, int]:
        return {key: value for key, value in self.model_dump().items() if value is not None}


class ThresholdOverrides(BaseModel):
    """Optional per-request override of the configured crop-health thresholds."""

    very_low: Optional[float] = Field(None, ge=-1.0, le=1.0)
    low: Optional[float] = Field(None, ge=-1.0, le=1.0)
    moderate: Optional[float] = Field(None, ge=-1.0, le=1.0)
    healthy: Optional[float] = Field(None, ge=-1.0, le=1.0)

    def merged(self) -> Optional[Dict[str, float]]:
        values = {key: value for key, value in self.model_dump().items() if value is not None}
        if not values:
            return None
        thresholds = health_thresholds()
        thresholds.update(values)
        return thresholds


class AnalysisRequest(BaseModel):
    """Shared request body for NDVI and crop-health analysis."""

    dataset: str = Field(..., description="Raster file name in data/raw")
    aoi: Optional[str] = Field(None, description="GeoJSON file name in data/raw; omit to use the raster footprint")
    band_map: Optional[BandSelection] = None
    index: str = Field("NDVI", description="NDVI (primary), NDRE, EVI or SAVI")
    observation_date: Optional[str] = Field(None, description="Acquisition date (YYYY-MM-DD) for time series")
    max_pixels: Optional[int] = Field(None, ge=1024, le=64_000_000)
    thresholds: Optional[ThresholdOverrides] = None
    weak_threshold: Optional[float] = Field(None, ge=-1.0, le=1.0)
    min_patch_area_ha: Optional[float] = Field(None, gt=0, le=10_000)
    anomaly_method: Literal["zscore", "iqr"] = "zscore"
    include_visuals: bool = True
    use_cache: bool = True

    @field_validator("dataset")
    @classmethod
    def _clean_dataset(cls, value: str) -> str:
        return value.strip()


class AoiRequest(BaseModel):
    """Provide an AOI as GeoJSON, or point at a file already in data/raw."""

    name: Optional[str] = Field(None, description="Existing GeoJSON file name in data/raw")
    geojson: Optional[Dict[str, Any]] = Field(None, description="Inline GeoJSON FeatureCollection / Feature / geometry")
    save_as: Optional[str] = Field(None, description="Persist the validated AOI under this file name")


class GeoFieldRequest(BaseModel):
    """A field boundary drawn around a coordinate picked on the OSM basemap."""

    lat: float = Field(..., ge=-90, le=90, description="Picked latitude (WGS84)")
    lon: float = Field(..., ge=-180, le=180, description="Picked longitude (WGS84)")
    size_m: Optional[float] = Field(
        None, gt=10, le=20_000, description="Side length in metres (ignored when area_ha is given)"
    )
    area_ha: Optional[float] = Field(None, gt=0.01, le=40_000, description="Preferred way to size the field")
    shape: Literal["square", "circle"] = Field("square", description="square | circle (48-gon)")
    label: Optional[str] = Field(None, max_length=80, description="Human label stored in the geometry")
    place: Optional[str] = Field(None, max_length=200, description="Display name resolved from OSM, kept for traceability")
    name: str = Field("picked_field", max_length=60, description="File name to store the boundary under")
    save: bool = Field(True, description="Write the boundary into data/raw so analyses can use it by name")


class SatelliteFetchRequest(BaseModel):
    """Pull one real Sentinel acquisition over a field into ``data/raw``."""

    lat: float = Field(..., ge=-90, le=90, description="Field centre latitude (WGS84)")
    lon: float = Field(..., ge=-180, le=180, description="Field centre longitude (WGS84)")
    radius_m: Optional[float] = Field(
        None, gt=0, description="Half-width of the field window in metres (capped in configuration)"
    )
    scene_id: Optional[str] = Field(
        None, max_length=120, description="Exact STAC item id; omit to take the least cloudy scene in the window"
    )
    collection: Optional[str] = Field(None, max_length=60, description="Catalogue key; defaults to the configured collection")
    days: Optional[int] = Field(None, ge=1, le=365, description="How far back to look for acquisitions")
    max_cloud: Optional[float] = Field(None, ge=0, le=100, description="Reject scenes cloudier than this (percent)")
    mask_clouds: bool = Field(True, description="Apply the Scene Classification Layer so cloud pixels become nodata")
    bands: Optional[List[str]] = Field(None, description="Band keys to fetch; omit for the full reflectance set")
    force: bool = Field(False, description="Re-download even when an identical window is already stored")


class WeatherDatesRequest(BaseModel):
    """Weather on a specific set of dates - the join that dates an image."""

    lat: float = Field(..., ge=-90, le=90, description="Field centre latitude (WGS84)")
    lon: float = Field(..., ge=-180, le=180, description="Field centre longitude (WGS84)")
    dates: List[str] = Field(
        ...,
        min_length=1,
        max_length=400,
        description="ISO dates (YYYY-MM-DD) - e.g. the acquisition dates of stored scenes",
    )


class SegmentationRequest(AnalysisRequest):
    method: str = Field("threshold", description="threshold | otsu | multi_threshold | zones, or a registered model")
    params: Optional[Dict[str, Any]] = None


class ObservationInput(BaseModel):
    """One time-series observation: either inline stats, a stored result, or a fresh dataset run."""

    date: str
    mean: Optional[float] = None
    median: Optional[float] = None
    min: Optional[float] = None
    max: Optional[float] = None
    std: Optional[float] = None
    healthy_pct: Optional[float] = None
    weak_pct: Optional[float] = None
    valid_pixels: Optional[int] = None
    result_id: Optional[str] = None
    dataset: Optional[str] = None
    aoi: Optional[str] = None
    label: Optional[str] = None


# --------------------------------------------------------------------------- #
# agronomy models (thermal time, water balance, zones, prescriptions, carbon)
# --------------------------------------------------------------------------- #
class ThermalTimeRequest(BaseModel):
    """Daily temperature series -> growing degree days and crop stage."""

    tmin: List[float] = Field(..., min_length=1, max_length=2000)
    tmax: List[float] = Field(..., min_length=1, max_length=2000)
    base_c: float = Field(10.0, ge=-10.0, le=40.0)
    upper_c: Optional[float] = Field(30.0, ge=0.0, le=60.0, description="Cut-out ceiling; null disables it")
    method: Literal["average", "modified", "sine"] = "average"
    crop: str = "generic"
    stage_days: Optional[List[float]] = Field(None, description="Override the FAO stage lengths with local ones")


class WaterBalanceRequest(BaseModel):
    """Daily ET0 + rainfall -> FAO-56 depletion balance and an irrigation schedule."""

    et0: List[float] = Field(..., min_length=1, max_length=2000)
    rainfall: List[float] = Field(..., min_length=1, max_length=2000)
    crop: str = "generic"
    soil: str = "generic"
    kc: Optional[List[float]] = Field(None, description="Per-day crop coefficient; overrides the crop default")
    root_depth_m: float = Field(1.0, gt=0.05, le=3.0)
    initial_depletion_mm: float = Field(0.0, ge=0.0, le=1000.0)
    depletion_trigger_pct: float = Field(55.0, ge=10.0, le=90.0)
    irrigation_efficiency: float = Field(0.75, gt=0.1, le=1.0)
    rainfall_effectiveness: float = Field(0.8, ge=0.0, le=1.0)
    min_rain_mm: float = Field(4.0, ge=0.0, le=50.0)


class ZonesRequest(AnalysisRequest):
    """Management zones from a vegetation index raster."""

    n_zones: int = Field(3, ge=2, le=8)
    spatial_weight: float = Field(0.35, ge=0.0, le=2.0)
    max_pixels: Optional[int] = Field(250_000, ge=1024, le=4_000_000)


class PrescriptionRequest(BaseModel):
    """Variable-rate plan built from a zone table."""

    zones: List[Dict[str, Any]] = Field(..., min_length=1, max_length=64)
    product: str = Field("nitrogen", max_length=60)
    base_rate: float = Field(..., gt=0, le=100_000)
    target_index: float = Field(..., description="Index value the field is managed towards")
    rate_unit: str = Field("kg/ha", max_length=20)
    min_rate: Optional[float] = Field(None, gt=0)
    max_rate: Optional[float] = Field(None, gt=0)
    response_per_index: float = Field(1.0, ge=-5.0, le=5.0)


class CarbonScreenRequest(BaseModel):
    """Practice screen for a soil-carbon trajectory (screening only)."""

    index_values: List[float] = Field(..., min_length=1, max_length=2_000_000)
    crop: str = "generic"
    tillage: str = Field("unknown", max_length=30)
    cover_crop: bool = False
    residue_retained: bool = True
    years_in_practice: float = Field(3.0, ge=0.0, le=50.0)


class YieldForecastRequest(BaseModel):
    """Empirical index-integral yield estimate."""

    index_series: List[float] = Field(..., min_length=1, max_length=2000)
    crop: str = "generic"
    coefficient: float = Field(0.0, description="Fitted slope; 0 returns a calibration request instead of a tonnage")
    intercept: float = 0.0
    calibration: Optional[Dict[str, Any]] = None


class DiseaseRiskRequest(BaseModel):
    """Weather favourability for the main foliar diseases of a crop."""

    tmin: List[float] = Field(..., min_length=1, max_length=2000)
    tmax: List[float] = Field(..., min_length=1, max_length=2000)
    humidity: List[float] = Field(..., min_length=1, max_length=2000)
    crop: str = "generic"
    leaf_wetness_hours: Optional[List[float]] = None
    rainfall: Optional[List[float]] = None


class AgronomyFieldRequest(AnalysisRequest):
    """Agronomy models that run a raster through the standard field pipeline."""

    crop: str = "generic"
    soil: str = "generic"
    et0_daily: Optional[List[float]] = Field(None, description="Optional daily ET0 to pair with the index series")
    rainfall_daily: Optional[List[float]] = Field(None, description="Optional daily rainfall for the same window")


class TimeseriesRequest(BaseModel):
    observations: List[ObservationInput] = Field(default_factory=list, max_length=200)
    csv: Optional[str] = Field(None, description="CSV file name in data/raw with date and ndvi columns")
    index: str = "NDVI"
    dataset: Optional[str] = Field(None, description="Dataset to analyse for observations without stats")
    aoi: Optional[str] = None
    change_threshold: float = Field(0.05, ge=0.0, le=1.0)
    include_chart: bool = True
    use_cache: bool = True


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def _relative(path: Path) -> str:
    """A path relative to the project root (never leaks absolute filesystem paths)."""
    try:
        return str(Path(path).resolve().relative_to(project_paths()["root"]))
    except ValueError:
        return Path(path).name


def _resolve_aoi(name: str | None) -> Dict[str, Any] | None:
    if not name:
        return None
    return load_aoi(resolve_dataset(name))


def _thresholds(request: AnalysisRequest) -> Dict[str, float]:
    override = request.thresholds.merged() if request.thresholds else None
    return override or health_thresholds()


def _prepare_stack(
    dataset_path: Path,
    aoi: Mapping[str, Any] | None,
    band_map: Mapping[str, int],
    max_pixels: int | None,
    use_raster_footprint: bool = True,
) -> Dict[str, Any]:
    """Clip + extract bands, falling back to whole-array reads for non-georeferenced rasters."""
    metadata = get_raster_metadata(dataset_path)
    georeferenced = bool(metadata["crs"]["defined"]) and metadata["is_georeferenced"]
    warnings: List[str] = []
    bands = sorted(set(int(value) for value in band_map.values()))
    aoi_gdf = None
    aoi_is_raster_extent = False

    if georeferenced and aoi is None and use_raster_footprint:
        # No AOI was given: use the raster extent itself as the analysis boundary
        # so areas, zones and map overlays stay georeferenced.
        import geopandas as gpd
        from shapely.geometry import box

        bounds = metadata["bounds"]
        active_crs = geospatial.get_crs(dataset_path)
        aoi_gdf = gpd.GeoDataFrame(
            {"name": ["raster_extent"]},
            geometry=[box(bounds["left"], bounds["bottom"], bounds["right"], bounds["top"])],
            crs=active_crs,
        )
        aoi = {
            "gdf": aoi_gdf,
            "name": None,
            "area_ha": metadata.get("area_ha"),
            "feature_count": 1,
            "geojson": None,
        }
        aoi_is_raster_extent = True
        warnings.append(
            "No AOI was supplied, so the full raster extent was used as the analysis boundary. "
            "Provide a field boundary for field-level numbers."
        )

    if georeferenced and aoi is not None:
        overlap = geospatial.raster_aoi_overlap(aoi["gdf"], metadata, geospatial.get_crs(dataset_path))
        warnings.extend(overlap["warnings"])
        clipped = geospatial.clip_raster_to_aoi(dataset_path, aoi["gdf"], bands=bands, max_pixels=max_pixels)
        stack = preprocessing.band_stack(clipped, band_map)
        aoi_gdf = geospatial.reproject_aoi(aoi["gdf"], stack["crs"])
        stack.update(
            {
                "georeferenced": True,
                "overlap_fraction": overlap["overlap_fraction"],
                "clip_bounds": clipped["clip_bounds"],
                "clip_bounds_lonlat": clipped["clip_bounds_lonlat"],
                "window": clipped["window"],
                "decimation": clipped["decimation"],
                "decimated": clipped["decimated"],
                "source_shape": clipped["source_shape"],
                "aoi_mask": clipped["mask"],
                "aoi_coverage_pct": round(float(np.asarray(clipped["mask"]).mean() * 100), 3),
                "aoi_feature_count": clipped["aoi_feature_count"],
            }
        )
        return {
            "stack": stack,
            "warnings": warnings,
            "metadata": metadata,
            "georeferenced": True,
            "clip": clipped,
            "aoi_gdf": aoi_gdf,
            "aoi_is_raster_extent": aoi_is_raster_extent,
        }

    if aoi is not None and not georeferenced:
        warnings.append("Raster has no CRS: the AOI mask was skipped and the whole raster was analysed.")

    loaded = preprocessing.load_and_prepare(str(dataset_path), bands=bands, max_pixels=int(max_pixels or 0) or 4_000_000)
    array = np.asarray(loaded["array"])
    if array.ndim == 2:
        array = array[np.newaxis, :, :]
    nodata = loaded.get("nodata")
    valid = np.ones(array.shape[1:], dtype=bool)
    for index_position in range(array.shape[0]):
        valid &= preprocessing.build_valid_mask(array[index_position], nodata)
    stack = {
        "bands": {label: array[list(loaded["bands"]).index(number)] for label, number in band_map.items()},
        "valid_mask": valid,
        "transform": None,
        "crs": None,
        "shape": (array.shape[1], array.shape[2]),
        "nodata": nodata,
        "pixel_area_ha": None,
        "decimation": loaded.get("decimation", 1.0),
        "decimated": bool(loaded.get("decimated")),
        "source_shape": loaded.get("shape"),
        "source": dataset_path.name,
        "georeferenced": False,
        "aoi_mask": None,
        "aoi_coverage_pct": None,
        "clip_bounds": None,
        "clip_bounds_lonlat": None,
        "window": None,
        "aoi_feature_count": 0,
        "overlap_fraction": None,
    }
    return {
        "stack": stack,
        "warnings": warnings,
        "metadata": metadata,
        "georeferenced": False,
        "clip": None,
        "aoi_gdf": None,
        "aoi_is_raster_extent": False,
    }


def _analyze_field(
    request: AnalysisRequest,
    *,
    kind: str = "ndvi",
    title: str | None = None,
    force: bool = False,
) -> Dict[str, Any]:
    """The core field-analysis pipeline used by /ndvi and /crop-health."""
    ensure_directories()
    index_name = indices.normalise_index_name(request.index)
    thresholds = _thresholds(request)
    index_spec = indices.INDEX_REGISTRY[index_name]
    required = index_spec["bands"]

    dataset_path = resolve_dataset(request.dataset)
    validation = validate_raster(dataset_path)
    metadata = validation["metadata"]
    warnings: List[str] = list(validation["warnings"])

    aoi = _resolve_aoi(request.aoi)

    band_resolution = indices.resolve_band_map(metadata, request.band_map.as_map() if request.band_map else None)
    missing = [band for band in required if band not in band_resolution["bands"]]
    if missing:
        raise RasterError(
            f"{index_name} needs the band(s) {', '.join(required)} but the raster provides "
            f"{', '.join(band_resolution['bands'].keys()) or 'no usable bands'}. "
            "Pass an explicit band_map (red=3, nir=4, ...) or add band descriptions to the GeoTIFF."
        )

    cache_key = build_analysis_key(
        kind=kind,
        dataset=metadata["name"],
        size=metadata.get("file_size_mb"),
        aoi=aoi["name"] if aoi else None,
        index=index_name,
        bands={band: band_resolution["bands"][band] for band in required},
        thresholds=thresholds,
        weak=request.weak_threshold,
        min_patch=request.min_patch_area_ha,
        max_pixels=request.max_pixels,
        visuals=request.include_visuals,
        synthetic=metadata["synthetic"],
    )
    if request.use_cache and not force:
        cached = find_cached(cache_key)
        if cached:
            return {**cached["payload"], "result_id": cached["id"], "cached": True, "assets": cached["assets"]}

    prepared = _prepare_stack(dataset_path, aoi, {band: band_resolution["bands"][band] for band in required}, request.max_pixels)
    stack = prepared["stack"]
    warnings.extend(prepared["warnings"])
    if band_resolution["assumption_warning"]:
        warnings.append(
            "Band order was assumed from configuration (no band descriptions found). "
            "Verify the mapping before trusting the absolute values."
        )

    valid = np.asarray(stack["valid_mask"], dtype=bool)
    if not valid.any():
        raise DataError("No valid pixels inside the analysed window (everything is nodata or outside the AOI)")

    computed = indices.compute_index(index_name, stack["bands"], valid=valid)
    index_array = np.asarray(computed["array"], dtype="float32")
    statistics = indices.index_statistics(index_array, valid=valid)

    pixel_area_ha = stack.get("pixel_area_ha")
    field_area_ha = aoi["area_ha"] if aoi else metadata.get("area_ha")
    aoi_gdf = prepared.get("aoi_gdf")
    classes = analysis.classify_health(index_array, thresholds=thresholds, valid=valid)
    health = analysis.health_statistics(classes, pixel_area_ha=pixel_area_ha, thresholds=thresholds, field_area_ha=field_area_ha)

    zones: Dict[str, Any] = {"zones": {}, "zone_count": {}, "total_zones": 0, "feature_collection": {"type": "FeatureCollection", "features": []}}
    if prepared["georeferenced"]:
        zones = analysis.health_zones(classes, stack["transform"], stack["crs"], min_area_ha=request.min_patch_area_ha, pixel_area_ha=pixel_area_ha)
        zones["feature_collection"] = geospatial.zones_feature_collection(
            [zone for group in zones["zones"].values() for zone in group], zone_key="label"
        )
        zones["feature_collection"]["properties"] = {"source": f"{index_name} crop health classes", "zone_count": zones["total_zones"]}

    weak = analysis.detect_weak_vegetation(
        index_array,
        stack["transform"] if prepared["georeferenced"] else None,
        stack["crs"] if prepared["georeferenced"] else None,
        thresholds=thresholds,
        valid=valid,
        weak_threshold=request.weak_threshold,
        min_area_ha=request.min_patch_area_ha,
        pixel_area_ha=pixel_area_ha,
    )
    anomalies = analysis.detect_anomalies(index_array, valid=valid, method=request.anomaly_method)

    if metadata["synthetic"]:
        warnings.append(
            "This dataset is a labelled synthetic demonstration scene, not real satellite or drone imagery."
        )
    if stack.get("decimated"):
        warnings.append(
            f"Raster window was decimated by 1/{stack.get('decimation')} (using overviews where available) "
            "to respect the analysis pixel budget; per-pixel extremes are smoothed."
        )

    summary = analysis.field_summary(
        index_name=index_name,
        statistics=statistics,
        health=health,
        weak_vegetation=weak,
        anomalies=anomalies,
        field_area_ha=field_area_ha,
        analysed_area_ha=health.get("analysed_area_ha"),
        thresholds=thresholds,
    )
    summary["largest_patch_ha"] = weak.get("largest_patch_ha")
    interpretation = analysis.interpret(summary)

    observation_date = request.observation_date or metadata["tags"].get("ACQUIRED") or datetime.now(timezone.utc).date().isoformat()

    record = create_result(
        kind,
        title=title or f"{index_name} analysis - {metadata['name']}",
        dataset=metadata["name"],
        aoi=aoi["name"] if aoi else None,
        params={
            "index": index_name,
            "band_map": {band: band_resolution["bands"][band] for band in required},
            "thresholds": thresholds,
            "weak_threshold": weak["threshold"],
            "max_pixels": request.max_pixels,
            "aoi": aoi["name"] if aoi else None,
        },
        cache_key=cache_key,
    )
    output_dir = result_directory(record["id"], create=True)

    rgb = None
    if prepared["georeferenced"] or metadata["band_count"] >= 3:
        available = {label: stack["bands"].get(label) for label in ("red", "green", "blue")}
        if all(value is not None for value in available.values()):
            rgb = preprocessing.composite_rgb(available, valid)

    assets: Dict[str, Dict[str, Any]] = {}
    if request.include_visuals:
        assets = visualization.render_result_bundle(
            output_dir,
            rgb=rgb,
            index_array=index_array,
            classes=classes,
            weak_mask=weak["mask"] if weak["mask"].any() else None,
            weak_threshold=weak["threshold"],
            weak_patch_count=weak["patch_count"],
            statistics=statistics,
            health=health,
            transform=stack["transform"],
            crs=stack["crs"],
            aoi_gdf=aoi_gdf,
            bounds=stack.get("clip_bounds"),
            valid=valid,
            index_name=index_name,
            dataset_label=metadata["name"],
            extra_caption=(
                f"AOI {aoi['name']} · {statistics['valid_pixels']} valid pixels"
                if aoi
                else f"whole raster extent · {statistics['valid_pixels']} valid pixels"
            ),
        )

    for key, item in assets.items():
        add_asset(
            record,
            item["path"],
            name=key,
            kind="overlay" if item.get("kind") == "overlay" else item.get("kind", "image"),
            label=item.get("label", key),
            bounds_lonlat=item.get("bounds_lonlat"),
            extra={"map_key": key},
        )

    processed_raster = save_processed_raster(
        index_array,
        stack["transform"] if prepared["georeferenced"] else None,
        stack["crs"] if prepared["georeferenced"] else None,
        f"{index_name.lower()}_{Path(metadata['name']).stem}_{record['id']}.tif",
        nodata=-9999.0,
    ) if prepared["georeferenced"] else None

    payload = {
        "result_id": record["id"],
        "kind": kind,
        "cached": False,
        "index": index_name,
        "index_label": index_spec["label"],
        "dataset": metadata["name"],
        "aoi": aoi["name"] if aoi else ("raster_extent" if prepared["aoi_is_raster_extent"] else None),
        "aoi_is_raster_extent": bool(prepared["aoi_is_raster_extent"]),
        "observation_date": observation_date,
        "raster": {
            "band_count": metadata["band_count"],
            "band_descriptions": metadata["band_descriptions"],
            "crs": metadata["crs"],
            "shape": [metadata["height"], metadata["width"]],
            "resolution": metadata["resolution"],
            "nodata": metadata["nodata"],
            "synthetic": metadata["synthetic"],
            "bounds_lonlat": metadata["bounds_lonlat"],
            "area_ha": metadata["area_ha"],
            "file_size_mb": metadata["file_size_mb"],
        },
        "band_resolution": {
            "bands": {band: band_resolution["bands"][band] for band in required},
            "bands_used": computed["bands_used"],
            "method": band_resolution["method"],
            "notes": band_resolution["notes"],
            "assumption_warning": band_resolution["assumption_warning"],
            "band_descriptions": metadata["band_descriptions"],
        },
        "clip": {
            "shape": list(stack["shape"]),
            "source_shape": list(stack.get("source_shape") or stack["shape"]),
            "decimated": stack.get("decimated", False),
            "decimation": stack.get("decimation", 1.0),
            "window": list(stack["window"]) if stack.get("window") else None,
            "pixel_area_ha": pixel_area_ha,
            "aoi_coverage_pct": stack.get("aoi_coverage_pct"),
            "overlap_fraction": stack.get("overlap_fraction"),
            "georeferenced": prepared["georeferenced"],
            "bounds_native": stack.get("clip_bounds"),
            "bounds_lonlat": stack.get("clip_bounds_lonlat"),
        },
        "statistics": statistics,
        "health": health,
        "zones": {
            "zone_count": zones.get("zone_count", {}),
            "total_zones": zones.get("total_zones", 0),
            "min_area_ha": zones.get("min_area_ha"),
            "feature_collection": zones.get("feature_collection"),
        },
        "weak_vegetation": {
            key: value
            for key, value in weak.items()
            if key not in {"mask", "raw_mask"}
        },
        "anomalies": {
            key: value for key, value in anomalies.items() if key not in {"low_mask", "high_mask"}
        },
        "field": summary,
        "interpretation": interpretation,
        "assets": record["assets"],
        "asset_keys": sorted(assets.keys()),
        "processed_raster": _relative(processed_raster) if processed_raster else None,
        "aoi_geojson": aoi["geojson"] if aoi else None,
        "warnings": warnings,
        "disclaimer": DISCLAIMER,
        "config": {"thresholds": thresholds, "max_analysis_pixels": request.max_pixels},
    }

    record["payload"] = jsonable(payload)
    record["summary"] = {
        "index": index_name,
        "mean": statistics.get("mean"),
        "healthy_pct": health.get("healthy_pct"),
        "weak_pct": health.get("weak_pct"),
        "analysed_area_ha": health.get("analysed_area_ha"),
        "vigour_score": summary.get("vigour_score"),
        "dataset": metadata["name"],
        "aoi": aoi["name"] if aoi else ("raster_extent" if prepared["aoi_is_raster_extent"] else None),
        "observation_date": observation_date,
    }
    record["warnings"] = warnings
    record["observation_date"] = observation_date
    save_result(record)
    return jsonable(payload)


# --------------------------------------------------------------------------- #
# service endpoints
# --------------------------------------------------------------------------- #
@router.get("/health", summary="Service status and capabilities")
def health() -> Dict[str, Any]:
    info = project_info()
    return {
        "status": "ok",
        "service": info["name"],
        "version": info["version"],
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "capabilities": {
            "indices": list(indices.INDEX_REGISTRY.keys()),
            "opencv": bool(info["opencv_enabled"]),
            "visualization": bool(info["visualization_enabled"]),
            "segmentation_methods": list(segmentation.CLASSICAL_METHODS.keys()),
            "timeseries": True,
            "agronomy": [entry["id"] for entry in agronomy.model_catalogue()],
            "satellite": satellite.status(),
        },
        "inspiration": info["inspiration"],
    }


@router.get("/project", summary="Project descriptor")
def project() -> Dict[str, Any]:
    paths = project_paths()
    datasets = list_datasets()
    results = list_results(limit=None)
    return {
        **project_info(),
        "paths": {
            "raw_data": "data/raw",
            "processed_data": "data/processed",
            "outputs": "outputs",
        },
        "storage": {
            "raw_files": len(datasets),
            "results": len(results),
            "outputs_dir": paths["outputs"].name,
        },
        "datasets_by_type": {
            kind_type: len([entry for entry in datasets if entry["type"] == kind_type])
            for kind_type in ("raster", "vector", "table", "image")
        },
    }


@router.get("/config", summary="Thresholds, indices and available operations")
def config_endpoint() -> Dict[str, Any]:
    return {
        "analysis": {
            "default_index": "NDVI",
            "indices": indices.available_indices(),
            "band_tokens": indices.BAND_TOKENS,
        },
        "crop_health": {
            "thresholds": health_thresholds(),
            "classes": analysis.HEALTH_CLASSES,
            "note": "Thresholds are configurable in config.yaml or per request (thresholds override).",
        },
        "opencv": {
            "operations": cv.available_operations(),
            "presets": [
                {"key": "clean_binary", "label": "Threshold + morphology + contours", "operations": ["grayscale", "denoise", "blur", "otsu", "morph_open", "morph_close"]},
                {"key": "edges", "label": "Denoise + edge detection", "operations": ["grayscale", "denoise", "edges"]},
                {"key": "enhance", "label": "Denoise + CLAHE enhancement", "operations": ["denoise", "enhance"]},
                {"key": "veg_mask", "label": "Vegetation mask from a band", "operations": ["grayscale", "blur", "otsu", "morph_open", "morph_close", "remove_small_objects"]},
            ],
        },
        "segmentation": segmentation.available_methods(),
        "visualization": {"charts": visualization.available_charts()},
        "disclaimer": DISCLAIMER,
    }


@router.get("/dashboard", summary="Aggregate metrics for the dashboard")
def dashboard() -> Dict[str, Any]:
    results = list_results(limit=None)
    analysis_results = [record for record in results if record["kind"] in {"ndvi", "crop_health"}]
    means = [record["summary"].get("mean") for record in analysis_results if record.get("summary", {}).get("mean") is not None]
    healthy = [record["summary"].get("healthy_pct") for record in analysis_results if record.get("summary", {}).get("healthy_pct") is not None]
    weak = [record["summary"].get("weak_pct") for record in analysis_results if record.get("summary", {}).get("weak_pct") is not None]
    areas = [record["summary"].get("analysed_area_ha") or 0.0 for record in analysis_results]
    datasets = list_datasets()
    fields = [entry for entry in datasets if entry["type"] == "vector"]
    analysed_datasets = {record.get("dataset") for record in analysis_results if record.get("dataset")}

    return {
        "totals": {
            "fields_available": len(fields),
            "rasters_available": len([entry for entry in datasets if entry["type"] == "raster"]),
            "analysed_fields": len(analysed_datasets),
            "analyses": len(analysis_results),
            "results": len(results),
            "analysed_area_ha": round(float(sum(areas)), 2),
        },
        "index": {
            "mean_ndvi": round(float(np.mean(means)), 4) if means else None,
            "mean_healthy_pct": round(float(np.mean(healthy)), 2) if healthy else None,
            "mean_weak_pct": round(float(np.mean(weak)), 2) if weak else None,
            "series": [
                {
                    "id": record["id"],
                    "date": (record.get("summary", {}) or {}).get("observation_date") or (record.get("created_at") or "")[:10],
                    "mean": (record.get("summary", {}) or {}).get("mean"),
                    "healthy_pct": (record.get("summary", {}) or {}).get("healthy_pct"),
                    "dataset": record.get("dataset"),
                }
                for record in analysis_results[:40]
            ][::-1],
        },
        "activity": results[:12],
        "datasets": datasets[:24],
        "by_kind": stats_summary(results)["by_kind"],
        "thresholds": health_thresholds(),
    }


# --------------------------------------------------------------------------- #
# datasets
# --------------------------------------------------------------------------- #
@router.get("/datasets", summary="List datasets in data/raw")
def datasets(kind: Optional[str] = Query(None, description="raster | vector | table | image")) -> Dict[str, Any]:
    entries = list_datasets()
    if kind:
        entries = [entry for entry in entries if entry["type"] == kind]
    return {"count": len(entries), "datasets": entries}


@router.get("/datasets/{name}", summary="Dataset metadata and validation")
def dataset_detail(name: str) -> Dict[str, Any]:
    path = resolve_dataset(name)
    detail = load_dataset(path)
    payload = {key: value for key, value in detail.items() if key != "geojson"}
    payload["relative_path"] = _relative(path)
    if detail["type"] == "raster":
        metadata = detail["metadata"]
        payload["band_resolution"] = indices.resolve_band_map(metadata)
        payload["footprint"] = geospatial.raster_footprint(path)
    if detail.get("geojson"):
        payload["geojson"] = detail["geojson"]
    return jsonable(payload)


@router.get("/datasets/{name}/preview", summary="PNG preview of a raster", response_class=Response)
def dataset_preview(name: str, band: Optional[int] = Query(None, ge=1), max_size: int = Query(900, ge=64, le=3000)) -> Response:
    path = resolve_dataset(name)
    metadata = get_raster_metadata(path)
    if metadata["band_count"] >= 3:
        band_map = indices.resolve_band_map(metadata)["bands"]
        needed = [value for value in (band_map.get("red"), band_map.get("green"), band_map.get("blue")) if value]
        if len(needed) == 3:
            loaded = preprocessing.load_raster(str(path), bands=needed)
            stack = {"red": loaded["array"][0], "green": loaded["array"][1], "blue": loaded["array"][2]}
            preview = preprocessing.composite_rgb(stack)
        else:
            preview = _grayscale_preview(path, band or 1)
    else:
        preview = _grayscale_preview(path, band or 1)
    preview = cv.resize_image(preview, width=max_size) if max(preview.shape[:2]) > max_size else preview
    return Response(content=cv.encode_png(preview), media_type="image/png", headers={"Cache-Control": "max-age=60"})


def _grayscale_preview(path: Path, band: int) -> np.ndarray:
    loaded = preprocessing.load_raster(str(path), bands=[band])
    return cv.to_display(preprocessing.single_band_preview(loaded["array"][0]))


@router.get("/datasets/{name}/footprint", summary="Raster extent as GeoJSON")
def dataset_footprint(name: str) -> Dict[str, Any]:
    path = resolve_dataset(name)
    metadata = get_raster_metadata(path)
    footprint = geospatial.raster_footprint(path)
    return jsonable(
        {
            "dataset": metadata["name"],
            "type": "Feature",
            "geometry": footprint["geometry_geojson"],
            "properties": {
                "bounds": footprint["bounds"],
                "bounds_lonlat": footprint["bounds_lonlat"],
                "crs": footprint["crs"]["name"],
                "epsg": footprint["crs"]["epsg"],
            },
        }
    )


# --------------------------------------------------------------------------- #
# AOI
# --------------------------------------------------------------------------- #
@router.get("/aoi", summary="List field boundaries available in data/raw")
def aoi_list() -> Dict[str, Any]:
    entries = [entry for entry in list_datasets() if entry["type"] == "vector"]
    return {"count": len(entries), "aois": entries}


@router.get("/aoi/{name}", summary="AOI geometry, area and CRS")
def aoi_detail(name: str) -> Dict[str, Any]:
    aoi = load_aoi(resolve_dataset(name))
    return jsonable(
        {
            "name": aoi["name"],
            "feature_count": aoi["feature_count"],
            "area_ha": aoi["area_ha"],
            "crs": aoi["crs"],
            "warnings": aoi["warnings"],
            "geojson": aoi["geojson"],
        }
    )


@router.post("/aoi", summary="Validate an AOI (optionally store it)", status_code=status.HTTP_200_OK)
def aoi_create(request: AoiRequest) -> Dict[str, Any]:
    if request.name:
        aoi = load_aoi(resolve_dataset(request.name))
        aoi["source"] = "file"
    elif request.geojson:
        aoi = load_geojson(request.geojson)
        aoi["source"] = "inline"
    else:
        raise AOIError("Provide either 'name' (a GeoJSON file in data/raw) or an inline 'geojson' payload")

    stored = None
    if request.save_as:
        stored = save_aoi(aoi["gdf"], request.save_as)
    elif request.source == "inline":
        stored = save_aoi(aoi["gdf"], "uploaded_aoi.geojson")

    return jsonable(
        {
            "name": stored["name"] if stored else aoi.get("name"),
            "stored": bool(stored),
            "feature_count": aoi["feature_count"],
            "area_ha": aoi["area_ha"],
            "crs": aoi["crs"],
            "bounds": [float(value) for value in aoi["gdf"].to_crs("EPSG:4326").total_bounds],
            "warnings": aoi["warnings"],
            "geojson": aoi["geojson"],
            "source": aoi.get("source"),
        }
    )


# --------------------------------------------------------------------------- #
# OpenStreetMap (place search, reverse geocoding, map features)
# --------------------------------------------------------------------------- #
# All three go through ``osm``, which is the only module that talks to a
# third-party host. It enforces the Nominatim per-second policy, caches replies
# and reports the attribution the map has to carry.
@router.get("/geo/status", summary="OpenStreetMap providers, policy limits and attribution")
def geo_status() -> Dict[str, Any]:
    return osm.status()


@router.get("/geo/search", summary="Search a real place, address or postcode (Nominatim)")
def geo_search(
    # Only the outer bound is enforced by FastAPI: a too-short query is rejected
    # by the provider module, whose message says what to do about it.
    q: str = Query(..., min_length=1, max_length=200, description="Place, address, postcode or landmark"),
    limit: int = Query(0, ge=0, le=20, description="0 uses the configured default"),
    country: Optional[str] = Query(None, max_length=60, description="Comma-separated ISO country codes, e.g. nl,de"),
) -> Dict[str, Any]:
    return osm.search_places(q, limit=limit or None, country_codes=country)


@router.get("/geo/reverse", summary="Name the place at a coordinate (Nominatim)")
def geo_reverse(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    zoom: int = Query(18, ge=3, le=18, description="Lower zoom resolves a coarser area (a country at 3, a building at 18)"),
) -> Dict[str, Any]:
    return osm.reverse_geocode(lat, lon, zoom=zoom)


@router.get("/geo/features", summary="Real OSM features near a point as GeoJSON (Overpass)")
def geo_features(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_m: float = Query(1000, gt=0, description="Search radius in metres (capped in configuration)"),
    kinds: Optional[str] = Query(None, description="Comma-separated feature classes; omit for the defaults"),
    limit: int = Query(0, ge=0, le=2000, description="0 uses the configured default"),
) -> Dict[str, Any]:
    return osm.features_near(lat, lon, radius_m=radius_m, kinds=kinds, limit=limit or None)


@router.post("/geo/aoi-from-point", summary="Build a real field boundary around a picked location")
def geo_aoi_from_point(request: GeoFieldRequest) -> Dict[str, Any]:
    """Turn a map click into an AOI the analysis endpoints can actually use.

    The polygon is laid out in the local UTM zone (see ``geospatial.polygon_around_point``)
    so the stored area matches the requested size, then it goes through exactly
    the same validation as an uploaded boundary.
    """
    size_m = request.size_m or math.sqrt((request.area_ha or 0.0) * 10_000.0)
    drawn = geospatial.polygon_around_point(request.lat, request.lon, size_m, request.shape)
    feature = {
        "type": "Feature",
        "geometry": drawn["geometry"],
        "properties": {
            "name": request.label or "picked field",
            "source": "openstreetmap-pick",
            "place": request.place or "",
            "size_m": round(size_m, 2),
            "shape": request.shape,
            "utm_crs": f"EPSG:{drawn['epsg']}",
        },
    }
    collection = {"type": "FeatureCollection", "features": [feature]}
    aoi = load_geojson(collection)
    stored = save_aoi(aoi["gdf"], request.name) if request.save else None

    return jsonable(
        {
            "name": stored["name"] if stored else None,
            "stored": bool(stored),
            "feature_count": aoi["feature_count"],
            "area_ha": aoi["area_ha"],
            "requested_area_ha": round((size_m * size_m) / 10_000.0, 4),
            "crs": aoi["crs"],
            "bounds": [float(value) for value in aoi["gdf"].to_crs("EPSG:4326").total_bounds],
            "center": drawn["center"],
            "shape": request.shape,
            "size_m": drawn["size_m"],
            "utm_crs": f"EPSG:{drawn['epsg']}",
            "place": request.place or "",
            "warnings": aoi["warnings"],
            "geojson": aoi["geojson"],
            "source": "openstreetmap-pick",
            "attribution": osm.ATTRIBUTION,
            "note": (
                "Boundary generated around a coordinate picked from the OpenStreetMap basemap. "
                "It is a regular shape, not a surveyed field edge - replace it with a real GeoJSON "
                "boundary (or an OSM feature) before using the numbers as an official area."
            ),
        }
    )


# --------------------------------------------------------------------------- #
# real satellite imagery (STAC discovery + COG band reads)
# --------------------------------------------------------------------------- #
# ``satellite`` is the only other module that reaches a third-party host. It
# finds real acquisitions through a STAC catalogue and reads the actual band
# files over HTTPS range requests, so a request for a 1 km field transfers a few
# hundred kilobytes rather than the whole 160 MB scene. What it writes is an
# ordinary GeoTIFF in ``data/raw``: every analysis endpoint already works on it.
@router.get("/satellite/catalogue", summary="Real satellite collections, bands, licences and read limits")
def satellite_catalogue() -> Dict[str, Any]:
    return satellite.catalogue()


@router.get("/satellite/scenes", summary="Find real acquisitions over a field (STAC) - least cloudy first")
def satellite_scenes(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_m: Optional[float] = Query(None, gt=0, description="Half-width of the field window in metres"),
    days: Optional[int] = Query(None, ge=1, le=365, description="How far back to look"),
    max_cloud: Optional[float] = Query(None, ge=0, le=100, description="Maximum scene cloud cover (percent)"),
    limit: Optional[int] = Query(None, ge=1, le=100, description="Maximum scenes to return"),
    collection: Optional[str] = Query(None, max_length=60, description="Catalogue key; defaults to the configured collection"),
) -> Dict[str, Any]:
    return jsonable(
        satellite.search_scenes(
            lat, lon, radius_m=radius_m, days=days, max_cloud=max_cloud, limit=limit, collection=collection
        )
    )


@router.post(
    "/satellite/fetch",
    summary="Download a real scene window into data/raw and register it as a dataset",
    status_code=status.HTTP_201_CREATED,
)
def satellite_fetch(request: SatelliteFetchRequest) -> Dict[str, Any]:
    """Fetch real band pixels, write them as a GeoTIFF and hand back the dataset name.

    The stored file carries true reflectance with cloud pixels set to nodata, so
    ``POST /api/ndvi`` (or any other analysis) accepts it exactly like an upload.
    """
    payload = satellite.fetch_scene(
        request.lat,
        request.lon,
        radius_m=request.radius_m,
        scene_id=request.scene_id,
        collection=request.collection,
        days=request.days,
        max_cloud=request.max_cloud,
        mask_clouds=request.mask_clouds,
        bands=request.bands,
        force=request.force,
    )
    payload["dataset_detail"] = {
        "name": payload["dataset"],
        "type": "raster",
        "band_count": len(payload.get("bands") or []),
        "band_descriptions": payload.get("bands"),
        "epsg": str(payload.get("crs") or "").replace("EPSG:", ""),
        "shape": payload.get("shape"),
        "synthetic": False,
    }
    payload["next"] = {
        "analyse": {
            "method": "POST",
            "path": "/api/ndvi",
            "body": {"dataset": payload["dataset"], "index": "NDVI"},
        },
        "note": (
            "This is a real Copernicus acquisition. The file is already validated, so any analysis "
            "endpoint accepts it by name - no upload step is needed. Attribution is carried in the "
            "GeoTIFF tags and repeated in 'provenance'."
        ),
    }
    return jsonable(payload)


# --------------------------------------------------------------------------- #
# real weather (any date, plus an independent second opinion)
# --------------------------------------------------------------------------- #
# Keyless and server-side: a reanalysis archive (ERA5/ERA5-Land) for any past
# date back to 1940, the forecast for today and the days ahead, and NASA POWER
# to challenge either. Each day in a response names the source that answered it
# and whether it is provisional, and a day nobody reports stays null.
@router.get("/weather/catalogue", summary="Real weather providers, coverage, licences and limits")
def weather_catalogue() -> Dict[str, Any]:
    return weather.catalogue()


@router.get("/weather/current", summary="Live conditions at a point, with today's totals")
def weather_current(
    lat: float = Query(..., ge=-90, le=90, description="Latitude (WGS84)"),
    lon: float = Query(..., ge=-180, le=180, description="Longitude (WGS84)"),
) -> Dict[str, Any]:
    return jsonable(weather.current(lat, lon))


@router.get("/weather/daily", summary="Daily weather for any date or window, 1940 to the forecast horizon")
def weather_daily(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    start: Optional[str] = Query(None, description="ISO date (YYYY-MM-DD); defaults to 6 days ago"),
    end: Optional[str] = Query(None, description="ISO date (YYYY-MM-DD); defaults to today"),
    cross_check: bool = Query(False, description="Also fetch NASA POWER for the same days"),
) -> Dict[str, Any]:
    return jsonable(weather.daily(lat, lon, start, end, cross_check=cross_check))


@router.get("/weather/crosscheck", summary="The same days from a second, independent model (ERA5 vs MERRA-2)")
def weather_crosscheck(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    start: str = Query(..., description="ISO date (YYYY-MM-DD)"),
    end: Optional[str] = Query(None, description="ISO date (YYYY-MM-DD); defaults to start"),
) -> Dict[str, Any]:
    return jsonable(weather.cross_check_daily(lat, lon, start, end or start))


@router.post("/weather/for-dates", summary="Weather on specific dates - the weather behind each acquisition")
def weather_for_dates(request: WeatherDatesRequest) -> Dict[str, Any]:
    """One record per requested date, so an image can be read in context.

    A satellite acquisition is a single moment, and whether the field was
    waterlogged, heat-stressed or simply mid-season is a question only the
    weather on that day can answer. A date no provider reports is returned in
    ``missing`` rather than interpolated.
    """
    return jsonable(weather.for_dates(request.lat, request.lon, request.dates))


# --------------------------------------------------------------------------- #
# uploads
# --------------------------------------------------------------------------- #
@router.post("/upload", summary="Upload a raster, GeoJSON or CSV into data/raw", status_code=status.HTTP_201_CREATED)
async def upload(
    files: List[UploadFile] = File(..., description="One or more GeoTIFF / GeoJSON / CSV files"),
    kind: str = Form("auto", description="auto | raster | vector | table"),
) -> Dict[str, Any]:
    if not files:
        raise DataError("No files were uploaded")
    if len(files) > 12:
        raise DataError("At most 12 files can be uploaded at once")
    saved: List[Dict[str, Any]] = []
    for upload_file in files:
        content = await upload_file.read()
        filename = safe_filename(upload_file.filename or "upload.bin")
        resolved_kind = kind if kind != "auto" else kind_for_filename(filename)
        if resolved_kind == "unknown":
            raise DataError(
                f"Unsupported file type '{Path(filename).suffix}'. Upload GeoTIFF, GeoJSON, CSV, PNG or JPEG."
            )
        saved.append(save_upload(filename, content, kind=resolved_kind))
    return {"uploaded": len(saved), "files": jsonable(saved), "datasets": list_datasets()}


# --------------------------------------------------------------------------- #
# analysis endpoints
# --------------------------------------------------------------------------- #
@router.post("/ndvi", summary="NDVI (or NDRE/EVI/SAVI) field analysis")
def ndvi_endpoint(request: AnalysisRequest) -> Dict[str, Any]:
    payload = _analyze_field(request, kind="ndvi", title=f"{request.index.upper()} analysis - {request.dataset}")
    return JSONResponse(status_code=status.HTTP_200_OK, content=jsonable(payload))


@router.post("/crop-health", summary="Crop-health classification, zones and weak vegetation")
def crop_health_endpoint(request: AnalysisRequest) -> Dict[str, Any]:
    payload = _analyze_field(request, kind="crop_health", title=f"Crop health - {request.dataset}")
    payload["focus"] = "crop_health"
    return JSONResponse(status_code=status.HTTP_200_OK, content=jsonable(payload))


@router.post("/opencv/process", summary="Run an OpenCV pipeline on a raster band or uploaded image")
async def opencv_process(
    dataset: Optional[str] = Form(None, description="Raster in data/raw to process"),
    band: Optional[int] = Form(None, description="1-based band of the dataset"),
    aoi: Optional[str] = Form(None, description="Optional AOI to clip to"),
    operations: Optional[str] = Form(None, description="JSON array of operation names or {name, params} objects"),
    preset: Optional[str] = Form(None, description="Preset key from /api/config"),
    detect_contours_flag: bool = Form(True),
    file: Optional[UploadFile] = File(None, description="Alternatively upload an image (PNG/JPEG/TIFF)"),
    max_size: int = Form(900),
) -> Dict[str, Any]:
    ensure_directories()
    started = time.perf_counter()
    config_data = config_endpoint()
    presets = {entry["key"]: entry for entry in config_data["opencv"]["presets"]}

    image = None
    source: Dict[str, Any] = {}
    georef: Dict[str, Any] = {"transform": None, "crs": None, "bounds": None}

    if file is not None:
        content = await file.read()
        name = safe_filename(file.filename or "upload.png")
        suffix = Path(name).suffix.lower()
        if suffix in (".tif", ".tiff"):
            # GeoTIFF uploads join data/raw so they can be reused and referenced by name.
            dataset = save_upload(name, content, kind="raster")["name"]
            band = band or 1
        else:
            image = _decode_upload(content, suffix)
            source = {"name": name, "kind": "upload"}

    if image is None:
        if not dataset:
            raise DataError("Provide a 'dataset' from data/raw or upload a 'file' to process")
        path = resolve_dataset(dataset)
        metadata = get_raster_metadata(path)
        band_number = band or 1
        if band_number > metadata["band_count"]:
            raise RasterError(f"Band {band_number} requested but '{metadata['name']}' has {metadata['band_count']} band(s)")
        aoi_payload = _resolve_aoi(aoi)
        if aoi_payload is not None and metadata["crs"]["defined"]:
            clipped = geospatial.clip_raster_to_aoi(path, aoi_payload["gdf"], bands=[band_number], max_pixels=None)
            source_array = np.asarray(clipped["array"][0], dtype="float32")
            georef = {"transform": clipped["transform"], "crs": clipped["crs"], "bounds": clipped["clip_bounds"]}
        else:
            loaded = preprocessing.load_raster(str(path), bands=[band_number])
            source_array = np.asarray(loaded["array"][0], dtype="float32")
            georef = {"transform": loaded["transform"], "crs": loaded["crs"], "bounds": None} if loaded["crs"] else {"transform": None, "crs": None, "bounds": None}
        source = {"name": metadata["name"], "kind": "raster", "band": band_number, "band_description": metadata["band_descriptions"][band_number - 1] if metadata["band_descriptions"] else ""}
        image = preprocessing.to_uint8(source_array, preprocessing.build_valid_mask(source_array, metadata["nodata"]))

    operation_list: List[Any]
    if preset:
        if preset not in presets:
            raise DataError(f"Unknown preset '{preset}'. Available: {', '.join(presets)}")
        operation_list = presets[preset]["operations"]
    elif operations:
        try:
            parsed = json.loads(operations)
        except json.JSONDecodeError as exc:
            raise DataError(f"'operations' must be a JSON array: {exc}") from exc
        if isinstance(parsed, str):
            parsed = [parsed]
        if not isinstance(parsed, list):
            raise DataError("'operations' must be a JSON array of operation names or objects")
        operation_list = parsed
    else:
        operation_list = ["grayscale", "denoise", "blur", "otsu", "morph_open", "morph_close"]

    if max(image.shape[:2]) > max_size:
        image = cv.resize_image(image, width=max_size)

    processed = cv.process_image(image, operation_list, detect_contours_flag=detect_contours_flag)
    before_stats = cv.image_statistics(image)
    after_stats = cv.image_statistics(processed["image"])

    record = create_result(
        "opencv",
        title=f"OpenCV processing - {source['name']}",
        dataset=source.get("name"),
        aoi=aoi,
        params={"operations": operation_list, "preset": preset, "band": source.get("band")},
        cache_key=None,
    )
    output_dir = result_directory(record["id"], create=True)
    before_path = visualization.save_rgb_png(cv.to_display(image), output_dir / "before.png")
    after_path = visualization.save_rgb_png(cv.to_display(processed["image"]), output_dir / "after.png")
    side_path = visualization.save_rgb_png(cv.side_by_side(image, processed["image"]), output_dir / "before_after.png")
    if processed["contours"]:
        annotated = cv.annotate_contours(cv.to_display(processed["image"]), processed["contours"])
        annotated_path = visualization.save_rgb_png(annotated, output_dir / "contours_annotated.png")
        add_asset(record, annotated_path, name="contours_annotated", kind="image", label="Detected contours")
    for key, path, label in (
        ("before", before_path, "Before"),
        ("after", after_path, "After"),
        ("before_after", side_path, "Before / after"),
    ):
        add_asset(record, path, name=key, kind="image", label=label)

    payload = {
        "result_id": record["id"],
        "kind": "opencv",
        "source": source,
        "operations": operation_list,
        "steps": processed["steps"],
        "operation_count": processed["operation_count"],
        "output_shape": processed["output_shape"],
        "binary_output": processed["binary"],
        "contours": processed["contours"][:50],
        "contour_count": processed["contour_count"],
        "contour_total_area_pixels": processed["total_contour_area_pixels"],
        "mask_coverage": cv.mask_coverage(processed["image"]) if processed["binary"] else None,
        "statistics": {"before": before_stats, "after": after_stats},
        "duration_ms": round((time.perf_counter() - started) * 1000, 2),
        "georeferencing": {"crs": str(georef["crs"]) if georef["crs"] else None, "bounds": georef["bounds"]},
        "assets": record["assets"],
        "available_operations": config_data["opencv"]["operations"],
        "available_presets": list(presets.values()),
    }
    record["payload"] = jsonable(payload)
    record["summary"] = {"operations": operation_list, "contour_count": processed["contour_count"], "source": source["name"]}
    save_result(record)
    return jsonable(payload)


def _decode_upload(content: bytes, suffix: str) -> np.ndarray:
    allowed = set(security_config().get("allowed_image_ext", []))
    if suffix in allowed and suffix not in {".tif", ".tiff"}:
        import cv2

        array = cv2.imdecode(np.frombuffer(content, dtype="uint8"), cv2.IMREAD_UNCHANGED)
        if array is None:
            raise DataError("Uploaded image could not be decoded")
        if array.ndim == 3 and array.shape[2] == 3:
            array = cv2.cvtColor(array, cv2.COLOR_BGR2RGB)
        elif array.ndim == 3 and array.shape[2] == 4:
            array = cv2.cvtColor(array, cv2.COLOR_BGRA2RGBA)
        return array
    raise DataError("Upload an image (PNG/JPEG) or a GeoTIFF for OpenCV processing")


@router.post("/segmentation", summary="Segment vegetation / soil / zones")
def segmentation_endpoint(request: SegmentationRequest) -> Dict[str, Any]:
    ensure_directories()
    index_name = indices.normalise_index_name(request.index)
    dataset_path = resolve_dataset(request.dataset)
    validation = validate_raster(dataset_path)
    metadata = validation["metadata"]
    warnings = list(validation["warnings"])
    aoi = _resolve_aoi(request.aoi)
    band_resolution = indices.resolve_band_map(metadata, request.band_map.as_map() if request.band_map else None)
    needed = indices.INDEX_REGISTRY[index_name]["bands"]
    missing = [band for band in needed if band not in band_resolution["bands"]]
    if missing:
        raise RasterError(f"{index_name} needs band(s) {', '.join(missing)} which this raster does not provide.")

    prepared = _prepare_stack(dataset_path, aoi, {band: band_resolution["bands"][band] for band in needed}, request.max_pixels)
    stack = prepared["stack"]
    aoi_is_extent = bool(prepared["aoi_is_raster_extent"])
    warnings.extend(prepared["warnings"])
    valid = np.asarray(stack["valid_mask"], dtype=bool)
    computed = indices.compute_index(index_name, stack["bands"], valid=valid)
    index_array = np.asarray(computed["array"], dtype="float32")

    result = segmentation.run_segmentation(
        index_array,
        method=request.method,
        params=request.params,
        transform=stack["transform"] if prepared["georeferenced"] else None,
        crs=stack["crs"] if prepared["georeferenced"] else None,
        valid=valid,
        pixel_area_ha=stack.get("pixel_area_ha"),
        index_name=index_name,
        min_area_ha=request.min_patch_area_ha,
    )

    record = create_result(
        "segmentation",
        title=f"Segmentation ({request.method}) - {metadata['name']}",
        dataset=metadata["name"],
        aoi=aoi["name"] if aoi else None,
        params={"method": request.method, "params": request.params, "index": index_name},
        cache_key=build_analysis_key(kind="segmentation", dataset=metadata["name"], aoi=aoi["name"] if aoi else None, method=request.method, params=request.params, index=index_name),
    )
    output_dir = result_directory(record["id"], create=True)
    mask_path = visualization.save_rgb_png(
        cv.to_display(np.where(np.asarray(result["mask"]), 255, 0).astype("uint8")),
        output_dir / "segmentation_mask.png",
    )
    add_asset(record, mask_path, name="segmentation_mask", kind="image", label="Segmentation mask")
    if result["contours"]:
        annotated = cv.annotate_contours(cv.to_display(cv.ensure_uint8(index_array)), result["contours"], label_areas=False)
        annotated_path = visualization.save_rgb_png(annotated, output_dir / "segments_annotated.png")
        add_asset(record, annotated_path, name="segments_annotated", kind="image", label="Segments")
    if result["segments_geojson"]:
        geojson_path = output_dir / "segments.geojson"
        geojson_path.write_text(json.dumps(jsonable(result["segments_geojson"]), indent=2), encoding="utf-8")
        add_asset(record, geojson_path, name="segments_geojson", kind="vector", label="Segments (GeoJSON)")
    if prepared["georeferenced"]:
        overlay = visualization.save_rgba_overlay(
            np.asarray(result["mask"], dtype="float32"),
            stack["transform"],
            stack["crs"],
            output_dir / "segmentation_overlay.png",
            discrete=True,
            class_colours=["#d9d6ce", "#1d6b3c"],
            alpha=0.75,
        )
        add_asset(record, overlay["path"], name="segmentation_overlay", kind="overlay", label="Segmentation overlay", bounds_lonlat=overlay["bounds_lonlat"])
        map_path = visualization.save_weak_vegetation_map(
            index_array,
            np.asarray(result["mask"]),
            output_dir / "segmentation_map.png",
            bounds=stack.get("clip_bounds"),
            threshold=float(request.params.get("threshold", 0.4)) if request.params else 0.4,
            patch_count=result["component_count"],
            caption=f"OpenCV segmentation ({request.method}) refined with morphology.",
        )
        add_asset(record, map_path, name="segmentation_map", kind="image", label="Segmentation map")

    payload = {
        "result_id": record["id"],
        "kind": "segmentation",
        "dataset": metadata["name"],
        "aoi": aoi["name"] if aoi else ("raster_extent" if aoi_is_extent else None),
        "index": index_name,
        "method": result["method"],
        "provider": result["provider"],
        "params": request.params or {},
        "mask_coverage_pct": result["mask_coverage_pct"],
        "mask_pixels": result["mask_pixels"],
        "area_ha": result["area_ha"],
        "component_count": result["component_count"],
        "components": result["components"][:30],
        "contour_count": result["contour_count"],
        "contours": result["contours"][:30],
        "statistics": result["statistics"],
        "morphology": result["morphology"],
        "segments": result["segments"][:25],
        "segments_geojson": result["segments_geojson"],
        "threshold_value": result.get("threshold_value"),
        "clip": {"shape": list(stack["shape"]), "georeferenced": prepared["georeferenced"], "pixel_area_ha": stack.get("pixel_area_ha"), "bounds_lonlat": stack.get("clip_bounds_lonlat")},
        "available_methods": segmentation.available_methods(),
        "assets": record["assets"],
        "warnings": warnings,
        "disclaimer": DISCLAIMER,
    }
    record["payload"] = jsonable(payload)
    record["summary"] = {
        "method": result["method"],
        "mask_coverage_pct": result["mask_coverage_pct"],
        "component_count": result["component_count"],
        "dataset": metadata["name"],
        "observation_date": request.observation_date or (metadata["tags"].get("ACQUIRED") or datetime.now(timezone.utc).date().isoformat()),
    }
    save_result(record)
    return jsonable(payload)


# --------------------------------------------------------------------------- #
# time series
# --------------------------------------------------------------------------- #
@router.post("/timeseries", summary="Index time series with trend and change detection")
def timeseries_endpoint(request: TimeseriesRequest) -> Dict[str, Any]:
    ensure_directories()
    index_name = indices.normalise_index_name(request.index)
    observations: List[Dict[str, Any]] = []
    warnings: List[str] = []
    computed_count = 0

    if request.csv:
        csv_payload = ts.observations_from_csv(str(resolve_dataset(request.csv)), index_name=index_name)
        observations.extend(csv_payload["observations"])

    for item in request.observations:
        if item.result_id:
            record = load_result(item.result_id)
            payload = record.get("payload", {})
            statistics = payload.get("statistics") or {}
            health = payload.get("health") or {}
            observations.append(
                ts.build_observation(
                    item.date,
                    index_name=index_name,
                    statistics=statistics,
                    health=health,
                    dataset=record.get("dataset"),
                    aoi=record.get("aoi"),
                    result_id=record["id"],
                    source="stored_result",
                    label=item.label,
                )
            )
            continue
        if item.dataset and item.mean is None:
            sub_request = AnalysisRequest(
                dataset=item.dataset,
                aoi=item.aoi or request.aoi,
                index=index_name,
                observation_date=item.date,
                include_visuals=False,
                use_cache=request.use_cache,
            )
            payload = _analyze_field(sub_request, kind="ndvi", title=f"{index_name} observation {item.date}")
            computed_count += 1
            observations.append(
                ts.build_observation(
                    item.date,
                    index_name=index_name,
                    statistics=payload["statistics"],
                    health=payload["health"],
                    dataset=payload["dataset"],
                    aoi=payload.get("aoi"),
                    result_id=payload["result_id"],
                    source="computed",
                    label=item.label,
                )
            )
            continue
        observations.append(
            ts.build_observation(
                item.date,
                index_name=index_name,
                statistics=item.model_dump(),
                health={"healthy_pct": item.healthy_pct, "weak_pct": item.weak_pct},
                dataset=request.dataset,
                aoi=request.aoi,
                source="inline",
                label=item.label,
            )
        )

    if not observations:
        raise DataError("No observations supplied: provide 'observations', a 'csv' file, or datasets to analyse")

    analysis_payload = ts.analyze_timeseries(observations, index_name=index_name, change_threshold=request.change_threshold)
    warnings.extend(analysis_payload["warnings"])

    record = create_result(
        "timeseries",
        title=f"{index_name} time series",
        dataset=request.dataset,
        aoi=request.aoi,
        params={"index": index_name, "change_threshold": request.change_threshold, "csv": request.csv},
        cache_key=build_analysis_key(
            kind="timeseries",
            index=index_name,
            dates=[observation["date"] for observation in observations],
            means=[observation.get("mean") for observation in observations],
            change_threshold=request.change_threshold,
        ),
    )
    output_dir = result_directory(record["id"], create=True)

    if request.include_chart and analysis_payload["series"]["count"] >= 1:
        chart_path = visualization.save_timeseries_chart(
            analysis_payload["series"],
            output_dir / "timeseries_ndvi.png",
            trend=analysis_payload["trend"],
            index_name=index_name,
            title=f"{index_name} over time",
        )
        add_asset(record, chart_path, name="timeseries_chart", kind="chart", label=f"{index_name} over time")

    payload = {
        "result_id": record["id"],
        "kind": "timeseries",
        "index": index_name,
        **{key: value for key, value in analysis_payload.items() if key != "warnings"},
        "computed_observations": computed_count,
        "assets": record["assets"],
        "warnings": warnings,
        "disclaimer": DISCLAIMER,
    }
    record["payload"] = jsonable(payload)
    record["summary"] = analysis_payload["summary"]
    record["warnings"] = warnings
    save_result(record)
    return jsonable(payload)


# --------------------------------------------------------------------------- #
# results
# --------------------------------------------------------------------------- #
@router.get("/results", summary="List stored results")
def results_list(
    kind: Optional[str] = Query(None, description="ndvi | crop_health | opencv | segmentation | timeseries"),
    dataset: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
) -> Dict[str, Any]:
    entries = list_results(kind=kind, dataset=dataset, limit=limit)
    return jsonable({"count": len(entries), "results": entries, "by_kind": stats_summary(list_results(limit=None))["by_kind"]})


@router.get("/results/{result_id}", summary="One stored result")
def result_detail(result_id: str) -> Dict[str, Any]:
    try:
        return jsonable(load_result(result_id))
    except FileNotFoundError as exc:
        raise NotFoundError(f"Result '{result_id}' not found") from exc


@router.get("/results/{result_id}/assets/{filename}", summary="Download a generated asset")
def result_asset(result_id: str, filename: str) -> FileResponse:
    try:
        path = asset_path(result_id, filename)
    except FileNotFoundError as exc:
        raise NotFoundError(f"Asset '{filename}' not found for result '{result_id}'") from exc
    return FileResponse(path, filename=path.name)


# --------------------------------------------------------------------------- #
# synthetic demo scene
# --------------------------------------------------------------------------- #
@router.post("/samples/synthetic", summary="Generate a labelled synthetic demo scene (not real imagery)", status_code=status.HTTP_201_CREATED)
def synthetic_sample(
    size: int = Query(1200, ge=200, le=4000),
    pixel_size: float = Query(10.0, gt=0, le=100),
    overwrite: bool = Query(True, description="Regenerate the canonical synthetic_fields.* demo files instead of adding copies"),
) -> Dict[str, Any]:
    from data import SYNTHETIC_NOTE, generate_synthetic_scene

    scene = generate_synthetic_scene(size=size, pixel_size=pixel_size, overwrite=overwrite)
    return jsonable(
        {
            "synthetic": True,
            "note": SYNTHETIC_NOTE,
            "raster": scene["raster"],
            "aoi": scene["aoi"],
            "table": scene["table"],
            "datasets": list_datasets(),
        }
    )


# --------------------------------------------------------------------------- #
# agronomy engine (thermal time, water balance, zones, prescriptions, carbon)
# --------------------------------------------------------------------------- #
@contextmanager
def _bad_input_is_400():
    """Map the agronomy engine's input validation onto an HTTP 400.

    The engine raises ``ValueError`` for a malformed request (mismatched series
    lengths, a zero target, an unknown method). The mapping is scoped to the
    engine call on purpose: a ``ValueError`` raised deeper in the stack is a real
    bug and must still surface as a 500 rather than being disguised as a client
    error.
    """
    try:
        yield
    except ValueError as exc:
        raise DataError(str(exc)) from exc


def _index_raster(request: AnalysisRequest) -> Dict[str, Any]:
    """Run the standard clip + band-resolution + index path and return the array.

    Zones and prescriptions need the index raster itself, not just its
    statistics, so this reuses the same preparation the NDVI endpoint uses
    rather than duplicating band logic.
    """
    index_name = indices.normalise_index_name(request.index)
    index_spec = indices.INDEX_REGISTRY[index_name]
    dataset_path = resolve_dataset(request.dataset)
    validation = validate_raster(dataset_path)
    metadata = validation["metadata"]
    warnings: List[str] = list(validation["warnings"])

    aoi = _resolve_aoi(request.aoi)
    band_resolution = indices.resolve_band_map(metadata, request.band_map.as_map() if request.band_map else None)
    missing = [band for band in index_spec["bands"] if band not in band_resolution["bands"]]
    if missing:
        raise RasterError(
            f"{index_name} needs the band(s) {', '.join(index_spec['bands'])} but the raster provides "
            f"{', '.join(band_resolution['bands'].keys()) or 'no usable bands'}. Pass an explicit band_map "
            "or add band descriptions to the GeoTIFF."
        )
    if band_resolution["assumption_warning"]:
        warnings.append(
            "Band order was assumed from configuration (no band descriptions found). "
            "Verify the mapping before trusting the absolute values."
        )

    prepared = _prepare_stack(
        dataset_path,
        aoi,
        {band: band_resolution["bands"][band] for band in index_spec["bands"]},
        request.max_pixels,
    )
    stack = prepared["stack"]
    warnings.extend(prepared["warnings"])
    valid = np.asarray(stack["valid_mask"], dtype=bool)
    if not valid.any():
        raise DataError("No valid pixels inside the analysed window (everything is nodata or outside the AOI)")

    computed = indices.compute_index(index_name, stack["bands"], valid=valid)
    return {
        "index_name": index_name,
        "array": np.asarray(computed["array"], dtype="float32"),
        "valid": valid,
        "stack": stack,
        "prepared": prepared,
        "metadata": metadata,
        "aoi": aoi,
        "warnings": warnings,
        "band_resolution": band_resolution,
    }


@router.get("/agronomy/models", summary="Catalogue of agronomy models with their confidence level")
def agronomy_models() -> Dict[str, Any]:
    return {"models": agronomy.model_catalogue(), "crop_coefficients": agronomy.CROP_COEFFICIENTS,
            "soil_water_holding_mm_per_m": agronomy.SOIL_WATER_HOLDING}


@router.post("/agronomy/thermal-time", summary="Growing degree days and crop stage")
def agronomy_thermal_time(request: ThermalTimeRequest) -> Dict[str, Any]:
    with _bad_input_is_400():
        thermal = agronomy.growing_degree_days(
            request.tmin, request.tmax, base_c=request.base_c, upper_c=request.upper_c, method=request.method
        )
        stages = agronomy.phenology_from_gdd(thermal["total"], crop=request.crop, stage_days=request.stage_days)
    return jsonable({**thermal, "phenology": stages})


@router.post("/agronomy/water-balance", summary="FAO-56 soil water balance and irrigation schedule")
def agronomy_water_balance(request: WaterBalanceRequest) -> Dict[str, Any]:
    with _bad_input_is_400():
        return jsonable(
            agronomy.water_balance(
                request.et0,
                request.rainfall,
                crop=request.crop,
                soil=request.soil,
                kc=request.kc,
                root_depth_m=request.root_depth_m,
                initial_depletion_mm=request.initial_depletion_mm,
                depletion_trigger_pct=request.depletion_trigger_pct,
                irrigation_efficiency=request.irrigation_efficiency,
                rainfall_effectiveness=request.rainfall_effectiveness,
                min_rain_mm=request.min_rain_mm,
            )
        )


@router.post("/agronomy/zones", summary="Management zones from a vegetation index raster")
def agronomy_zones(request: ZonesRequest) -> Dict[str, Any]:
    raster = _index_raster(request)
    with _bad_input_is_400():
        result = agronomy.management_zones(
            raster["array"],
            mask=raster["valid"],
            n_zones=request.n_zones,
            spatial_weight=request.spatial_weight,
            max_pixels=request.max_pixels or 250_000,
        )
    pixel_area_ha = raster["stack"].get("pixel_area_ha")
    if pixel_area_ha and result.get("verdict") == "ok":
        for zone in result["zones"]:
            if zone.get("pixels"):
                zone["area_ha"] = round(zone["pixels"] * float(pixel_area_ha), 4)
        result["pixel_area_ha"] = float(pixel_area_ha)
    result.pop("zone_map", None)  # a full raster in a JSON body is not useful
    result.pop("sample_values", None)
    result.pop("sample_labels", None)
    result["index"] = raster["index_name"]
    result["dataset"] = raster["metadata"]["name"]
    result["warnings"] = raster["warnings"]
    return jsonable(result)


@router.post("/agronomy/prescription", summary="Variable-rate prescription from a zone table")
def agronomy_prescription(request: PrescriptionRequest) -> Dict[str, Any]:
    with _bad_input_is_400():
        return jsonable(
            agronomy.variable_rate_prescription(
                request.zones,
                product=request.product,
                base_rate=request.base_rate,
                target_index=request.target_index,
                rate_unit=request.rate_unit,
                min_rate=request.min_rate,
                max_rate=request.max_rate,
                response_per_index=request.response_per_index,
            )
        )


@router.post("/agronomy/carbon", summary="Soil-carbon practice screen (screening estimate, not MRV-grade)")
def agronomy_carbon(request: CarbonScreenRequest) -> Dict[str, Any]:
    with _bad_input_is_400():
        return jsonable(
            agronomy.soil_carbon_screening(
                request.index_values,
                crop=request.crop,
                tillage=request.tillage,
                cover_crop=request.cover_crop,
                residue_retained=request.residue_retained,
                years_in_practice=request.years_in_practice,
            )
        )


@router.post("/agronomy/yield-forecast", summary="Empirical yield estimate from a seasonal index integral")
def agronomy_yield(request: YieldForecastRequest) -> Dict[str, Any]:
    with _bad_input_is_400():
        return jsonable(
            agronomy.yield_forecast(
                request.index_series,
                crop=request.crop,
                coefficient=request.coefficient,
                intercept=request.intercept,
                calibration=request.calibration,
            )
        )


@router.post("/agronomy/disease-risk", summary="Weather favourability for foliar disease (not a diagnosis)")
def agronomy_disease(request: DiseaseRiskRequest) -> Dict[str, Any]:
    with _bad_input_is_400():
        return jsonable(
            agronomy.disease_risk(
                request.tmin,
                request.tmax,
                request.humidity,
                crop=request.crop,
                leaf_wetness_hours=request.leaf_wetness_hours,
                rainfall=request.rainfall,
            )
        )


@router.get("/security", summary="Live security posture: headers, limits and their honest caveats")
def security_posture() -> Dict[str, Any]:
    from security import SECURITY_HEADERS, _ANALYSIS_PREFIXES, _CSP

    return {
        "headers": sorted(SECURITY_HEADERS),
        "policy": {"csp": _CSP, "frameAncestors": "none", "objectSrc": "none"},
        "rateLimits": {
            "read": os.getenv("VIBES_RATE_LIMIT_READ", "1200") + "/min",
            "write": os.getenv("VIBES_RATE_LIMIT_WRITE", "240") + "/min",
            "analysis": os.getenv("VIBES_RATE_LIMIT_ANALYSIS", "120") + "/min",
            "scope": "per client address, evaluated per worker process",
            "disabled": os.getenv("VIBES_RATE_LIMIT_DISABLED", "").lower() in {"1", "true", "yes"},
        },
        "classification": {
            "analysis": list(_ANALYSIS_PREFIXES),
            "write": "any other POST/PUT/PATCH/DELETE",
            "read": "everything else",
        },
        "uploadLimitMb": security_config().get("max_upload_mb"),
        "extensionAllowLists": {
            "raster": security_config().get("allowed_raster_ext"),
            "vector": security_config().get("allowed_vector_ext"),
            "image": security_config().get("allowed_image_ext"),
            "table": security_config().get("allowed_table_ext"),
        },
        "note": (
            "No user authentication is implemented. Terminate TLS and add an authenticating reverse proxy "
            "before exposing this API to the internet."
        ),
    }
