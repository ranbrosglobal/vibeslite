"""Result storage for Vibes Lite.

Every analysis run writes one directory under ``outputs/``:

    outputs/<result_id>/
        result.json      analysis payload + asset manifest
        ndvi_map.png     generated assets
        ...

There is deliberately no database in the initial release: the filesystem *is*
the store, and ``result.json`` files are the index. Listing scans the outputs
directory, which is cheap at the scale this platform targets and keeps results
portable (copy the folder, keep the analysis).
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List

from config import ensure_directories, project_paths, security_config

_SLUG_RE = re.compile(r"[^a-zA-Z0-9._-]+")
IMAGE_ASSET_EXT = {".png", ".jpg", ".jpeg", ".webp", ".svg"}
VECTOR_ASSET_EXT = {".geojson", ".json"}
ALL_ASSET_EXT = IMAGE_ASSET_EXT | VECTOR_ASSET_EXT | {".csv"}


class StorageError(RuntimeError):
    """Raised for invalid identifiers or unsafe paths."""


# --------------------------------------------------------------------------- #
# identifiers and filenames
# --------------------------------------------------------------------------- #
def slugify(value: str, max_length: int = 48) -> str:
    """Filesystem-safe slug. Never returns a path-traversal-capable string."""
    candidate = _SLUG_RE.sub("-", (value or "").strip()).strip("-._")
    candidate = candidate.replace("..", "-")
    return (candidate or "item")[:max_length]


def new_result_id(kind: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"{slugify(kind, 24)}-{stamp}-{secrets.token_hex(3)}"


def safe_join_under(base: Path, *parts: str) -> Path:
    """Join path fragments under ``base``, refusing traversal escapes."""
    base = Path(base).resolve()
    target = base.joinpath(*[str(p).replace("\\", "/").lstrip("/") for p in parts]).resolve()
    if target != base and base not in target.parents:
        raise StorageError("Path escapes the outputs directory")
    return target


# --------------------------------------------------------------------------- #
# caching helper (avoids re-processing identical requests)
# --------------------------------------------------------------------------- #
def build_analysis_key(**parts: Any) -> str:
    """Deterministic content key for a set of analysis inputs."""
    payload = json.dumps(parts, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def file_fingerprint(path: str | Path) -> Dict[str, Any]:
    """Cheap identity for a file: name, byte size and mtime."""
    p = Path(path)
    try:
        stat = p.stat()
        return {"name": p.name, "size": stat.st_size, "mtime": int(stat.st_mtime)}
    except OSError:
        return {"name": p.name, "size": None, "mtime": None}


# --------------------------------------------------------------------------- #
# results
# --------------------------------------------------------------------------- #
def result_directory(result_id: str, create: bool = False) -> Path:
    outputs = project_paths()["outputs"]
    directory = safe_join_under(outputs, result_id)
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    return directory


def create_result(
    kind: str,
    *,
    title: str = "",
    dataset: str | None = None,
    aoi: str | None = None,
    params: Dict[str, Any] | None = None,
    cache_key: str | None = None,
    extra: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Allocate a result record on disk and return it."""
    ensure_directories()
    record: Dict[str, Any] = {
        "id": new_result_id(kind),
        "kind": kind,
        "title": title or kind.replace("_", " ").title(),
        "status": "completed",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": dataset,
        "aoi": aoi,
        "params": params or {},
        "cache_key": cache_key,
        "payload": {},
        "assets": [],
        "warnings": [],
        "notes": [],
    }
    if extra:
        record.update(extra)
    result_directory(record["id"], create=True)
    return record


