# Vibes Lite

**A lightweight, open agriculture intelligence platform.**
Load a field boundary and a satellite or drone raster, and get a vegetation
index map, crop-health zones, weak-vegetation patches, OpenCV processing and a
time-series trajectory — through an API and a geospatial dashboard.

Vibes Lite is an independent implementation. It is *inspired by* the concepts
and workflows of Microsoft FarmVibes.AI, but shares no code and has **no
runtime dependency** on it. Geospatial processing, the index engine, the
OpenCV and segmentation layers, the API and the dashboard are all built here.

```
    AOI + raster  →  clip + band stack  →  NDVI  →  crop health
                  →  weak zones / anomalies  →  visuals  →  API  →  dashboard
```

---

## Table of contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Technology stack](#technology-stack)
4. [Directory structure](#directory-structure)
5. [Installation](#installation)
6. [Running everything](#running-everything)
7. [Docker setup](#docker-setup)
8. [Local development](#local-development)
9. [API documentation](#api-documentation)
10. [The first POC](#the-first-poc)
11. [NDVI workflow](#ndvi-workflow)
12. [OpenCV workflow](#opencv-workflow)
13. [Frontend usage](#frontend-usage)
14. [Configuration](#configuration)
15. [Testing](#testing)
16. [Notebooks](#notebooks)
17. [Security and performance](#security-and-performance)
18. [Crop AI module](#crop-ai-module)
19. [Deployment](#deployment)
20. [Troubleshooting](#troubleshooting)
21. [Known limits](#known-limits)
22. [Roadmap](#roadmap)

---

## Features

**Data ingestion** — GeoTIFF / VRT rasters (single-band, RGB or multispectral),
GeoJSON field boundaries, CSV tabular datasets. Metadata, band descriptions,
CRS, nodata and validation are reported before anything is processed.

**Real satellite ingestion** — search the Copernicus STAC catalogue for actual
acquisitions over a field, then read only that window of the band files straight
off the public Cloud-Optimised GeoTIFF hosting with GDAL `/vsicurl` range reads
(a Sentinel-2 band is 10980 × 10980 px; a 1 km field pulls a few hundred
kilobytes, not 160 MB). Pixels are converted to true surface reflectance using
the radiometry the catalogue publishes for each asset, cloud / shadow / snow are
masked through the Scene Classification Layer, and the window is written to
`data/raw` as an ordinary GeoTIFF whose tags carry the exact STAC item,
acquisition time, cloud cover and licence. Every analysis endpoint accepts it by
name — no upload step and no synthetic stand-in.

**Geospatial engine** — CRS detection and conversion, AOI validation and
reprojection, windowed raster clipping, AOI rasterisation and masking, geometry
validation, field-boundary areas, raster/vector overlay checks.

**Preprocessing** — nodata handling, valid-mask construction, band extraction,
normalisation, RGB / false-colour composites, decimation against a pixel
budget. Raw data is never modified: every operation returns new arrays.

**Index engine** — **13 indices** on one dispatch path: NDVI, NDRE, EVI, SAVI,
GNDVI, NDMI, NDWI, OSAVI, MSAVI, PSRI, CVI, RECI and GCI. Division-by-zero,
nodata and invalid pixels are handled explicitly, band selection is always
reported (Vibes Lite tells you when it had to assume a band order), and every
index declares whether it is difference-normalised to `[-1, 1]` or an unbounded
positive ratio, so a UI never colour-scales a ratio index as if it were NDVI.
SWIR is split into SWIR1/SWIR2 by centre wavelength, so moisture and mineral
indices resolve the right band instead of silently sharing one.

**Agronomy engine** — seven independent, documented models that answer the
questions an advisor actually asks, each declaring how far its answer can be
trusted:

| Model | Method | Honest confidence |
|---|---|---|
| Thermal time & phenology | GDD (average / modified / sine) with a cut-out ceiling | published method, indicative stage lengths |
| FAO-56 water balance & irrigation | single-Kc ETc with a root-zone depletion balance | published method, indicative coefficients |
| Management zones | k-means++ on index + weighted spatial position | descriptive — ground-truth required |
| Variable-rate prescription | proportional-deficit rule over management zones | advisory — depends on the zone map |
| Soil carbon screening | practice-weighted screening with saturation over time | screening only — not MRV-grade |
| Yield forecast | linear index-integral regression | requires local calibration |
| Disease favourability | per-pathogen temperature and wetness rule sets | favourability only — not a diagnosis |

The engine refuses to invent numbers it cannot support: an uncalibrated yield
request returns the calibration recipe instead of a tonnage, and the carbon
screen returns a range plus the list of what is still missing before the figure
could be verified.

**Crop-health engine** — configurable, explainable classes (very low → very
healthy), per-class area and share, contiguous health zones, weak-vegetation
patch detection with minimum-area filtering, z-score / IQR anomaly detection,
field summary and a plain-language interpretation that states what NDVI cannot
conclude.

**OpenCV engine** — resize, denoise, blur, CLAHE/gamma enhancement, threshold,
Otsu, adaptive threshold, opening, closing, erosion, dilation, gradient,
small-object removal, mask cleaning, contour detection and metrics, ROI
extraction, overlays, contour annotation, before/after composites and
step-by-step pipeline metrics.

**Segmentation (AI-ready)** — threshold, Otsu, multi-threshold and
crop-health-zone segmentation with morphological refinement, connected
components, contour extraction and GeoJSON export. A model registry accepts a
future U-Net / DeepLab / YOLO-seg loader without touching the API or the UI.
No weights are downloaded and no GPU is required.

**Time series** — observations from a CSV, from stored results or inline, with
least-squares trend, change detection between dates, and health-share tracking.

**Visualization** — NDVI map, crop-health map, weak-vegetation map, histogram,
class-distribution chart, field-boundary overlays and time-series charts,
written under `outputs/` with georeferenced overlays for the map.

**Dashboard** — **nine pages** (Dashboard, Fields, NDVI, Crop Health, Computer
Vision, Time Series, **Agronomy**, Results, **Security**) behind a brutalist
INK / BONE / ACID design system: zero border radius, 2px structural rules, hard
offset shadows, a blueprint grid underlay and JetBrains Mono on every measured
number. Motion is `transform`/`opacity` only — View Transitions for route
morphs, a sliding nav indicator, staggered scroll reveals, clip-path wipes and
spring easing — and it all collapses under `prefers-reduced-motion`.

**Installable on a phone** — both apps ship a web app manifest, a service
worker and generated maskable icons, so either one installs to a home screen
and opens standalone. The dashboard's worker caches content-hashed build assets
cache-first, navigations network-first, and never caches `/api` or `/outputs`:
an offline analysis must fail loudly rather than replay a stale crop-health
verdict as if it were new.

---

## Architecture

Modular monolith: one FastAPI backend process, one Vite frontend, plain modules
instead of microservices.

```
                              ┌──────────────────────────────┐
                              │        React + Vite          │
                              │   Dashboard · Fields · NDVI  │
                              │   Crop Health · CV · Series  │
                              │   Results   (Leaflet maps)   │
                              └──────────────┬───────────────┘
                                             │  /api  ·  /outputs
                                             ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                            FastAPI  (backend/)                             │
│                                                                            │
│   api.py ─────────────── request models, routing, orchestration            │
│     │                                                                      │
│     ├── config.py        configuration + path resolution                   │
│     ├── storage.py       result records, assets, cache lookup              │
│     │                                                                      │
│     ▼                                                                      │
│   data.py ─────────────► load_raster · load_aoi · load_geojson · load_csv  │
│     │                    metadata · validation · safe filenames            │
│     ▼                                                                      │
│   geospatial.py ───────► CRS · clip to AOI · rasterise · reproject         │
│     │                    polygons · overlap checks                         │
│     ▼                                                                      │
│   preprocessing.py ────► valid masks · nodata · band stacks · scaling      │
│     │                    composites · decimation                           │
│     ▼                                                                      │
│   indices.py ──────────► 13 indices + per-index statistics                 │
│     │                                                                      │
│     ├── opencv.py ─────► masks · morphology · contours · overlays          │
│     ├── segmentation.py ► threshold / otsu / multi · components · registry │
│     ├── analysis.py ───► health classes · zones · weak patches · anomalies │
│     ├── timeseries.py ─► trend · change · health trajectory                │
│     ├── agronomy.py ───► GDD · water balance · zones · VRA · carbon · yield │
│     └── visualization.py► maps · charts · overlays  → outputs/             │
└────────────────────────────────────────────────────────────────────────────┘
              │                                   │
              ▼                                   ▼
        data/raw/                          outputs/<result-id>/
        data/processed/                    (maps, charts, result.json)
```

**Design rules**

* Engines never import the API; the API orchestrates engines.
* Thresholds, band defaults and limits live in `config.yaml` — never scattered
  through the code.
* Raw data is read-only; processed rasters are written to `data/processed/`,
  artefacts to `outputs/<result-id>/`.
* Repeat analyses of the same dataset / AOI / thresholds hit the result cache
  instead of reprocessing.

---

## Technology stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11, FastAPI, Uvicorn, Pydantic |
| Geospatial | Rasterio, GeoPandas, Shapely, pyproj, Pyogrio |
| Imaging / CV | OpenCV (headless), NumPy, Pillow |
| Data & charts | Pandas, Matplotlib |
| Frontend | React 18, Vite 5, React Router, Recharts, Leaflet / React-Leaflet |
| Packaging | Docker, Docker Compose |
| Tests | pytest, httpx (FastAPI TestClient) |

---

## Directory structure

```
vibes-lite/
├── backend/
│   ├── main.py              FastAPI application + middleware + static mounts
│   ├── api.py               routes, request models, orchestration
│   ├── config.py            config.yaml + environment loading
│   ├── data.py              ingestion, validation, safe filenames
│   ├── agronomy.py           GDD · FAO-56 water balance · zones · VRA · carbon · yield · disease
│   ├── security.py           CSP, security headers, tiered rate limiting, upload validation
│   ├── osm.py               real maps and places (Nominatim, Overpass, OSM tiles)
│   ├── satellite.py         real Sentinel-2 ingestion (STAC search + COG window reads)
│   ├── geospatial.py        CRS, clipping, masking, polygons
│   ├── preprocessing.py     masks, band stacks, normalisation, composites
│   ├── opencv.py            the OpenCV engine
│   ├── indices.py           13 vegetation indices + statistics
│   ├── analysis.py          crop-health classes, zones, weak patches, anomalies
│   ├── segmentation.py      classical segmentation + model registry
│   ├── timeseries.py        trend, change detection, health trajectory
│   ├── visualization.py     maps, charts and overlays
│   ├── storage.py           result records, assets, cache
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js       dev server + /api and /outputs proxy
│   └── src/
│       ├── App.jsx  main.jsx  api.js  styles.css
│       ├── components/      Layout, Panel, MapView, Charts, HealthDistribution,
│       │                    Uploader, FieldPicker, InterpretationPanel
│       └── pages/           Dashboard, Fields, Satellite, Ndvi, CropHealth,
│                            ImageProcessing, TimeSeries, Agronomy, Security, Results
├── crop-ai/                 AI Crop Monitoring from Drone Images (Node module)
│   ├── server.js            single-file backend: tiling, OpenCV, kNN, sensors, SSE
│   ├── public/              self-contained farm dashboard (no build step)
│   └── package.json
├── data/
│   ├── raw/                 your GeoTIFF / GeoJSON / CSV inputs
│   └── processed/           processed rasters (index rasters, masks)
├── outputs/                 one folder per result: maps, charts, result.json
├── notebooks/               01…08 executable demonstrations
├── tests/                   pytest suite
├── api/
│   └── index.js             Vercel function entry (re-exports crop-ai/server)
├── vercel.json              catch-all rewrite + function bundle globs
├── Dockerfile               multi-target image (backend + frontend)
├── docker-compose.yml       vibes-lite-backend:8000 · vibes-lite-frontend:5173
├── config.yaml              thresholds, paths, limits
└── .env.example
```

---

## Installation

**Requirements** — Node 18+ (20 recommended) and Python 3.11+. Optional
additions: Ollama (the local species-identification vision model, ~3.2 GB
download) and Docker (containerized Vibes Lite).
No GPU, no external services, no API keys.

```bash
git clone <your-fork> vibes-lite
cd vibes-lite

# backend
python3.11 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt

# frontend (dashboard)
cd frontend && npm install && cd ..

# Crop AI console (backend + web console in one Node process)
cd crop-ai && npm install && cd ..

cp .env.example .env               # optional: adjust ports, upload limits
```

**Optional — local species identification.** The *Identify plant* feature
talks to a local Ollama vision model. Install it once and pull the default
model:

```bash
# macOS: brew install ollama
# Linux / Windows: https://ollama.com/download
ollama pull qwen2.5vl:3b           # one-time, ~3.2 GB
```

`./start.sh` starts `ollama serve` automatically when Ollama is installed.
See [Running everything](#running-everything) for the full wiring.

---

## Running everything

Everything below runs locally — no API keys, no cloud accounts. The repo
holds two independent products; run whichever you need.

| You want | Command | Opens at |
|---|---|---|
| **Everything — all three services** | `npm run dev` | console :5177 + API :8000 + dashboard :5173 |
| Crop AI console (API + UI, one process) | `./start.sh` | http://localhost:5177 |
| Crop AI console + reference AI model | `./start.sh --mock-ai` | console + http://localhost:5199 |
| Crop AI console on another port | `PORT=8080 ./start.sh` | http://localhost:8080 |
| Vibes Lite API (FastAPI, venv activated) | `cd backend && uvicorn main:app --reload --port 8000` | http://localhost:8000/docs |
| Vibes Lite dashboard (Vite) | `cd frontend && npm run dev` | http://localhost:5173 |
| Vibes Lite, containerized | `docker compose up --build` | :8000 + :5173 |

### 0. Everything at once

```bash
npm run dev                 # all three services, one terminal
```

`dev.sh` is the single entry point for the whole platform. It installs what is
missing on first run (crop-ai deps, frontend deps, the `.venv`), starts
`ollama serve` when Ollama is installed, then launches:

| Service | Port | URL |
|---|---|---|
| Crop AI console (Node API + UI) | 5177 | http://localhost:5177 |
| Vibes Lite API (FastAPI) | 8000 | http://localhost:8000/docs |
| Vibes Lite dashboard (Vite, proxies `/api` → :8000) | 5173 | http://localhost:5173 |

It waits until each one actually answers before printing the URLs, writes each
service's output to `.dev/logs/<service>.log`, and supervises the set: if one
dies, it says which and stops the others instead of leaving a dashboard talking
to a dead backend. Ctrl-C stops all three. Override ports with
`CONSOLE_PORT`, `API_PORT`, `WEB_PORT`. Run one surface alone with
`npm run dev:console`, `npm run dev:api` or `npm run dev:web`.

### 1. Crop AI console

```bash
./start.sh                # installs crop-ai deps on first run, then serves
```

`start.sh` is the single entry point: it checks Node >= 18, runs
`npm --prefix crop-ai install` the first time, starts `ollama serve` when
Ollama is installed (never fails the boot over it), then `exec`s
`crop-ai/server.js` — one Node process that serves both the JSON API and the
static web console. Stop it with Ctrl-C.

Equivalent ways to boot:

```bash
npm start                  # repo root — same script
npm run mock-ai            # same, with the reference AI model on :5199
cd crop-ai && npm install && npm start
PORT=8080 ./start.sh       # change the port (default 5177)
```

### 2. Service manager scripts (detached run)

To keep the console alive beyond a terminal session, use the bundled
managers (they need the project venv for `httpx`, created in Installation):

```bash
.venv/bin/python tools/cropai_server.py          # start console :5177 + reference model :5199
.venv/bin/python tools/cropai_server.py status   # console up/down; mock-ai up/down
.venv/bin/python tools/cropai_server.py stop     # stop both

.venv/bin/python tools/ollama_server.py          # start ollama serve :11434 (if installed)
.venv/bin/python tools/ollama_server.py status   # up/down; model ready/missing
.venv/bin/python tools/ollama_server.py stop
```

There is **no `restart` command** — while the console is running, `start`
just reports `already running`. To pick up code changes: `stop`, then
`start`.

Logs (written fresh on each start; `/tmp` is cleared on reboot):

```text
/tmp/vibes-cropai.log    Crop AI console API
/tmp/vibes-mockai.log    reference AI model
/tmp/vibes-ollama.log    Ollama
```

### 3. Reference AI model (optional, :5199)

The bundled mock exercises the whole external-AI chain with no GPU and no
key:

```bash
./start.sh --mock-ai               # console + model in one shot
node crop-ai/mock-ai-model.js      # model alone (from the repo root)
curl http://localhost:5199/health   # 200 when ready
```

Then either save the endpoint under **AI Model** in the console, or pass it
at boot:

```bash
AI_PROVIDER=generic AI_API_URL=http://localhost:5199/predict AI_MODEL=crop-vision ./start.sh
```

Pointing at a real GPU inference server later changes only those three
values (or the same three fields in the AI Model tab).

### 4. Plant species identification (local Ollama, :11434)

Naming a species is a different job than 4-class ground-cover scoring, so it
uses its own endpoint. One-time setup:

```bash
ollama pull qwen2.5vl:3b                 # one-time, ~3.2 GB
.venv/bin/python tools/ollama_server.py   # start the server (start.sh does this too)
```

Wire it once in the console: **AI Model → Species identification endpoint**
(pre-filled with provider `openai`, base URL `http://localhost:11434/v1`,
model `qwen2.5vl:3b`, timeout `120000` ms) → **Save** → **Test
identification**. After that it works from three places:

* **Camera → Identify plant** — snap a frame and get species, type,
  confidence, ranked candidates, health and observed traits.
* **Geo Map → tile popup → Identify here** — identify what is on the map.
* `POST /api/ai/identify` — a camera frame (`image`) or `{fieldId, r, c}`
  tile; `GET /api/identify` returns the stored history.

Failures are honest, never guessed: `409` = the endpoint is not configured,
`502` = the model is unreachable or could not name anything (a tiny aerial
tile often legitimately returns 502). Any OpenAI-compatible vision endpoint
(`gpt-4o`, a GPU box running Ollama / vLLM / llama.cpp) drops into the same
three fields — add the API key too when the provider needs one.

### Ports at a glance

| Port | Service | Set by |
|---|---|---|
| 5177 | Crop AI console + API | `PORT` (default 5177) |
| 5199 | Reference AI model | `crop-ai/mock-ai-model.js` |
| 11434 | Ollama (species identification) | Ollama itself |
| 8000 | Vibes Lite API | `VIBES_PORT` / uvicorn `--port` |
| 5173 | Vibes Lite dashboard | Vite |

### Verify the install

```bash
curl -s localhost:5177/api/health       # console API up
curl -s localhost:5177/api/ai/status    # both AI endpoints, configured state
curl -s localhost:5199/health           # reference model (if started)
curl -s localhost:11434/api/tags        # Ollama + pulled models (if started)
curl -s localhost:8000/api/health       # Vibes Lite API (if running)
.venv/bin/python -m pytest -q           # 294 tests
```

---

## Docker setup

```bash
docker compose up --build
```

| Service | Container | URL |
|---|---|---|
| Backend API | `vibes-lite-backend` | http://localhost:8000 (docs at `/docs`) |
| Dashboard | `vibes-lite-frontend` | http://localhost:5173 |

`data/` and `outputs/` are bind-mounted, so uploads and generated maps live on
the host and survive rebuilds. The frontend container proxies `/api` and
`/outputs` to the backend container, so the browser only ever talks to one
origin (no CORS setup needed).

```bash
docker compose logs -f vibes-lite-backend     # follow the API log
docker compose run --rm vibes-lite-backend pytest -q   # run the suite in the image
docker compose down                           # stop
```

Both images are built from the single `Dockerfile` via named targets:

```bash
docker build --target backend  -t vibes-lite-backend  .
docker build --target frontend -t vibes-lite-frontend .
```

---

## Local development

One command from the repo root — API, dashboard and Crop AI console together:

```bash
npm run dev
```

Prefer separate terminals (or need `--reload` on the API)?

```bash
# 1. API on :8000
npm run dev:api            # .venv/bin/python -m uvicorn main:app --reload --port 8000

# 2. Dashboard on :5173
npm run dev:web            # npm --prefix frontend run dev
```

Open http://localhost:5173. Vite proxies `/api` and `/outputs` to
`VITE_API_PROXY_TARGET` (default `http://localhost:8000`), so nothing else needs
configuring. Open http://localhost:8000/docs for the interactive OpenAPI docs.

Create a demo scene without touching the UI:

```bash
curl -X POST "http://localhost:8000/api/samples/synthetic?size=1200"
```

---

## API documentation

Base path `/api`. All analysis endpoints return JSON with the statistics,
health classes, zones, weak patches, interpretation text, saved assets and the
`result_id` you can fetch or download later.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Service status and capabilities |
| GET | `/api/project` | Project descriptor (name, version, thresholds) |
| GET | `/api/config` | Thresholds, indices, OpenCV operations and presets |
| GET | `/api/dashboard` | Aggregate metrics for the dashboard |
| GET | `/api/datasets` | List datasets in `data/raw` |
| GET | `/api/datasets/{name}` | Metadata + validation for one dataset |
| GET | `/api/datasets/{name}/preview` | PNG quicklook of a raster |
| GET | `/api/datasets/{name}/footprint` | Raster extent as GeoJSON |
| GET | `/api/aoi` · `/api/aoi/{name}` | List / inspect field boundaries |
| POST | `/api/aoi` | Validate an AOI (inline GeoJSON or a stored file) |
| GET | `/api/geo/status` | OpenStreetMap providers, policy limits, basemaps and attribution |
| GET | `/api/geo/search` | Forward geocoding — place, address, postcode (Nominatim) |
| GET | `/api/geo/reverse` | Reverse geocoding — name the place at a coordinate |
| GET | `/api/geo/features` | Real OSM features near a point as GeoJSON (Overpass) |
| POST | `/api/geo/aoi-from-point` | Field boundary built around a location picked on the map |
| GET | `/api/satellite/catalogue` | Real satellite collections, bands, licences and read limits |
| GET | `/api/satellite/scenes` | Real Sentinel acquisitions over a field (STAC), least cloudy first |
| POST | `/api/satellite/fetch` | Download that field's window of a real scene into `data/raw` |
| POST | `/api/upload` | Upload rasters, GeoJSON or CSV into `data/raw` |
| POST | `/api/ndvi` | NDVI (or NDRE / EVI / SAVI) field analysis |
| POST | `/api/crop-health` | Health classes, zones, weak vegetation, anomalies |
| POST | `/api/opencv/process` | OpenCV pipeline on a raster band or an upload |
| POST | `/api/segmentation` | Threshold / Otsu / multi-threshold / zones / model |
| POST | `/api/timeseries` | Observations → trend, change, health trajectory |
| GET | `/api/agronomy/models` | Catalogue of the seven models with crop/soil coefficients |
| POST | `/api/agronomy/thermal-time` | Daily temperatures → GDD, crop stage, days to next stage |
| POST | `/api/agronomy/water-balance` | ET₀ + rainfall → FAO-56 depletion balance and irrigation plan |
| POST | `/api/agronomy/zones` | Index raster → contiguous management zones |
| POST | `/api/agronomy/prescription` | Zone table → variable-rate product plan |
| POST | `/api/agronomy/carbon` | Practice profile → soil-carbon screening with its gap list |
| POST | `/api/agronomy/yield-forecast` | Seasonal index integral → estimate, or a calibration recipe |
| POST | `/api/agronomy/disease-risk` | Weather window → per-pathogen favourability, not a diagnosis |
| GET | `/api/security` | Live security posture: headers, limits and their caveats |
| GET | `/api/results` | List stored results (`?kind=&dataset=&limit=`) |
| GET | `/api/results/{id}` | One stored result with its assets |
| GET | `/api/results/{id}/assets/{file}` | Download a generated asset |
| POST | `/api/samples/synthetic` | Generate the labelled demo scene |

**NDVI example**

```bash
curl -X POST http://localhost:8000/api/ndvi \
  -H 'Content-Type: application/json' \
  -d '{
        "dataset": "synthetic_fields.tif",
        "aoi": "synthetic_fields.geojson",
        "index": "NDVI",
        "observation_date": "2026-06-15"
      }'
```

```jsonc
{
  "result_id": "ndvi-20260926T030851-4ce166",
  "index": "NDVI",
  "statistics": { "min": 0.064, "max": 0.842, "mean": 0.517, "median": 0.540, "std": 0.131 },
  "health": { "classes": [ /* label, range, pixels, percentage, area_ha */ ] },
  "weak_vegetation": { "threshold": 0.4, "patch_count": 81, "largest_patch_ha": 519.7 },
  "interpretation": { "verdict": "Developing canopy", "points": [ /* … */ ] },
  "assets": [ /* ndvi_map.png, ndvi_overlay.png, crop_health_map.png … */ ]
}
```

**Band mapping.** If a raster has no band descriptions, pass one explicitly —
Vibes Lite will report that it assumed a mapping otherwise:

```jsonc
{ "dataset": "drone_flight.tif", "band_map": { "red": 3, "nir": 4 } }
```

**Errors** are returned as JSON with an error class and a 4xx/5xx status:
`{"error": "DataError", "detail": "Unknown operation 'clahe'. Available: …", "status": 400}`.

---

## The first POC

End to end in about two minutes, no real data required:

1. `docker compose up --build` (or the two local dev servers).
2. Open **http://localhost:5173** — the Dashboard shows the platform state.
3. Either upload your own GeoTIFF + GeoJSON on **Fields**, or open **Satellite**,
   search a place, pick the field centre and download a real Copernicus Sentinel-2
   acquisition covering it (the generated sample scene on the Dashboard is the
   offline fallback).
4. On **NDVI**: pick the dataset, pick the field boundary, choose `NDVI`, run.
   You get the statistics, the vegetation map and the boundary overlay.
5. On **Crop Health**: run the analysis and read the class distribution, the
   weak patches and the interpretation panel.
6. On **Computer Vision**: pick a raster band (or upload an image), choose a
   preset, run it, and compare before/after.
7. On **Time Series**: select the demo CSV (or stored results) and read the
   trend and change detection.
8. **Results** lists everything produced; every asset is downloadable, and the
   same data is available at `/api/results`.

---

## NDVI workflow

```
dataset (GeoTIFF)                     AOI (GeoJSON)
        │                                   │
        ▼                                   ▼
  validate + metadata            validate + reproject + area
        │                                   │
        └───────────────┬───────────────────┘
                        ▼
              windowed clip + rasterised AOI mask
                        ▼
                 band stack (RED, NIR)
                        ▼
        NDVI = (NIR − RED) / (NIR + RED)        ← NaN-safe, nodata-aware
                        ▼
   statistics (min/max/mean/median/std/percentiles)
                        ▼
   crop-health classes (configurable thresholds) → zones
                        ▼
   weak-vegetation patches + anomalies (relative to the field)
                        ▼
   maps, overlays, histogram, distribution chart → outputs/<result-id>/
                        ▼
             result record (+ cache key) in the library
```

**Interpreting it.** NDVI measures canopy vigour from reflectance. Class
thresholds are `config.yaml` values, not universal truths — calibrate them for
your crop and sensor. Weak zones and anomalies are *scouting targets*: a single
snapshot cannot distinguish nutrient stress, waterlogging, pests or disease.

---

## OpenCV workflow

```
image source: raster band (RGBA→gray) or uploaded PNG/JPEG
        ▼
preprocessing   grayscale · resize · denoise (NLM/bilateral) · blur
        ▼
enhancement     CLAHE · gamma · unsharp
        ▼
masking         threshold · Otsu · adaptive · range (NDVI > 0.4 …)
        ▼
morphology      open · close · erode · dilate · gradient · clean_mask
        ▼
analysis        connected components · contours · areas · coverage
        ▼
outputs         before.png · after.png · before_after.png · contours_annotated.png
```

Presets (`enhance`, `edges`, `clean_binary`, `veg_mask`) are defined once in
`backend/opencv.py` and exposed through `/api/config`, so the UI and the API
can never drift apart. Every operation is also a plain function usable from
scripts and notebooks.

---

## Frontend usage

| Page | What it does |
|---|---|
| **Dashboard** | Platform totals, average NDVI, healthy/low shares, latest analysis with map, NDVI summary, health distribution, recent activity, dataset table |
| **Fields** | Upload datasets, browse boundaries, validate an AOI, inspect metadata (area, CRS, bands), search or click a real OpenStreetMap location and turn it into a boundary, then start an analysis |
| **Satellite** | Search the Copernicus catalogue over a picked field, list real acquisitions by date and cloud cover, download that field's window as a GeoTIFF (with reflectance, SCL cloud mask and provenance) and run NDVI on it |
| **NDVI** | Run NDVI (or NDRE/EVI/SAVI), see the vegetation map with a legend, statistics and the value distribution |
| **Crop Health** | Health map, class distribution, weak-vegetation map, zones and the interpretation panel |
| **Computer Vision** | Pick a raster band or upload an image, choose a preset or build a pipeline, compare before/after |
| **Time Series** | Index trajectory, trend, change detection and health over time |
| **Results** | Everything produced so far, with download links and stored payloads |

Maps use Leaflet with real OpenStreetMap basemaps — **OSM Street (the default)**,
OSM Humanitarian and OSM Terrain — plus Esri satellite and a blank canvas for
overlays only. The basemap list is served by `/api/geo/status`, so the map, the
service worker and the CSP allowlist all read the same catalogue. Analysis
overlays are served from `/outputs/<result-id>/...` and positioned from the
bounds recorded with each asset.

### OpenStreetMap (real maps, real places)

The platform talks to three OpenStreetMap services, all **server-side**:

| Provider | What it gives the map | Terms we enforce |
|---|---|---|
| **Nominatim** | place/address/postcode search and reverse geocoding of any clicked point | max 1 request/second, identifying `User-Agent` |
| **Overpass API** | real roads, tracks, ditches, water, land use, buildings and hedges near a field, as GeoJSON | radius- and feature-capped, cached, one spaced retry on 5xx, **never** retried on 429 |
| **OSM raster tiles** | the street / humanitarian / terrain basemaps | donated capacity: interactive use, no bulk download or AOI prefetch |

Why proxied instead of called from the browser: the Nominatim policy is
enforceable in one place here and not in a tab, the browser keeps
`connect-src 'self'` (no third-party origin to exfiltrate through), and replies
are cached so a repeated lookup costs the public services nothing. A provider
that is unreachable, disabled or rate-limited returns a `409`/`503` naming the
reason — the platform never invents a place name, a coordinate or a feature.

**Pick a field on a real map.** Search a place (or click the map), and the
reverse geocoder names what is there. *Use this point* turns that coordinate
into a real AOI: the square (or circle) is laid out in the local UTM zone, so a
12 ha request stores a 12 ha boundary, validated through the same path as an
uploaded GeoJSON and immediately selectable in the analysis picker.

Data is © OpenStreetMap contributors under **ODbL 1.0**. The credit is rendered
under every map with a link to the copyright page, because attribution is a
licence condition rather than a courtesy — and it is mirrored in
`/api/geo/status` and on the Security page.

### Real satellite imagery (real acquisitions, real reflectance)

The **Satellite** page pulls an actual Copernicus acquisition of an actual
field. Three server-side steps, no synthetic substitute anywhere:

| Step | Endpoint | What it really does |
|---|---|---|
| Discover | `GET /api/satellite/scenes` | STAC search over the field's footprint, filtered by date window and cloud cover, least cloudy first |
| Fetch | `POST /api/satellite/fetch` | reads only that window of the band COGs over HTTPS range requests |
| Analyse | `POST /api/ndvi` (or any other) | the stored GeoTIFF is already a normal dataset in `data/raw` |

```bash
# what is over my field, newest and least cloudy first?
curl "http://localhost:8000/api/satellite/scenes?lat=52.531&lon=5.573&radius_m=700&days=200&max_cloud=10"

# download that field's window of the best acquisition
curl -X POST http://localhost:8000/api/satellite/fetch -H 'Content-Type: application/json' \
  -d '{"lat": 52.531, "lon": 5.573, "radius_m": 700, "days": 200, "max_cloud": 10}'

# and analyse it exactly like an upload
curl -X POST http://localhost:8000/api/ndvi -H 'Content-Type: application/json' \
  -d '{"dataset": "sentinel2_S2C_31UFU_20260625_0_L2A_50e36e08.tif", "index": "NDVI"}'
```

**Radiometry is carried through, never guessed.** Sentinel-2 L2A band files
store digital numbers that scale to reflectance, and two conventions exist —
picking the wrong one silently rescales every index built on top of the scene.
These COGs have `BOA_ADD_OFFSET` already applied to their pixel values, which the
item reports as `earthsearch:boa_offset_applied = true`; the published `offset`
is therefore **not** reapplied, and the choice is recorded in the GeoTIFF tags,
returned in the API payload and shown in the UI. The rule was verified against
the data rather than the metadata alone: an in-window area the Scene
Classification Layer marks 100 % water reads `0.03` red reflectance one way and
an impossible `-0.07` the other. A scene that publishes no scale at all is
refused instead of assumed, and a scene that is entirely cloud or no-data over
the field is a named error rather than an empty raster.

Pixels are only read from hosts in `satellite.asset_hosts`; the radius, scene
count, cloud ceiling and pixel budget are capped in configuration; a field that
does not overlap the scene is reported. Band descriptions (`B02`…`B11`) are
written into the GeoTIFF, so the platform's band resolver maps red/NIR/red-edge/
SWIR1 with no hint and reports that it did so. Data is Copernicus Sentinel data
under the free and open Copernicus licence; attribution is in the file tags, the
API payload and the UI.

---

## Configuration

`config.yaml` is the single source of truth; environment variables override it
(see `.env.example`).

```yaml
project:  { name: Vibes Lite, version: 0.1.0 }
paths:    { raw_data: data/raw, processed_data: data/processed, outputs: outputs }
analysis:
  default_index: NDVI
  max_analysis_pixels: 4000000        # decimate rather than exhaust memory
  fallback_bands: { blue: 1, green: 2, red: 3, nir: 4 }
crop_health:
  thresholds: { very_low: 0.20, low: 0.40, moderate: 0.60, healthy: 0.80 }
  min_patch_area_ha: 0.05
opencv:  { enabled: true, denoise_h: 7, gaussian_kernel: 5, canny_low: 50, canny_high: 150 }
visualization: { enabled: true, dpi: 130, figure_size: [8.5, 7.0] }
timeseries: { min_observations: 2 }
api: { host: 0.0.0.0, port: 8000, cors_origins: "*" }
osm:                                  # OpenStreetMap services (all server-side)
  enabled: true
  nominatim_url: https://nominatim.openstreetmap.org
  overpass_url: https://overpass-api.de/api/interpreter
  user_agent: VibesLite/0.1 (agriculture field intelligence)
  contact: ""                         # set to a real contact for public deployments
  min_interval_seconds: 1.1           # the Nominatim policy is 1 request/second
  cache_seconds: 900
  max_radius_m: 5000                  # Overpass radius ceiling
  max_features: 400                   # features returned per query
satellite:                            # real Sentinel-2 ingestion (all server-side)
  enabled: true
  stac_url: https://earth-search.aws.element84.com/v1/search
  asset_hosts: [sentinel-cogs.s3.us-west-2.amazonaws.com, sentinel-cogs.s3.amazonaws.com]
  default_collection: sentinel-2-l2a
  max_radius_m: 5000                  # field half-width ceiling
  max_scenes: 20
  max_cloud_cover: 60
  max_pixels: 2000000                 # per-band read budget before decimation
  window_days: 120
security:
  max_upload_mb: 200
  allowed_raster_ext: [".tif", ".tiff", ".vrt", ".img"]
```

Environment overrides: `VIBES_PROJECT_NAME`, `VIBES_CONFIG`,
`VIBES_RAW_DATA_DIR`, `VIBES_PROCESSED_DATA_DIR`, `VIBES_OUTPUTS_DIR`,
`VIBES_MAX_UPLOAD_MB`, `VIBES_CORS_ORIGINS`, `VIBES_HOST`, `VIBES_PORT`,
`VIBES_OSM_ENABLED`, `VIBES_NOMINATIM_URL`, `VIBES_OVERPASS_URL`,
`VIBES_OSM_USER_AGENT`, `VIBES_OSM_CONTACT`, `VIBES_OSM_MAX_RADIUS_M`,
`VIBES_SATELLITE_ENABLED`, `VIBES_STAC_URL`, `VIBES_SATELLITE_USER_AGENT`,
`VIBES_SATELLITE_CONTACT`, `VIBES_SATELLITE_MAX_RADIUS_M`,
`VIBES_SATELLITE_MAX_PIXELS`, `VIBES_SATELLITE_MAX_CLOUD`,
`VIBES_SATELLITE_DEFAULT_COLLECTION`
(plus `VITE_API_BASE_URL`, `VITE_API_PROXY_TARGET` for the frontend).
Point the OSM URLs at your own Nominatim/Overpass instance on a deployment that
cannot use the public ones; `VIBES_OSM_ENABLED=false` switches the integration
off and every geo endpoint then fails loudly instead of degrading silently. The
satellite provider works the same way: `VIBES_STAC_URL` can point at a private
STAC catalogue and `VIBES_SATELLITE_ENABLED=false` disables scene search and
fetch outright.

**Crop AI console.** The console needs no `.env` — its runtime config is
environment variables plus a JSON file the UI edits:

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `5177` | console API + UI port |
| `AI_PROVIDER` | from `ai-config.json` | crop model: `generic`, `openai` or `disabled` |
| `AI_API_URL` | — | e.g. `http://localhost:5199/predict` |
| `AI_MODEL` | — | e.g. `crop-vision` |
| `AI_API_KEY` | — | sent as a bearer token when set |
| `AI_TIMEOUT_MS` | `45000` | crop-model call timeout |

Anything not set there is read from `crop-ai/data/ai-config.json`, which the
**AI Model** tab edits and saves at runtime. The file holds two independent
blocks: the crop-analysis pipeline and the species-identification endpoint.

State lives in `crop-ai/data/` — plain JSON files, safe to back up or diff:

| File | Contents |
|---|---|
| `fields.json` | uploaded fields, tile grids, geotags |
| `sensors.json` | sensor registry, device tokens, reading history |
| `models.json` / `dataset.json` | trained kNN models and labeled tiles |
| `ai-config.json` | both AI endpoints (crop + identify) |
| `identifications.json` | species identification history |
| `uploads/` | original imagery, generated tiles and overlays |

---

## Testing

```bash
.venv/bin/python -m pytest tests -q          # 294 tests, ~10 s
node --test crop-ai/server.test.js           # 34 console tests, ~13 s
npm run test:all                             # both suites, one command
```

| File | Covers |
|---|---|
| `test_indices.py` | NDVI formula, division-by-zero, nodata, band resolution, statistics |
| `test_analysis.py` | health classification, configurable thresholds, zones, weak patches, anomalies, interpretation |
| `test_geospatial.py` | CRS units, AOI validation and area, windowed clipping, decimation, masking, polygons |
| `test_opencv.py` | masks, morphology, contours, overlays, pipeline operations, before/after |
| `test_segmentation.py` | threshold / Otsu / multi-threshold, components, refinement, GeoJSON export |
| `test_timeseries.py` | observations, trend, change detection, health trajectory |
| `test_agronomy.py` | GDD methods and cut-outs, FAO-56 depletion and irrigation triggers, k-means zones, prescription clamping, carbon contributions, yield calibration refusal, disease rules |
| `test_agronomy_api.py` | the seven agronomy endpoints over HTTP, Pydantic bounds, engine validation surfacing as `400` not `500`, and the security posture |
| `test_api.py` | health, project, datasets, AOI, upload validation, NDVI endpoint, results, errors |

The suite uses generated fixtures (a small scene written to a temporary
directory), so it never depends on the contents of `data/raw`.

**Console suite (`crop-ai/server.test.js`)** — 34 tests on Node's built-in test
runner, no extra dependencies. It boots the server exactly the way Vercel does
(`VERCEL=1`, no `listen()`, state seeded into a private temp directory) and
drives it over real HTTP: the data-integrity contract (seed/demo routes stay
`404`), device token auth (`401`), **timing-safe token comparison**, the sensor
lifecycle (register → ingest → clamp → delete), **per-route rate limits that are
actually enforced rather than only advertised**, **path-traversal rejection on
the static handler**, the pure agronomy helpers (soil-moisture fill values,
per-metric attribution, geometry, both AI normalizers), the workflow engine
(DAG validation, cycle rejection, hash caching, and that a sensor reading
re-runs only the sensor-dependent nodes), and the OSM provider layer (every
basemap host present in the CSP, requests validated before any upstream call,
bounded Overpass queries, elements attributed to exactly one class,
undrawable elements dropped rather than rendered, and a map-picked point
written onto a field). One test exercises the live connectors, so it needs
network access; everything else runs offline.

**Live sweeps — the layers that drive the running app end to end:**

| Command | What it covers |
|---|---|
| `node tools/qa_sweep.mjs` | 73 checks across all 46 console routes: success **and** error paths, `401` device auth, the data-integrity contract (demo routes `404`), workflow caching, identify round-trips. Read-only apart from a disposable device. |
| `bash tools/ui_sweep.sh [session]` | Real browser input through all nine tabs and every button (`agent-browser` CLI), one screenshot per tab plus a toast/console log into `qa-evidence/`. |
| `bash tools/ui_sweep2.sh [session]` | Second pass that collects page errors **in-page** (`window.onerror` + `unhandledrejection`) and locates buttons by visible text — the authoritative "zero console errors" check. |
| `node tools/vercel_harness.js` | 15 cold-start checks of the serverless entry point (no auto-listen, `/tmp` seeding, API + static serving, demo routes `404`). |

The sweeps need the console running (`./start.sh` or `.venv/bin/python tools/cropai_server.py start`) and network access for the connector checks. Two harness limits, both harmless to the app: `agent-browser upload` injects a file path that Chromium refuses to read into a multipart body — build the `FormData` in-page instead (proved working with a 499 KB photo) — and headless Chromium can be denied camera/geolocation, which exercises the app's error paths (both degrade with an honest toast).

---

## Notebooks

Eight executable demonstrations, runnable from `notebooks/` or the repository
root (they add `backend/` to `sys.path`):

| Notebook | Contents |
|---|---|
| `01_basic_setup.ipynb` | Configuration, capabilities, dataset inventory, raster metadata |
| `02_load_aoi.ipynb` | Boundaries, CRS, inline GeoJSON validation, AOI/raster overlap |
| `03_ndvi.ipynb` | Band resolution, windowed clip, NDVI, statistics, map, all four indices |
| `04_crop_health.ipynb` | Classes, zones, weak patches, anomalies, interpretation, visual bundle |
| `05_opencv.ipynb` | Enhancement, masking, morphology, contours, pipeline metrics |
| `06_segmentation.ipynb` | Threshold / Otsu / multi-class, components, GeoJSON export, model registry |
| `07_time_series.ipynb` | CSV observations, trend, change detection, chart, stored results |
| `08_final_demo.ipynb` | The whole pipeline end to end, saved as a result |

They drive the engines directly (no HTTP layer), which makes them useful for
debugging and for extending the platform. All eight were executed headlessly
during development; every cell runs on the bundled demo scene.

---

## Security and performance

**Headers** — every response, error responses included, carries a Content
Security Policy that denies inline script and external origins (`default-src
'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`), plus
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a referrer policy, a
permissions policy that closes microphone, payment and USB, and Cross-Origin
Opener/Resource-Policy. The CSP allow-lists are derived from the assets the app
actually loads — the OpenStreetMap tile hosts are read straight off the basemap
catalogue, so a basemap added there cannot be missing from the policy, and a
basemap removed there cannot leave the policy pointing at a host nothing loads.
A test asserts both directions on each side (Python and the console suite).

**No third-party script dependency.** Leaflet is bundled into the dashboard and
vendored into the console (`crop-ai/public/vendor/leaflet`, BSD-2-Clause), so
the console's `script-src` is now exactly `'self'` and a map still renders on a
field laptop with a restrictive network.

The remaining external requests are images and one stylesheet: map tiles from
the OSM/Esri hosts named in `img-src`, and the Google Fonts stylesheet, which is
a progressive enhancement (the CSS font stack covers it — if `fonts.googleapis.com`
is unreachable the app renders in the fallback face and nothing breaks).

**Rate limits** — three tiers (`read` 1200/min, `write` 240/min, `analysis`
120/min) counted per client address, with `RateLimit-*` headers on every response
and `Retry-After` on a `429`. The tier is decided by route prefix, so a heavy
NDVI run cannot starve the dashboard. Limits are evaluated per worker process;
the `/api/security` endpoint and the dashboard's Security page both say so
rather than implying a global budget.

**Hygiene** — no credentials in the code; `.env` support with a documented
example; extension allow-lists per file kind; safe filenames (path-traversal and
absolute-path attempts are rejected); upload size limit (`security.max_upload_mb`,
200 MB by default); errors return clean JSON without filesystem internals and
unhandled exceptions never leak a traceback to the client; CORS restricted to
configured origins and a wildcard origin with credentials is refused at the
middleware level.

**Inspectable, not asserted** — `GET /api/security` returns the live posture:
the header list, the full CSP, the three limits, the classification rules, the
accepted file extensions and the runtime configuration. The dashboard renders it
on a Security page. The payload also states the thing that *is* still missing:
there is no user authentication, no multi-tenant isolation and no audit log, so
terminate TLS and put an authenticating reverse proxy in front before exposing
this API to the public internet.

**Performance** — raster reads are windowed to the AOI instead of loading whole
scenes; analysis respects `max_analysis_pixels` by decimating (using overviews
when present) and says so in the warnings; repeat analyses of the same input hit
the result cache; raw and processed data are kept separate; visualization only
runs when `include_visuals` is true.

---

---

## Crop AI module

A second, self-contained way to use Vibes Lite: **AI Crop Monitoring from
Drone/Camera Images** — production edition. A drone or phone photo is cut
into tiles, tiles are labeled into crop-condition classes, a model is trained
with cross-validated metrics, and any new image is classified back onto a
**georeferenced farm map** on satellite imagery — with **real weather**,
**real wind** and **real device sensor ingest**. All of it lives in `crop-ai/`
with a **single-file backend** (`server.js`) and a dense, motion-rich field
console (no build step) — Space Grotesk/Inter/JetBrains Mono typography, tabular
numerals on every measured value, animated KPI count-ups, staggered tab
reveals and a live SSE activity feed.

**No synthetic data.** This build ingests real imagery only: there are no
fake-field generators, no simulated sensor values and no demo endpoints. A
boot sanitizer removes any legacy synthetic artifacts from the store, and
every number the console shows is traceable to an EXIF header, the Open-Meteo
API, a device reading, or your own labeled tiles.

**Real-data paths**

* **Georeferencing** — EXIF GPS is extracted on upload (drone/phone photos
  carry it automatically); no-GPS images can be geotagged in the UI or via
  `POST /api/fields/{id}/geotag`. The field becomes a metric footprint
  (GeoJSON polygon + per-tile classification polygons).
* **Geo map with agronomy layers** — the Geo Map tab paints the field on
  **OSM Street (default) / OSM Humanitarian / OSM Terrain** — plus Esri World
  Imagery and Google Satellite/Hybrid — basemaps (Leaflet) through a **layer
  switcher** with eleven drawable layers:
  classification, vegetation vigor, canopy cover, plant health, weed
  pressure, soil condition, soil texture, and the four probe-measured
  layers — **soil moisture, soil pH, soil EC and soil temperature**.
  Every tile carries its real WGS84 centre; click any tile for its full
  readout. GeoJSON exports open directly in QGIS / Google Earth.
* **OpenStreetMap search, naming and features** — a search box resolves any
  place, address or postcode through Nominatim; clicking the map names the spot
  you clicked and offers it as the focused field's location
  (`POST /api/fields/{id}/geotag`); and an **OSM features** switch draws the real
  roads, tracks, ditches, water, land use, buildings and hedges around the field
  from Overpass, as GeoJSON with per-class colours served by the API. All of it
  is proxied through the console server, so the browser never talks to a third
  party. A provider that is down says so on the map instead of drawing nothing.
* **Your location** — one button asks the browser for a GPS fix, drops a
  marker on the map and reports the distance to the nearest georeferenced
  site, so you can check a field against where you are standing.
* **Live weather, wind and soil** — Open-Meteo (free, no key) provides air
  and feels-like temperature, humidity, precipitation, rain today, ET0,
  cloud cover, pressure, wind speed **direction and gusts**, plus satellite
  soil moisture at two depths, per field location. The map draws a **wind
  arrow** across each field; the side panel renders a compass rose with
  Beaufort force and a spraying-window advisory. Where the upstream model has
  no soil-moisture value for a grid cell (Open-Meteo reports exactly `0`, its
  fill value) the field is left blank rather than shown as `0%`, so the advice
  falls back to a real in-ground probe instead of a false critical alert.
* **Weather for every date back to 1940, and Windy for the map** — the
  console also reads the ERA5 / ERA5-Land reanalysis archive, so any date in a
  field's history can be asked for by name: temperature, rain, wind, humidity,
  radiation, FAO-56 ET0 and soil moisture, one row per day, each row naming the
  endpoint and model family that answered it. Days the archive has not
  published yet fall back to the forecast endpoint's recent record and say so;
  an unreported day stays `null` rather than being interpolated. On top of that
  sits Windy's own embed map in the Geo tab — wind, gusts, rain, temperature,
  humidity, cloud and pressure layers centred on the field — with the required
  clickable Windy credit. **The map is Windy's, the numbers are not:** Windy's
  API publishes forecasts only ("It is not possible to retrieve historical
  forecasts with past data") and its free key returns randomly shuffled data,
  so no value in the console is ever read from Windy. `GET /api/sources`
  publishes it under `visualizations`, kept deliberately separate from the data
  sources.
* **Many sensors, grouped by site** — sensors are a first-class registry.
  `POST /api/fields/{id}/sensors` installs one and returns a `deviceId` plus
  its own ingest token. Each site lists exactly which sensors are deployed,
  what type each one is, what metric it is fetching, its live value, a trend
  sparkline of its last 40 readings, every other metric in its latest packet,
  and a liveness pill (`live` / `stale` / `offline` / `no-data`). Sensors are
  also drawn as markers on the geo map and coloured by status.
  Types: soil probe, weather station, anemometer, rain gauge, soil
  temperature, pH/EC probe, light sensor, field camera, generic.
* **Device sensor ingest** — any device (ESP32/Arduino/RPi/phone) can POST
  real readings: `POST /api/fields/{id}/ingest` with header
  `X-Sensor-Token: <token>`. Add `?deviceId=S-xxxxxx` to attribute the
  reading to one specific installed sensor — each probe then keeps its own
  independent history. Accepted keys: `soilMoisture %, temperatureC,
  humidityPct, ph, ec, rainMm, soilTempC, windKmh, lightLux, battery`.
* **Irrigation engine** — fuses device readings (priority) → satellite soil
  moisture from the weather API, always reporting its data sources. With no
  data source connected it reports INSUFFICIENT DATA instead of guessing.

**The 6-stage pipeline**

1. **Ingest** — upload or camera-capture real imagery (EXIF georef
   automatic; manual geotag otherwise).
2. **Tile** — the image is cut into a grid (default 50 px tiles).
3. **Train** — label tiles in the browser (HEALTHY / STRESSED / SOIL /
   WEED); 13-dim features (RGB stats, excess-green, VARI,
   OpenCV-wasm texture/edges) → cosine kNN with **5-fold cross-validation**
   (accuracy, per-class precision/recall/F1, confusion matrix shown in the
   Model Lab).
4. **Test** — `POST /api/tile` classifies any unseen tile image.
5. **Analyze** — `POST /api/predict` classifies every tile → heat overlay
   PNG + per-class percentages + recommendation.
6. **Smart farm** — real weather + device telemetry + crop condition →
   irrigation advice and alerts, live over SSE.

**Run it**

```bash
./start.sh                       # → http://localhost:5177
./start.sh --mock-ai             # also boots the reference AI model
```

Full setup, ports, manager scripts, deployment and troubleshooting live in
[Running everything](#running-everything) and [Deployment](#deployment).

One process boots the API and the console. (`cd crop-ai && npm install &&
npm start` works too; `npm install` runs automatically on first launch.)

The console has eight tabs: **Operations** (ingest, registry, pipeline
status), **Labeling Studio**, **Model Lab** (metrics & confusion matrix),
**AI Model** (external vision-model endpoint), **Analysis** (overlay +
composition + recommendation), **Geo Map** (layer switcher, wind rose, live
site conditions, sensor markers), **Sensors** (sites → sensors → live values,
sensor registration, ingest endpoint, reading history, activity feed) and
**Applications** — an honest showcase of field missions (plant health,
growth, disease scouting, weed detection, soil condition, ripeness/sorting,
custom-class recognition, trials) mapped to the capabilities the trained
4-class model already provides.

**External AI model** — point the console at any HTTP vision model
(`Generic JSON` or `OpenAI-compatible` shape) under **AI Model**. It sends
`{model, task, classes, image, grid, context}` and reads plant health, weed
area and soil quality back out of the JSON reply. `./start.sh --mock-ai`
boots the bundled reference model ([crop-ai/mock-ai-model.js](crop-ai/mock-ai-model.js))
so you can see the whole chain work before wiring up a real one.

**Plant species identification** — point a phone (or a map tile) at a plant
and the console names it: species, type, confidence, ranked candidates,
health and observable traits. This uses a **separate endpoint** in the same
form (`Species identification endpoint`, defaults to a **local Ollama**
vision model), because naming species needs a different model than 4-class
ground cover:

```bash
ollama pull qwen2.5vl:3b                 # one-time download (~3.2 GB)
.venv/bin/python tools/ollama_server.py   # start local model on :11434
./start.sh                                # starts ollama serve automatically too
```

Then open **AI Model → Species identification endpoint** (pre-filled with
`openai` / `http://localhost:11434/v1` / `qwen2.5vl:3b`), press **Save**, then
**Test identification**. From there: **Camera → Identify plant** for a frame,
or **Identify here** on any Geo Map tile. Every result is stored with time,
GPS/tile and confidence (`GET /api/identify`) — an unreachable model returns
`409`/`502`, never a guessed species. Any OpenAI-compatible vision endpoint
(`gpt-4o`, a GPU box) or generic JSON model can be dropped in the same field.

**Key endpoints** — `POST /api/upload` · `POST /api/fields/{id}/geotag` ·
`POST /api/label` · `POST /api/dataset/from-labels` · `POST /api/train` ·
`POST /api/tile` · `POST /api/predict` ·
`GET /api/fields/{id}/layers` (every drawable map layer + site conditions) ·
`GET /api/fields/{id}/geojson` · `GET /api/fields/{id}/report` ·
`GET /api/sensors/sites` (all sites with their sensors) ·
`POST /api/fields/{id}/sensors` (register) ·
`DELETE /api/fields/{id}/sensors/{deviceId}` ·
`POST /api/fields/{id}/ingest` (device, `?deviceId=` to attribute) ·
`GET /api/ai/status|config|report` · `POST /api/ai/config|test|tile|field` ·
`POST /api/ai/identify` (camera frame or `{fieldId, r, c}` map tile) ·
`GET /api/identify` (stored identifications) ·
`POST /api/ai/test-identify` (round-trip, not saved) ·
`GET /api/events` (SSE) · `GET /api/fields/{id}/overlay.png`

**Fusion sources and workflow DAG (CP9 / CP10)** — the console fetches real
public datasets: Sentinel-2 L2A and Sentinel-1 GRD scenes through the Earth
Search STAC catalogue, Copernicus DEM elevation with derived slope/aspect, and
NASA POWER daily agrometeorology cross-checked against Open-Meteo. Every
fetched value carries its product, endpoint, attribution and fetch time, and a
source that cannot be reached fails loudly instead of being replaced by
invented data. On top of those connectors, workflows are DAGs of
fetch → prepare → infer nodes whose results are cached by an input hash — a new
satellite pass, a re-geotagged field or a fresh sensor reading re-runs only the
nodes that depend on that change.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/sources` | Registry of the six real datasets with last-fetch times, plus Windy as a `visualizations` entry |
| GET | `/api/fields/{id}/satellite` | Sentinel scenes (`?collection=sentinel-2-l2a\|sentinel-1-grd&days=&maxCloud=&limit=`) |
| GET | `/api/fields/{id}/terrain` | Elevation, relief, slope, aspect and drainage (Copernicus DEM) |
| GET | `/api/fields/{id}/weather-crosscheck` | Open-Meteo vs NASA POWER over the days both report |
| GET | `/api/fields/{id}/weather/history` | Daily reanalysis for any window (`?start=&end=`), 1940 → today |
| POST | `/api/fields/{id}/weather/for-dates` | Weather on named dates (`{ dates: [...] }`) — dates an image |
| GET | `/api/weather/windy` | Windy's own embed map for a field (`?fieldId=&overlay=`) — a map, never a number |
| GET | `/api/location` | The stored device fix, its age, staleness and nearest registered field (`404 NoLocation` when none) |
| POST | `/api/location` | Store a fix from the device (`{ lat, lon, accuracyM?, altitudeM?, capturedAt? }`), broadcast on the event stream |
| DELETE | `/api/location` | Forget the fix — used when a laptop moves or a console is shared |
| GET | `/api/location/live` | Live weather, place, 7-day reanalysis, Sentinel-2 scenes, terrain, OSM context and a NASA POWER cross-check for the stored fix (or `?lat=&lon=`) |
| GET | `/api/workflows` | Workflow definitions: nodes, kinds, dependencies, edges |
| GET | `/api/workflows/{id}` | One workflow definition |
| POST | `/api/workflows/{id}/run` | Run it for a field (`{ fieldId, force, params }`) |
| GET | `/api/workflows/{id}/runs` | Run history (`?fieldId=&limit=`) |
| GET | `/api/workflow-runs/{runId}` | One run including per-node outputs |
| POST | `/api/workflow-runs/clear` | Clear run history (all, or one field) |

Three workflows ship: **local-agronomy** (5 nodes, no network — tile
classification, irrigation advisory, soil index, field report),
**field-refresh** (11 nodes — Sentinel-2 and Sentinel-1 scenes, live weather,
the NASA POWER cross-check, DEM terrain, a context merge, then the agronomy
nodes) and **imagery-window** (3 nodes — the least-cloudy acquisition pick that
cloud-free compositing needs). The **Workflows** tab runs them with one button
and lists exactly which nodes executed and which were reused, per run.

**Windy is the map; the archive is the numbers.** The Geo tab embeds Windy's
own forecast map — wind, gusts, rain, temperature, humidity, cloud and
pressure layers, centred on the chosen field, with the clickable attribution
Windy's terms require. It is a visualisation and nothing else: Windy's API
returns forecasts only ("It is not possible to retrieve historical forecasts
with past data"), its free testing key "returns randomly shuffled and slightly
modified data", and its paid tier has no radiation, no evapotranspiration and
no soil moisture. So the Windy map can never answer for a past date, and no
number in this console is read from it — those come from the reanalysis
archive above, which does reach 1940. `GET /api/sources` reports Windy under
`visualizations`, deliberately separate from the data sources, and the test
suite asserts both halves of that split so a later edit cannot quietly promote
a map into a measurement.

**My location — the device's own fix, not a typed coordinate.** The Geo tab
leads with the console asking the browser where the device actually is
(`navigator.geolocation`), and everything it then reports is fetched for *that*
point: live weather, the last 7 days of reanalysis rain and ET₀, Sentinel-2
passes, elevation and slope, the OpenStreetMap features around you, and a NASA
POWER second opinion. One server call (`GET /api/location/live`) runs those
seven providers in parallel; each part carries its own error, so one dead
upstream leaves the rest of the panel standing and names the part that failed.
The fix is stored server-side in `data/location.json`, which is why the same
location serves every tab and every console on the LAN — and why `Follow`
(watchPosition) only writes when the device has genuinely moved more than 5 m,
rather than turning a 1 Hz GPS stream into a 1 Hz writer.

The rules that make it trustworthy:

- **It never invents a location.** With no stored fix and no coordinates
  supplied, `GET /api/location` answers `404 NoLocation` and the location-scoped
  reads answer `409` — no default, no sample coordinate, no `(0, 0)`.
- **`(0, 0)` is rejected.** It is what a GPS stack returns when it has no fix at
  all (Null Island), and no field is there.
- **Every failure is named.** Denied permission, no GPS radio, a timeout, and a
  non-secure origin are four different messages, because they need four
different fixes. `navigator.geolocation` is only exposed on a secure context,
  so a LAN IP over plain http is told to serve the console over TLS (or open it
  on localhost) instead of being shown a button that quietly fails.
- **A stale fix says so.** Older than 15 minutes, the chip reads `stale` rather
  than presenting an old position as current.

**Honest scope** — the kNN model is trained on *your* labeled tiles; the
reported cross-validation metrics reflect exactly that dataset. Label tiles
from your own fields first — the Model Lab tells you how well the model
generalizes before you trust the farm map.

---

## Deployment

### Crop AI console

The console is a single Node process with no build step; the deployment unit
is `crop-ai/server.js` plus the `crop-ai/data/` folder it persists to. Paths
resolve from the script's own location, so it can be started from any working
directory.

1. Install Node 18+ on the host and run `npm --prefix crop-ai install`.
2. Run it under a process manager so it restarts on failure:

```bash
# pm2 (any OS)
npm install -g pm2
pm2 start crop-ai/server.js --name crop-ai
pm2 save && pm2 startup
```

```ini
# systemd — /etc/systemd/system/crop-ai.service
[Unit]
Description=Vibes Lite Crop AI console
After=network.target

[Service]
WorkingDirectory=/srv/vibes-lite
ExecStart=/usr/bin/node crop-ai/server.js
Restart=always
Environment=PORT=5177

[Install]
WantedBy=multi-user.target
```

3. Put it behind a reverse proxy that terminates TLS and adds
   authentication — the app itself has **no authentication** (see Security
   and performance), so do not expose port 5177 directly to the internet.
4. Health check for the proxy or monitoring: `GET /api/health` returns `200`
   JSON when the console is ready.

**Species identification on another machine.** Ollama does not need to share
the console host: install it on a GPU box, run `ollama serve` there, and set
the identify base URL to `http://<gpu-host>:11434/v1` in the AI Model tab —
or point it at any OpenAI-compatible vision API. When Ollama runs as a
systemd service on the same host, nothing extra is needed: the console
reaches it at `localhost:11434`.

**Resources.** The crop pipeline (kNN + OpenCV-wasm + real weather) is
millisecond work on a small VM. The 3B vision model is a ~3.2 GB download and
wants roughly 4–6 GB RAM while identifying; expect about 10–60 s per photo on
CPU (20–30 s typical) — the 120 s default timeout is sized for that.

**Data and backups.** All console state is `crop-ai/data/` (JSON records
plus `uploads/`); sync that folder and you can rebuild the host from scratch.

### Vercel (serverless)

The console also deploys as a single Vercel Function, so a demo can live on
a public URL without a host to manage.

**How it is wired**

- `api/index.js` re-exports `crop-ai/server.js`; the catch-all rewrite in
  `vercel.json` sends every request to that one function, which serves the
  JSON API, the console files, map tiles and uploads itself.
- `functions.includeFiles` puts `crop-ai/public/**` (console) and
  `crop-ai/data/**` (state + AI config) inside the function bundle;
  `.vercelignore` keeps the Python product, venv and `node_modules` out of
  the upload.
- `server.js` detects `VERCEL`: it never calls `listen()`, skips the
  background weather timer (routes refresh when data is stale), and on cold
  start copies the bundled `crop-ai/data/` into `/tmp/crop-ai-data` — the
  only writable location — before reading and writing state there.

**Deploy**

```bash
npm install -g vercel   # once
vercel login            # once
vercel                  # preview deployment
vercel --prod           # production
```

Or import the repository in the Vercel dashboard (framework preset
"Other"; build settings need no changes — `vercel.json` carries them).

**What changes on Vercel — read before deploying**

| Concern | Behavior |
|---|---|
| Filesystem | Read-only except `/tmp`. Fields, uploads, models, identify history and AI Model tab edits live in `/tmp/crop-ai-data`, which is re-seeded from the bundle on every cold start — nothing survives a new instance. For durable state, commit `crop-ai/data/` and redeploy, or use a real store (Vercel Blob/Postgres); for a long-lived mutable store use pm2/systemd above. |
| Background work | No timers run. Weather refreshes on request behind a 600 s cache; SSE clients can go quiet when an instance sleeps — reload the page. |
| Mock AI (`:5199`) | Not available: `start.sh`, the reference model and local Ollama never run here. The crop pipeline falls back to the local kNN model unless `AI_PROVIDER` / `AI_API_URL` / `AI_MODEL` env vars point at a reachable HTTP endpoint (Project Settings → Environment Variables). |
| Species identification | `identify.baseUrl` is read from `crop-ai/data/ai-config.json`, which ships in the bundle. `localhost:11434` is unreachable from Vercel — edit that file to your GPU host or a hosted vision API and commit it. Saving it in the AI Model tab works too but only lasts until the next cold start. |
| Bundle size | Function limit is 250 MB; the bundle (OpenCV-wasm + console + data) is far below it. |
| Access control | The app has no authentication. Enable Vercel Deployment Protection or put your own auth in front — this is a demo surface, not a secured one. |

**Verify the serverless entry locally** before deploying:
`node tools/vercel_harness.js` loads `api/index.js` with `VERCEL=1`, asserts
it exports the app without opening a port, checks the `/tmp` seed and
sweeps the API and static routes (15 checks, non-zero exit on failure).

### Vibes Lite (API + dashboard)

```bash
docker compose up -d --build
```

`data/` and `outputs/` are bind-mounted, so they survive rebuilds — point
them at persistent volumes in production. Configuration comes from `.env`
(ports, CORS, upload limits). The frontend container proxies `/api` and
`/outputs` to the backend, so only the dashboard port needs publishing;
terminate TLS at your proxy and set `VIBES_CORS_ORIGINS` to your real origin
instead of `*`. Run the suite inside the image with:

```bash
docker compose run --rm vibes-lite-backend pytest -q
```

**Without Docker.** Run the API under any process manager and build the
dashboard once:

```bash
cd backend && uvicorn main:app --host 0.0.0.0 --port 8000   # venv activated
npm --prefix frontend run build                             # static bundle -> frontend/dist
```

Serve `frontend/dist/` from any web server (nginx, Caddy) and route `/api`
and `/outputs` to the API — that proxying is exactly what the dev server and
the frontend container do. Alternatively set `VITE_API_BASE_URL` at build
time to the API origin and allow that origin in `VIBES_CORS_ORIGINS`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port 5177 already in use (`EADDRINUSE`) | another console is running — `.venv/bin/python tools/cropai_server.py stop`, then start again |
| Manager script says `already running` when you wanted a restart | there is no restart verb — `stop`, then `start` |
| Identify returns `409` | the species endpoint is disabled — open **AI Model → Species identification endpoint**, fill provider / base URL / model, press **Save** |
| Identify returns `502` | Ollama is down (`tools/ollama_server.py status`), the model is not pulled (`ollama pull qwen2.5vl:3b`), or the image is too small/blurry to name — try a close-up photo |
| First identification takes a minute | expected on CPU: roughly 10–60 s per image; raise the timeout in the identify endpoint form if needed |
| Console cannot reach `:5199` | the reference model is not running — `./start.sh --mock-ai` or `tools/cropai_server.py start` |
| Map shows grey or identical imagery everywhere | the field's coordinates are over open water — geotag a real land location |
| Soil-moisture tile blank, irrigation advice says insufficient data | Open-Meteo's fill value (`0`) is filtered out on purpose; connect a real probe for moisture-based advice |
| `POST /api/seed` and friends return 404 | by design — the console refuses synthetic/demo data; ingest real imagery instead |
| `docker compose` fails immediately | Docker is not running — start Docker Desktop first |
| `node >= 18 required` | install a current Node from https://nodejs.org |

---

## Known limits

* **No database.** Results are JSON records plus files under `outputs/`.
* **No authentication / multi-user separation.**
* **Sentinel-2 only, optical only, one catalogue.** The satellite provider reads
  Copernicus Sentinel-2 L2A through the Earth Search STAC catalogue; Sentinel-1
  SAR, Landsat and Planet are not wired up. Radar would be the way round the
  cloud problem that limits an optical-only stack.
* **Radiometry stops at reflectance.** The published `BOA_ADD_OFFSET` is handled
  correctly (see *Real satellite imagery*), but no atmospheric correction,
  topographic correction or BRDF normalisation is applied here. Surface
  reflectance from the product is what you get.
* **One window per request.** A fetch stores one scene's window for one field.
  Multi-date composites and per-date batch runs are not automated yet — the
  pieces (fetch, then `/api/timeseries`) exist but nothing chains them.
* **Public catalogue instances are best-effort.** Earth Search and the COG
  hosting are shared infrastructure: an unusual or heavy request can be slow or
  fail after the built-in retry. Point `VIBES_STAC_URL` at a private catalogue
  for a production deployment, and note that the search cache is per-process.
* **No trained ML models.** Segmentation is classical; the registry is the
  extension point for a U-Net / DeepLab / YOLO-seg loader. (The Crop AI
  module's kNN is a working, trained-by-you classifier — accuracy on real
  imagery depends on your labeled tiles.)
* **Weather layers are not implemented** — the merge point is `data.py` plus a
  column in the time-series observations.
* **Single-scene analyses are indicative.** Real agronomic conclusions need
  multiple dates, ground truth and calibrated thresholds.
* **A generated sample scene still exists** (clearly tagged `SYNTHETIC=true`,
  labelled as such on every page that shows it). It is not the default route any
  more: the Dashboard offers *Fetch real satellite imagery* and *Upload your own
  imagery* first, and the sample is a convenience for exercising the pipeline
  offline. Real data comes from the Satellite page or an upload.

---

## Roadmap

1. ~~**Real imagery ingest** — Sentinel-2 L2A / Landsat-8-9 COG readers with
   automatic band mapping and per-scene cloud masking.~~ **Delivered** —
   `backend/satellite.py` reads Sentinel-2 L2A COG windows over HTTP, maps bands
   from the file's own descriptions, and masks cloud through the SCL.
2. ~~**Scene search** — STAC / Copernicus client to fetch a date range for an AOI
   and run the pipeline per date automatically.~~ **Partly delivered** — STAC
   search and a single-scene fetch are live (`/api/satellite/*`); running a whole
   date range automatically is still open. Landsat and Sentinel-1 remain open.
3. **Time-series automation** — seasonal composites, phenology metrics, and
   field-to-field benchmarking against neighbourhood distributions.
4. **Deep segmentation** — plug a U-Net / DeepLab / YOLO-seg loader into the
   model registry (CPU inference first, GPU optional).
5. **Weather fusion** — precipitation and growing-degree-day context alongside
   NDVI to separate drought stress from management effects.
6. **Persistence and jobs** — SQLite/Postgres store plus a queue for long
   analyses, so large requests become background jobs with progress.
7. **Reports** — per-field PDF/HTML export combining maps, statistics and the
   interpretation text.
8. **Zones and prescriptions** — export management zones for variable-rate
   application.
9. **GIS interop** — vector export of zones/segments, plus a WMS/XYZ tile
   endpoint for large rasters.
10. **Tests and CI** — golden-image regression tests for the visualization
    engine and a GitHub Actions pipeline running the suite and the image build.

---

*Vibes Lite is an independent project. FarmVibes.AI is referenced only as
conceptual inspiration; no FarmVibes.AI code is used at build time or runtime.*
