# Vibes Lite — Weekly Progress Log

> **Project:** Vibes Lite — independent, lightweight agriculture intelligence platform
> **Repo:** `/Users/harshdev/Documents/vibeslite`
> **Week 1:** Monday 21 Sep → Saturday 26 Sep 2026
> **Status at week end:** MVP functional end-to-end · 21 API endpoints · 7 dashboard pages · 143 tests passing · 8 executed notebooks · Docker configs validated
> **Principle:** Inspired by Microsoft FarmVibes.AI *concepts only* — zero shared code, zero runtime dependency.

---

## Week 1 at a Glance

| Day | Focus | Key Outcome |
|-----|-------|-------------|
| Mon | Project structure & architecture plan | Full blueprint: modular monolith, folder layout, data-flow diagram |
| Tue | Web-based UI foundation | FastAPI skeleton + React/Vite app shell running |
| Wed | Docker + frontend build-out | Multi-target Dockerfile, compose validated, pages taking shape |
| Thu | Frontend UI/UX working end-to-end | 7 pages wired to live API, maps & charts rendering |
| Fri | Demo data + FarmVibes/OpenCV research | Synthetic Sentinel-2-style scene, GeoJSON fields, CSV history; OpenCV engine |
| Sat | Dataset research, roadmap & verification | Ideas shortlist, OpenCV enhancement plan, full test/browser verification |

---

## Monday — Project Structure & How It Will Work

**Goal:** Decide what Vibes Lite *is* before writing any code.

- Studied the FarmVibes.AI concept: workflow-driven agri pipelines (ingest → preprocess → index → analyze → visualize). Decided we take the **concepts**, none of the code or runtime.
- Chose a **modular monolith**: one FastAPI backend with clearly separated engine modules, one React dashboard. Explicitly *no* microservices, no database yet, no auth yet.
- Fixed the folder layout (kept flat on purpose):

```
vibes-lite/
├── backend/    main, api, config, storage, data, preprocessing,
│               geospatial, opencv, indices, analysis,
│               segmentation, timeseries, visualization
├── frontend/   React + Vite (pages/, components/, api.js)
├── data/       raw/ + processed/
├── outputs/    per-analysis result bundles
├── notebooks/  01–08 workflow notebooks (planned)
├── tests/
└── Dockerfile, docker-compose.yml, config.yaml, README.md
```

- Drew the core pipeline on paper/ASCII: **AOI → ingestion (satellite/drone/weather) → preprocessing → OpenCV → geospatial engine → index engine (NDVI/NDRE/EVI/SAVI) → crop-health engine → AI/ML layer → visualization → API → dashboard**.
- Defined the "first working experience": user picks a dataset + field, runs NDVI, and sees the NDVI map + field boundary + stats + health distribution + interpretation in the dashboard.
- Set ground rules: no fake claims (NDVI ≠ disease detection), raw data never modified, everything extensible without rewrites.

**Deliverable:** architecture + directory blueprint + API surface list (health, project, upload, aoi, ndvi, crop-health, opencv/process, segmentation, results, timeseries).

---

## Tuesday — Started Building the Web-Based UI

**Goal:** Get a living skeleton — backend serving JSON, frontend rendering it.

- Scaffolded the **FastAPI backend**: `main.py` with CORS + `/outputs` static mount; `api.py` with the first routes (`/api/health`, `/api/project`, `/api/datasets`, `/api/upload`); Pydantic models for clean request/response shapes; proper 404/400 handling.
- Built `storage.py` — a lightweight JSON file store for datasets, AOIs and results (no DB, by design).
- Scaffolded the **React + Vite frontend**: `App.jsx` with sidebar navigation, `api.js` client with `useApi` hook, dark agri-tech theme in `styles.css`.
- First two pages stubbed then made real: **Dashboard** (project totals + dataset table) and **Fields** (GeoJSON-driven field list).
- Installed the heavy geospatial stack into `.venv` (rasterio, geopandas, shapely, opencv, fastapi/uvicorn) and confirmed imports load cleanly.

**Deliverable:** `uvicorn main:app` on :8000 and Vite on :5173 talking to each other; health + project + datasets endpoints verified live.

---

## Wednesday — Docker Working + Frontend Build-Out

**Goal:** Make the project shippable and grow the UI.