def add_asset(
    record: Dict[str, Any],
    path: str | Path,
    *,
    name: str = "",
    kind: str = "image",
    label: str = "",
    bounds_lonlat: Iterable[float] | None = None,
    extra: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Register a generated file as a downloadable asset of the result."""
    file_path = Path(path)
    asset = {
        "file": file_path.name,
        "name": name or file_path.stem,
        "kind": kind,
        "label": label or file_path.stem.replace("_", " ").title(),
        "url": public_url(record["id"], file_path.name),
        "bytes": file_path.stat().st_size if file_path.exists() else None,
    }
    if bounds_lonlat is not None:
        asset["bounds_lonlat"] = [float(v) for v in bounds_lonlat]
    if extra:
        asset.update(extra)
    record.setdefault("assets", []).append(asset)
    return asset


def public_url(result_id: str, filename: str) -> str:
    return f"/outputs/{result_id}/{filename}"


def save_result(record: Dict[str, Any]) -> Dict[str, Any]:
    directory = result_directory(record["id"], create=True)
    target = safe_join_under(directory, "result.json")
    with target.open("w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2, default=str)
    return record


def load_result(result_id: str) -> Dict[str, Any]:
    record_path = safe_join_under(result_directory(result_id), "result.json")
    if not record_path.exists():
        raise FileNotFoundError(result_id)
    with record_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def update_result(result_id: str, **changes: Any) -> Dict[str, Any]:
    record = load_result(result_id)
    record.update(changes)
    return save_result(record)


def find_cached(cache_key: str) -> Dict[str, Any] | None:
    """Return the most recent completed result matching ``cache_key``."""
    if not cache_key:
        return None
    for summary in list_results(limit=None):
        if summary.get("cache_key") == cache_key and summary.get("status") == "completed":
            try:
                return load_result(summary["id"])
            except (FileNotFoundError, StorageError):
                continue
    return None


def list_results(
    kind: str | None = None,
    limit: int | None = 100,
    dataset: str | None = None,
) -> List[Dict[str, Any]]:
    """List stored results, newest first. Summaries only (no payloads)."""
    outputs = project_paths()["outputs"]
    if not outputs.exists():
        return []
    summaries: List[Dict[str, Any]] = []
    for directory in outputs.iterdir():
        if not directory.is_dir():
            continue
        record_path = directory / "result.json"
        if not record_path.exists():
            continue
        try:
            with record_path.open("r", encoding="utf-8") as handle:
                record = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
        if kind and record.get("kind") != kind:
            continue
        if dataset and record.get("dataset") != dataset:
            continue
        summaries.append(
            {
                "id": record.get("id", directory.name),
                "kind": record.get("kind"),
                "title": record.get("title"),
                "status": record.get("status"),
                "created_at": record.get("created_at"),
                "dataset": record.get("dataset"),
                "aoi": record.get("aoi"),
                "cache_key": record.get("cache_key"),
                "summary": record.get("summary", {}),
                "asset_count": len(record.get("assets", [])),
                "assets": record.get("assets", []),
                "warnings": record.get("warnings", []),
            }
        )
    summaries.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return summaries if limit is None else summaries[:limit]


def asset_path(result_id: str, filename: str) -> Path:
    """Resolve a result asset for download, with traversal protection."""
    directory = result_directory(result_id)
    if not directory.exists():
        raise FileNotFoundError(result_id)
    safe_name = Path(str(filename).replace("\\", "/")).name
    if safe_name != filename or not safe_name:
        raise StorageError("Unsafe asset name")
    if Path(safe_name).suffix.lower() not in ALL_ASSET_EXT:
        raise StorageError("Unsupported asset type")
    target = safe_join_under(directory, safe_name)
    if not target.exists():
        raise FileNotFoundError(safe_name)
    return target


def stats_summary(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate summary used by the dashboard endpoint."""
    by_kind: Dict[str, int] = {}
    datasets: Dict[str, int] = {}
    for record in results:
        kind = record.get("kind") or "unknown"
        by_kind[kind] = by_kind.get(kind, 0) + 1
        if record.get("dataset"):
            datasets[record["dataset"]] = datasets.get(record["dataset"], 0) + 1
    return {
        "total_results": len(results),
        "by_kind": by_kind,
        "datasets": datasets,
        "latest": results[0] if results else None,
    }


def allowed_asset_extensions() -> set[str]:
    return set(ALL_ASSET_EXT) | set(security_config().get("allowed_image_ext", []))


def jsonable(value: Any) -> Any:
    """Recursively convert NumPy / NumPy-scalar values into JSON-safe Python.

    Engine modules return NumPy scalars and arrays for convenience; this is the
    single place where they cross into the JSON world, so responses never fail
    on an unserialisable type.
    """
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [jsonable(item) for item in value]
    if hasattr(value, "tolist"):
        try:
            return value.tolist()
        except Exception:  # pragma: no cover - defensive
            return None
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:  # pragma: no cover - defensive
            return None
    if isinstance(value, (str, int, float, bool)) or value is None:
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            return None
        return value
    if isinstance(value, Path):
        return value.name
    return str(value)
