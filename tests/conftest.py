"""Shared pytest fixtures.

The suite runs against an isolated temporary storage root so it never touches
``data/raw`` or ``outputs/`` of the real project. Environment variables are set
*before* the backend modules are imported, which is why they sit at module
level here.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = PROJECT_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

TEST_ROOT = Path(tempfile.mkdtemp(prefix="vibes-lite-tests-"))
os.environ["VIBES_RAW_DATA_DIR"] = str(TEST_ROOT / "raw")
os.environ["VIBES_PROCESSED_DATA_DIR"] = str(TEST_ROOT / "processed")
os.environ["VIBES_OUTPUTS_DIR"] = str(TEST_ROOT / "outputs")
os.environ["VIBES_MAX_UPLOAD_MB"] = "8"
os.environ["VIBES_LOG_LEVEL"] = "WARNING"

import config  # noqa: E402

config.reload_config()
config.ensure_directories()

SCENE_SIZE = 320


@pytest.fixture(scope="session")
def storage_root() -> Path:
    return TEST_ROOT


@pytest.fixture(scope="session")
def scene() -> dict:
    """A small, clearly-labelled synthetic 4-band scene plus boundaries and CSV."""
    from data import generate_synthetic_scene

    generated = generate_synthetic_scene(name="test_fields", size=SCENE_SIZE, pixel_size=10.0, seed=1234)
    return {
        "raster": generated["raster"]["name"],
        "aoi": generated["aoi"]["name"],
        "table": generated["table"]["name"],
        "paths": generated["paths"],
    }


@pytest.fixture(scope="session")
def single_band_raster() -> str:
    """A one-band GeoTIFF in data/raw (used for band-resolution error tests)."""
    import rasterio
    from rasterio.transform import from_origin

    from config import project_paths

    path = project_paths()["raw_data"] / "single_band.tif"
    data = (np.linspace(0, 4000, 64, dtype="uint16")).reshape(1, -1).repeat(64, axis=0)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=64,
        width=64,
        count=1,
        dtype="uint16",
        crs="EPSG:32633",
        transform=from_origin(250000, 4540000, 10, 10),
    ) as dataset:
        dataset.write(data, 1)
        dataset.set_band_description(1, "pan")
    return path.name


@pytest.fixture(scope="session")
def ungeoreferenced_raster() -> str:
    """A 3-band raster without a CRS (drone-style tile)."""
    import rasterio

    from config import project_paths

    path = project_paths()["raw_data"] / "plain_rgb.tif"
    rng = np.random.default_rng(7)
    data = rng.integers(20, 240, size=(3, 80, 80), dtype="uint8")
    with rasterio.open(path, "w", driver="GTiff", height=80, width=80, count=3, dtype="uint8") as dataset:
        dataset.write(data)
    return path.name


@pytest.fixture(scope="session")
def client():
    """FastAPI test client bound to the real application."""
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def ndvi_result(client, scene) -> dict:
    """One shared NDVI analysis (slowest call in the suite)."""
    response = client.post(
        "/api/ndvi",
        json={"dataset": scene["raster"], "aoi": scene["aoi"], "weak_threshold": 0.45},
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture()
def simple_ndvi_grid() -> np.ndarray:
    """A small hand-checkable NDVI grid spanning several health classes."""
    return np.array(
        [
            [-0.10, 0.05, 0.15],
            [0.25, 0.35, 0.45],
            [0.55, 0.65, 0.75],
            [0.85, 0.95, 0.30],
        ],
        dtype="float32",
    )