- **Docker**: wrote a multi-target `Dockerfile` —
  - `backend` stage: `python:3.11-slim`, installs rasterio/geospatial wheels + requirements, runs uvicorn **with a container healthcheck** on `/api/health`;
  - `frontend` stage: `node:20-alpine`, builds the Vite app and serves it.
- Wrote `docker-compose.yml`: `vibes-lite-backend:8000` + `vibes-lite-frontend:5173`, mounts `./data` and `./outputs` into the backend so demo data ships with the repo, `VITE_API_PROXY_TARGET` wired for the dev proxy. Added `.dockerignore`.
- `docker compose config` → **valid ✅** (image builds deferred — Docker daemon wasn't running on the machine this week).
- **Frontend build-out**: added the analysis pages — **NDVI**, **Crop Health**, **Computer Vision** — each with dataset/field pickers, parameter panels and result panels.
- Extracted reusable components: `MapView` (Leaflet), `Charts` (Recharts), `Panel`, `FieldPicker`, `Uploader`, `HealthDistribution`, `InterpretationPanel`.
- `npm run build` passing (one benign ~780 kB chunk warning).

**Deliverable:** Dockerized-by-config project; 5 of 7 pages functional against the live API.

---

## Thursday — Frontend UI/UX Working End-to-End

**Goal:** Every page not just *renders* but *works* against real backend responses.

- Completed and polished all **7 pages**: Dashboard, Fields, NDVI, Crop Health, Computer Vision, Time Series, Results.
- Wired the full analysis flows: pick dataset → pick field/AOI → set parameters → run → see maps, stats, charts and interpretation; "New analysis" resets; deep links like `/ndvi/{id}` open a stored result.
- **Deep-link hydration**: opening `/crop-health/{id}` or `/ndvi/{id}` with an empty store now fetches the stored result and hydrates the analysis view — verified in the browser.
- **Real bug found & fixed** in `api.js`: `datasets(kind)` leaked the `{signal}` object into the query string (`kind=[object Object]`), which silently emptied the CSV dropdown on the Time Series page. Added a proper `typeof kind === 'string'` guard.
- Added Leaflet field-boundary overlays on NDVI/crop-health maps and Recharts distributions; consistent cards, chips, KPI tiles across pages.
- Results page: browse all stored analyses, open result detail, list and preview PNG assets.

**Deliverable:** browser-verified pages (Dashboard, NDVI, Crop Health showing live stats and maps). This was the first day the product *felt* like a platform, not a demo script.

---

## Friday — Demo Data, FarmVibes Research & OpenCV Engine

**Goal:** Feed the platform believable data and give it real computer-vision muscle.

- **Demo data generated** (clearly tagged SYNTHETIC, no fake "real satellite" claims):
  - `synthetic_fields.tif` — 1200×1200, 4 bands (B02/B03/B04/B08), uint16 ×10000 reflectance, EPSG:32633, nodata=0, with spatially structured NDVI so zones/weak patches actually emerge;
  - `synthetic_fields.geojson` — 4 field plots matching the raster;
  - `synthetic_fields_ndvi_history.csv` — 21 rows, 3 fields × 7 dates, for time-series work.
  - Idempotent generator endpoint: `POST /api/samples/synthetic?size=1200`.
- **FarmVibes.AI research**: mapped its workflow/template concepts onto our engines (ingest ≈ data.py, ops ≈ engines, workflow ≈ API pipeline). Confirmed design: we stay independent, no imports, no copied code.
- **OpenCV engine implemented** (`backend/opencv.py`): 18 ops — adaptive_threshold, otsu, threshold, blur, median_blur, denoise, edges, enhance, grayscale, invert, erode, dilate, morph_open/close/gradient, clean_mask, remove_small_objects, resize — plus presets (`clean_binary`, `edges`, `enhance`, `veg_mask`), contour detection and masked overlays. Unknown op → 400 with the available list.
- Full pipeline exercised over HTTP: NDVI → crop-health → segmentation → opencv → timeseries all 200; second NDVI run hits the cache; bad dataset correctly 404.

**Reference numbers locked in for the demo scene:** NDVI mean **0.517**, healthy **25.07%**, weak **12.32%**, **160 zones**, **81 weak patches**, trend **increasing +0.116/30 days**.

---

## Saturday — Dataset Research, Ideas & Final Verification

**Goal:** Decide what comes next, then prove everything built this week actually works.

- **Dataset research**: shortlisted real data sources for next week — Sentinel-2 L2A via Copernicus/Element84 STAC (B02/B03/B04/B08 line up exactly with our engine), drone multispectral (MicaSense/Parrot), public agri benchmark parcels for field boundaries. Noted what our ingestion already supports (GeoTIFF uint16 ×10000, nodata handling, GeoJSON/CSV).
- **Ideas board — what to add & enhance**:
  - STAC search → one-click scene ingest over an AOI
  - Weather CSV join into time series (rain/GDD vs NDVI correlation)
  - More indices (NDRE already in; add NDWI, GNDVI, LAI estimates)
  - OpenCV enhancement plan: veg-mask pipelines (exG / excess-green from RGB for drone imagery, Otsu on NDVI, morphology + `remove_small_objects` to denoise weak-patch maps, contour export to GeoJSON)
  - Trainable segmentation layer via the `register_model()` registry (ONNX/torch loaders, no weights shipped yet)
  - One-click PDF farm report from a stored result
- **OpenCV implementation plan (next-week target)**: drone RGB → excess-green index → Otsu threshold → morphological open/close → small-object removal → contours → convert contour polygons to field-coverage GeoJSON, and feed the same masks into segmentation as pseudo-labels.
- **Final verification pass (all green)**:
  - **143 tests passed** (`pytest tests -q`, ~8 s) — including a new regression test for a real bug found & fixed today: `geospatial.crs_info` crashed on geographic CRS (EPSG:4326); rewrote the CRS-unit resolution (shortcuts → pyproj axis info → conversion fallback).
  - **8/8 notebooks executed headlessly** (nbclient), 0 failures.
  - **Time Series page browser-verified** (the last pending one): CSV mode → "Build time series" → trend **increasing**, +0.1159/30 days, r² 0.82, 21 observations, chart rendered.
  - Backend & frontend health confirmed (`/api/health` ok, Vite 200).
- Wrote the **README** and the final 10-point project report (tree, features, Docker commands, URLs, endpoints, tests, functional scope, real-data needs, POC next step).

**Deliverable:** a verified MVP + a concrete, prioritized next-week plan.

---

## Next Week — Making It Actually Work (Plan)

**Theme:** move from synthetic MVP to a real-data, trained-model platform.

1. **Real datasets in**
   - Stand up a small **STAC client** (Element84 Earth Search): search Sentinel-2 L2A by AOI + date range, pick scene, ingest band assets through the existing upload/ingest path — no manual downloads in the UI flow.
   - Add a real parcel boundary (GeoJSON) for one known farm field; verify CRS reprojection path (4326 → UTM) end-to-end.

2. **Train the segmentation / classification layer**
   - Use the OpenCV veg-mask pipeline to generate **pseudo-labels** from NDVI/RGB (healthy vs weak canopy) — cheap training data without manual annotation.
   - Train a lightweight model (small U-Net or Random-Forest-on-pixels) on those labels; wire it into `segmentation.register_model()` with an ONNX export so inference needs no training stack at runtime.
   - Validate against the synthetic scene first (known ground truth), then one real scene.

3. **Add attributes to make analysis meaningful**
   - Per-zone attributes: mean NDVI, zone area (ha), weak-patch density, change vs previous date → richer crop-health reports.
   - Time series with **weather join**: daily rain/GDD/temperature CSV correlated against NDVI trend (engine's CSV table loader is already ready for this).
   - More indices (NDWI, GNDVI) to separate water stress from canopy vigour.

4. **OpenCV work in production paths**
   - Drone RGB → excess-green → Otsu → morphology → contours → **GeoJSON coverage export** (field-coverage maps without any satellite data).
   - Use morphology + small-object removal as the standard cleanup stage for weak-patch maps to cut false positives.

5. **Harden & ship**
   - Docker daemon on → `docker compose up --build` end-to-end test of the real container stack.
   - Integration test fixture with a small *real* Sentinel-2 chip under `tests/fixtures`.
   - PDF farm-report export; start thinking about an optional SQLite store when results outgrow JSON files.

---

*End of Week 1 log — Vibes Lite MVP: built, tested, verified, documented.*
