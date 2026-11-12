# Vibes Lite — Project Brochure & Poster Source Pack

Every fact about this project in one place, for designing a poster, brochure or
pitch deck. All figures were measured from the repository on **12 Oct 2026**
and are safe to print. No emoji anywhere — copy these blocks as plain text.

---

## 1. Identity

**Name:** Vibes Lite — agri intelligence
**Tagline options:**

- *AI crop monitoring from drone and phone imagery — on a laptop, no cloud required.*
- *From pixels to prescriptions: see every tile of the field, name every plant, act on real data.*
- *Satellite, drone and sensor data turned into irrigation advice you can defend.*

**Elevator paragraph (100 words):**
Vibes Lite turns drone and phone photos, satellite feeds and field sensors
into agronomy decisions. A farmer uploads an image; the system georeferences it
from EXIF GPS, slices it into 50-pixel tiles, computes 13 spectral and texture
features per tile and classifies each tile as healthy crop, stressed crop, bare
soil or weed. A live Open-Meteo feed and a registry of field probes then feed an
irrigation engine that states, with provenance, whether to water and how much.
A local vision model names the plant species in any photo. Two products live in
one repository: a Python geospatial platform and a single-file Node console that
runs the whole demo from one command.

---

## 2. Hero numbers (stat block for the poster)

| Figure | Value |
|---|---|
| Products in one repo | 2 (Python platform + Crop AI console) |
| First-party source | **25,049 lines** (Python 10,776 · console 8,348 · React 5,925) plus 4,380 lines of tests (Python 3,739 · console 641) |
| Automated tests | **328 green** — 294 pytest (~10 s) + 34 console tests (~13 s) |
| Real satellite ingestion | Sentinel-2 L2A read from the STAC catalogue straight into `data/raw` — real reflectance, SCL cloud mask, provenance in the file tags |
| OpenStreetMap services wired in | 3 — Nominatim search/reverse geocoding, Overpass map features, the tile basemap catalogue |
| Third-party scripts in either app | 0 — Leaflet is bundled into the dashboard and vendored into the console |
| Agronomy models | 7 documented models, each publishing its own confidence level |
| Vegetation indices | 13 (NDVI · NDRE · EVI · SAVI · GNDVI · NDMI · NDWI · OSAVI · MSAVI · PSRI · CVI · RECI · GCI) |
| Security headers per response | 10, plus a Content Security Policy |
| Rate-limit tiers | 3 (read 1200/min · write 240/min · analysis 120/min) |
| Backend route checks | **73/73, 0 failures** across all 46 console routes (`tools/qa_sweep.mjs`, 8 Oct) |
| Browser sweep | all 9 tabs and every button clicked with real input, **0 page errors** (`qa-evidence/`) |
| HTTP endpoints | 77 (47 console + 30 FastAPI) |
| Live console tabs | 9 |
| Map layers | 11 |
| Sensor device types | 9 |
| Ground-cover classes | 4 (healthy, stressed, bare soil, weed) |
| Fusion datasets | 5 real, keyless sources — Sentinel-2, Sentinel-1, Copernicus DEM, Open-Meteo, NASA POWER |
| Workflow engine | 3 DAGs over 12 node types, every result cached by an input hash |
| Live SSE event types | 16 |
| Dashboard pages | 9 (Dashboard · Fields · NDVI · Crop Health · Vision · Series · Agronomy · Results · Security) |
| Executable notebooks | 8 (01 basic setup → 08 final demo) |
| Fields georeferenced | 400 tiles carrying real WGS84 coordinates |
| Installable on a phone | both apps — manifest + service worker + maskable icons |
| Synthetic/demo data in the demo console | 0 — seed/demo routes intentionally return 404 |
| Emoji in the UI/docs | 0 — SVG icons only |
| Deploy targets | 4 (start.sh, pm2/systemd, Docker, Vercel) |
| Species ID latency | 3–56 s for small images; **71–99 s measured** for real field photographs on this CPU (7 Oct–8 Oct), 120 s timeout |

---

## 3. The problem and the approach

**Problem.** Small and mid-size farms cannot afford a data team. Imagery,
weather and sensor data exist, but they sit in separate tools, and the outputs
are often opaque numbers nobody can defend to a spray or irrigation decision.

**Approach.**

1. **Everything is real.** No generated demo data. Weather comes from the live
   Open-Meteo API, coordinates from EXIF GPS, readings from posted device
   tokens. If a source is missing, the system says so instead of guessing.
2. **Everything is explainable.** Every layer value carries its source; every
   recommendation lists the inputs that produced it; vegetation indices report
   when a band order had to be assumed.
3. **Everything runs locally.** One Node process for the demo console, one
   FastAPI process for the platform, an optional local vision model. No cloud
   account is required; serverless deploy is optional.

---

## 4. Product A — Crop AI console (the demo face)

Single-file Express backend plus a no-build vanilla-JS console, served from one
process. `server.js` 3,874 lines · `app.js` 2,266 · `index.html` 668 ·
`styles.css` 1,257 · `server.test.js` 641 — plus `vendor/leaflet/` (Leaflet
1.9.4, BSD-2-Clause, served from this origin instead of a CDN).

### Analysis pipeline

- **Ingest** — camera/drone uploads; EXIF GPS extracted for automatic
  georeferencing (lat/lon/altitude/capture time/camera model), manual geotag
  fallback for phone photos.
- **Slice** — image cut into 50 px tiles (400-tile fields are normal).
- **Feature** — 13 dimensions per tile: RGB means and deviations, green
  excess, EVI-style ratio, VARI, brightness, texture std, edge density, dark
  share.
- **Classify** — cosine kNN (k = 5) with per-model standardization, trained
  from labels in the console; 5-fold cross-validation reports honest
  out-of-sample accuracy, per-class precision/recall/F1 and a confusion matrix.
- **Vision** — OpenCV (opencv-wasm) for colour conversion, blur and Canny
  edges, with a pure-JS fallback that keeps the pipeline running anywhere.
- **Classes** — healthy crop, stressed crop, bare soil, weed area, each with
  colour, label and per-field share.

### Geo mapping (Geo Map tab)

- Field footprints as WGS84 polygons, per-tile rectangles, wind polyline and
  device markers on Leaflet, over **real OpenStreetMap basemaps** (street by
  default, plus humanitarian and terrain) and Esri satellite.
- **Real places, not a picture of them:** place/address/postcode search through
  Nominatim, reverse geocoding of any clicked point (it names the field you are
  looking at), and an **OSM features** layer that draws the actual roads,
  tracks, ditches, water, land use, buildings and hedges around the field from
  Overpass — with per-class colours served by the API. Clicking a point offers
  it as the focused field's location via the existing geotag endpoint.
- **11 layers:** classification, vegetation vigor, canopy cover, plant health,
  weed pressure, soil condition, soil moisture, soil pH, soil EC, soil
  temperature, soil texture (last five probe-only — the console will not
  invent them).
- Per-tile popup with the full agronomy readout and source attribution;
  GeoJSON export of footprints and per-tile classifications.

### My location — the device's own fix

- The Geo tab **asks the browser where this device actually is** and reports on
  that point: live weather, the last 7 days of reanalysis rain and ET₀,
  Sentinel-2 passes over the coordinates, elevation and slope, the
  OpenStreetMap features around you, and a NASA POWER second opinion — seven
  providers in one call, each with its own error, so a dead upstream is named
  instead of blanking the panel.
- The fix is validated and stored server-side, so the same location serves every
  tab and every console on the LAN; `Follow` streams from `watchPosition` and
  writes only when the device has really moved (> 5 m), so a 1 Hz GPS stream
  does not become a 1 Hz disk writer.
- **Nothing is ever invented.** No stored fix and no coordinates given →
  `404 NoLocation` / `409`, with no default, sample or `(0, 0)` coordinate; the
  Null Island sentinel is rejected by name. Denied permission, no GPS radio, a
  timeout and a non-secure origin are four distinct, actionable messages, and a
  fix older than 15 minutes is labelled `stale` rather than shown as current.

### Weather and soil (live, keyless)

- Open-Meteo forecast + current: temperature, apparent temperature, humidity,
  precipitation, ET0 evapotranspiration, soil moisture (surface and 3–9 cm),
  wind speed/direction/gusts, cloud cover, pressure, weather code — cached
  600 s, refreshed on request.
- Soil moisture reported as % volumetric water content; the API's model fill
  value of 0 is treated as *no data*, never as a false "critical: 0%" alert.
- Any date back to **1940** (ERA5 / ERA5-Land reanalysis): temperature, rain,
  wind, humidity, radiation, FAO-56 ET0 and soil moisture, one row per day, each
  row naming the endpoint and model family that answered it. Days the archive
  has not published yet come from the forecast endpoint's recent record and say
  so; an unreported day stays `null` rather than being interpolated, and the
  totals cover only days that have already happened.
- **Windy forecast map** in the Geo tab: Windy's own embed with wind, gusts,
  rain, temperature, humidity, cloud and pressure layers centred on the field,
  and the clickable Windy credit its terms require.
- **The map is Windy's, the numbers never are.** Windy's API returns forecasts
  only — *"It is not possible to retrieve historical forecasts with past data"* —
  and its free testing key returns *randomly shuffled and slightly modified
  data*, so nothing here is ever read from Windy as a value. `GET /api/sources`
  publishes Windy under `visualizations`, apart from the data sources.

### Sensor network (Sensors tab)

- **9 device types:** soil probe, weather station, anemometer, rain gauge,
  soil temperature, pH/EC probe, light sensor, field camera, generic.
- Every device gets its own `deviceId` and `ingestToken`; hardware posts
  readings to `POST /api/fields/:id/ingest?deviceId=` with an
  `X-Sensor-Token` header (200 accepted / 401 bad token / 404 unknown device).
- Site view: which sensors at which site, what each is fetching right now,
  live value, unit, status pill (live / stale / offline / no-data), 40-point
  sparkline, tile coordinates and every secondary metric.
- 14 SSE events stream changes to the browser (`field-uploaded`,
  `field-analyzed`, `tile-labeled`, `trained`, `device-reading`,
  `plant-identified`, `sensors`, `reset`, …).

### Irrigation engine

Inputs: soil moisture (probe first, satellite second), precipitation, ET0, air
temperature, per-class crop stress. Output: recommendation (irrigate now /
within 24 h / none), urgency, litres per acre, plain-language reasons,
threshold alerts (weed pressure, crop stress, bare soil, critical moisture,
heat stress) and the provenance of every input, e.g.
`device:S-0d15ca` vs `weather-api`.

### Fusion data sources (Sentinel-2, Sentinel-1, terrain, weather cross-check)

Four real, keyless datasets sit alongside Open-Meteo, and every fetched value
carries its product, endpoint, attribution and fetch time (`GET /api/sources`):

- **Sentinel-2 L2A** optical scenes through the Earth Search STAC catalogue —
  datetime, cloud cover, platform, thumbnail and the canonical STAC item link.
- **Sentinel-1 GRD** C-band SAR from the same catalogue — sees through cloud;
  cloud cover is reported as absent rather than faked as 0%.
- **Terrain** — Copernicus DEM sampled at five points across the footprint →
  elevation, relief, slope %, slope degrees, aspect and a drainage verdict
  (flat ⇒ ponding risk, sloped ⇒ runoff risk).
- **Weather cross-check** — NASA POWER daily temperature, precipitation and
  humidity compared against Open-Meteo over only the days both sources report;
  NASA POWER's `-999` fill days are excluded and counted, never averaged in,
  and the agreement verdict (`close` / `divergent`) is stated with the delta.

A source that cannot be reached fails loudly with the provider's status code —
it is never replaced by invented values.

### Workflow DAG engine (CP10)

Workflows are directed acyclic graphs of **fetch → prepare → infer** nodes,
executed in topological order, with every node's result cached under a hash of
its inputs (the field fingerprint, the parameters and the hashes of its
dependencies). Three workflows ship:

- **local-agronomy** — 5 nodes, no network: tile classification, irrigation
  advisory, soil quality index, field report.
- **field-refresh** — 11 nodes: Sentinel-2 + Sentinel-1 scenes, live weather,
  the NASA POWER cross-check, DEM terrain, a context merge, then the agronomy
  nodes on top.
- **imagery-window** — 3 nodes: scan the archive and pick the least-cloudy
  acquisition, the input cloud-free compositing needs.

The point of the hash cache is what it *does not* redo. Proven live on the demo
field: a soil probe reported 18.5% VWC, and the next run executed **only
`irrigation`, `soil-quality` and `report`** — all eight satellite, terrain and
weather fetches stayed cached; with no changes at all, zero nodes execute. The
Workflows tab runs any of them with one button and shows, per run, which nodes
ran, which were reused and how long each took.

### External AI integration

- Two providers: `generic` (POST any JSON endpoint) and `openai`
  (OpenAI-compatible `/chat/completions`), configured from the AI Model tab or
  environment variables.
- Responses are parsed tolerantly and normalized into one shape; failures
  degrade honestly to the local kNN model and report `aiError`.
- Crop pipeline and species identification are **separate endpoints**, so a
  slow vision model never blocks classification.

### Plant species identification

- **Trigger it from three places:** camera modal (*Identify plant*), map-tile
  popup (*Identify here*), AI Model tab (history + test round-trip).
- Runs on a local Ollama vision model (`qwen2.5vl:3b`, 3.2 GB download) at
  `localhost:11434/v1`, 120 s timeout; any OpenAI-compatible vision API works
  too.
- The model must return one JSON contract: common name, scientific binomial,
  family, type (crop / grass / weed / wildflower / tree / shrub / fungus /
  soil / unknown), confidence, up to 5 ranked candidates, health 0–100,
  condition, observable traits and one practical note.
- **What the model actually sees:** the biggest sensible view of the real
  image — a square region centred on the requested tile (448 px) or the whole
  frame for the test round-trip (512 px, box-average downscale). A 50 px map
  tile is too small for any species model, and sending one made every
  identification fail; that was fixed and re-verified on 8 Oct.
- **Bounded generation:** `max_tokens` is capped so a small local model cannot
  ramble past the timeout (one call was cut off after 1,424 tokens before the
  cap). Measured on a real 1200×900 field photograph: **99 s** for the
  full-frame round-trip and **71 s** for the tile-region path, both HTTP 200,
  both returning a species — this is CPU/M-series-Ollama latency, not a
  failure.
- **Honesty rules:** the contract is sent in the user turn (vision models
  ignore it in the system role), nameless answers are rejected rather than
  stored, unconfigured endpoints return 409, unreachable or unnameable images
  return 502. A guessed species is never shown. Each stored entry keeps the
  crop it was identified from (x, y, w, h), so provenance is checkable.
- Results are stored with time and place and replayed as `plant-identified`;
  4 real identifications are on record — a field region (*Rye Grass /
  Hordeum vulgare*, 0.85, ranked candidates and traits), two camera frames
  (bumblebee on a flower) and one map tile (*Poa pratensis*).

### Console design

- 9 tabs: Operations · Labeling · Model Lab · AI Model · Analysis · Geo Map ·
  Sensors · Workflows · Applications.
- Typography: Space Grotesk (display), Inter (body), JetBrains Mono (data),
  tabular numerals globally; denser work-focused cards, sticky table headers,
  focus-visible rings; 116 DOM ids, all wired; SVG icons only.
- **Brutalist system** (shared with the dashboard): zero radius, 2px structural
  rules, hard offset shadows, blueprint grid underlay.
- **Motion:** a rail indicator that physically moves between tabs, View
  Transitions for tab morphs, hash routing, scroll-driven reveals, clip-path
  wipes, spring easing — all `transform`/`opacity` only and all disabled under
  `prefers-reduced-motion`.
- **Mobile-first:** 2×2 stat grid, a horizontally-scrolling status strip above
  the bottom nav rail, auto-centering of the active tab, `env(safe-area-inset)`
  padding, and installable to a home screen as a standalone PWA.

---

## 5. Product B — Vibes Lite platform (Python + React)

Modular monolith: one FastAPI process, one Vite frontend, plain modules instead
of microservices.

- **Ingestion** — GeoTIFF / VRT rasters (single-band, RGB, multispectral),
  GeoJSON field boundaries, CSV datasets; metadata, band descriptions, CRS,
  nodata and validation reported before processing.
- **Geospatial** — CRS detection and conversion, AOI validation and
  reprojection, windowed clipping, rasterisation and masking, geometry
  validation, overlay checks.
- **Preprocessing** — nodata handling, valid masks, band extraction,
  normalisation, RGB / false-colour composites, decimation to a pixel budget.
  Raw data is read-only; every operation returns new arrays.
- **Index engine** — **13 indices** on one dispatch path (NDVI, NDRE, EVI,
  SAVI, GNDVI, NDMI, NDWI, OSAVI, MSAVI, PSRI, CVI, RECI, GCI); SWIR split into
  SWIR1/SWIR2 by centre wavelength; division-by-zero and nodata handled
  explicitly; band assumptions reported; every index declares whether it is
  difference-normalised to `[-1, 1]` or an unbounded positive ratio so a UI can
  never colour-scale a ratio index as if it were NDVI.
- **Agronomy engine** — seven documented models, each publishing how far its
  answer can be trusted. Thermal time and phenology (three GDD methods, cut-out
  ceiling, days to next stage) · FAO-56 single-Kc water balance with an
  irrigation schedule and a stress-day count · k-means++ management zones on
  index plus weighted spatial position · proportional-deficit variable-rate
  prescription with clamping and a delta-versus-flat-rate comparison ·
  practice-weighted soil-carbon screening with saturation · index-integral yield
  forecast · per-pathogen disease favourability. **Refusal is a feature:** an
  uncalibrated yield request returns the calibration recipe instead of a
  tonnage, and the carbon screen returns a range plus the list of what is still
  missing before the figure could be verified.
- **Crop-health engine** — configurable explainable classes, per-class area and
  share, contiguous health zones, weak-vegetation patch detection with
  minimum-area filtering, z-score / IQR anomalies, plain-language field
  interpretation that states what NDVI cannot conclude.
- **OpenCV engine** — resize, denoise, blur, CLAHE/gamma, threshold, Otsu,
  adaptive threshold, morphology, gradient, contour detection and metrics, ROI
  extraction, overlays, before/after composites with pipeline metrics.
- **Segmentation (AI-ready)** — threshold / Otsu / multi-threshold /
  crop-health-zone segmentation, connected components, GeoJSON export, and a
  model registry ready for a future U-Net / DeepLab / YOLO loader. No weights
  downloaded, no GPU required.
- **Time series** — least-squares trend, date-to-date change detection,
  health-share tracking from CSV, stored results or inline data.
- **Visualization** — NDVI map, crop-health map, weak-vegetation map,
  histogram, class-distribution chart, boundary overlays, time-series charts,
  written under `outputs/` with georeferenced overlays.
- **Frontend** — **9 pages** (Dashboard, Fields, NDVI, Crop Health, Computer
  Vision, Time Series, **Agronomy**, Results, **Security**) in the same
  brutalist system as the console; reusable components (Layout, MapView, Charts,
  Uploader, FieldPicker, HealthDistribution, InterpretationPanel, Panel). The
  Agronomy page is a tabbed workspace for all seven models — including a
  zones → prescription chain driven end to end from a real raster — and the
  Security page renders the live posture from `/api/security`.
- **Security posture** — 10 response headers plus a Content Security Policy
  whose allow-lists are derived from the assets the app actually loads; three
  rate-limit tiers counted per client address with `RateLimit-*` headers and
  `Retry-After` on a 429; extension allow-lists, upload ceilings and clean JSON
  errors. `GET /api/security` and the dashboard's Security page both state the
  gap that remains: **no user authentication, no tenancy, no audit log.**
- **Notebooks** — 8 executable demonstrations: 01 basic setup, 02 load AOI,
  03 NDVI, 04 crop health, 05 OpenCV, 06 segmentation, 07 time series,
  08 final demo.

**Design rules:** engines never import the API (the API orchestrates
engines) · thresholds and band defaults live in `config.yaml`, never scattered
in code · raw data read-only, artefacts to `outputs/<result-id>/` · repeat
analyses hit the result cache instead of reprocessing.

---

## 6. Architecture (poster diagram)

```
   Drone / phone photo          Satellite / CSV / GeoJSON         Field probes
          │                              │                              │
          ▼                              ▼                              ▼
  ┌───────────────┐              ┌────────────────┐            ┌────────────────┐
  │ Crop AI       │              │ Vibes Lite     │            │ Open-Meteo     │
  │ console       │              │ FastAPI        │            │ + Ollama VLM   │
  │ (Node, 5177)  │              │ (Python, 8000) │            │ (local AI)     │
  │               │              │                │            │                │
  │ EXIF georef   │              │ CRS · clip     │            │ 14 weather     │
  │ 50 px tiling  │              │ NDVI/NDRE/     │            │ variables ·    │
  │ 13-dim feats  │              │ EVI/SAVI       │            │ species ID     │
  │ kNN + 5-fold  │              │ health zones   │            │ 409/502 never  │
  │ 11 map layers │              │ contours · TS  │            │ a guessed name │
  │ irrigation    │              │ 7-page React   │            │                │
  └──────┬────────┘              └───────┬────────┘            └───────┬────────┘
         │        SSE live events        │                             │
         └───────────────┬───────────────┘                             │
                         ▼                                             │
              Browser console (9 tabs) ◄───────────────────────────────┘
```

Two products, one repository, one design contract: real inputs, provenance on
every output, honest failure states.

---

## 7. Technology stack

| Layer | Technology |
|---|---|
| Console backend | Node 18+, Express, Multer, ExifReader, pngjs, jpeg-js, opencv-wasm |
| Console frontend | Vanilla JS (no build step), Leaflet, SVG icons, Space Grotesk / Inter / JetBrains Mono |
| Platform backend | Python 3.11, FastAPI, Uvicorn, Pydantic |
| Geospatial | Rasterio, GeoPandas, Shapely, pyproj, Pyogrio |
| Imaging / CV | OpenCV (headless), NumPy, Pillow |
| Data & charts | Pandas, Matplotlib |
| Platform frontend | React 18, Vite 5, React Router, Recharts, Leaflet / React-Leaflet |
| AI | Ollama + qwen2.5vl:3b (species ID), OpenAI-compatible or generic HTTP providers (crop pipeline), local kNN fallback |
| Live data | Open-Meteo forecast + soil and elevation APIs, Earth Search STAC (Sentinel-1/2), NASA POWER — all keyless. The Python platform reads Sentinel-2 L2A band COGs over HTTP range requests; the console searches the same catalogue |
| Tests | pytest + httpx (294), Node console suite (34), Node harness `tools/vercel_harness.js` (15 checks) |
| Packaging / deploy | Docker, Docker Compose, pm2, systemd, Vercel |

---

## 8. The data-integrity contract (the differentiator)

- **No synthetic data in the demo console.** The console ships no seed, no
  demo-tick, no fake sensor generator — `/api/seed`, `/api/seed-dataset` and
  `/api/demo-tick` return 404 on purpose (verified on every release sweep).
  The Python platform's single sample generator (`/api/samples/synthetic`) is
  explicitly labelled and exists only for tests and demos — and it is no longer
  the default path: the Dashboard leads with *Fetch real satellite imagery* and
  *Upload your own imagery*.
- **No invented radiometry.** Sentinel-2 reflectance depends on a scaling
  convention, and the wrong one silently rescales every index. This build reads
  the catalogue's own `earthsearch:boa_offset_applied` flag, records the choice
  in the file tags and the API payload, refuses a scene that publishes no scale
  at all, reports a reflectance range that implies a double-applied offset, and
  was checked against the data: an in-window area the SCL marks 100 % water
  reads 0.03 the right way and an impossible −0.07 the wrong way.
- **No invented scene.** A field outside the scene, a fully clouded window, an
  unknown collection or an unlisted asset host is a named error, never an empty
  raster or a blank map.
- **No invented species.** Identification failures return 409 or 502, never a
  nameless record or a guess.
- **No fake critical alerts.** A soil-moisture fill value of 0 is a model gap,
  not a dry field.
- **Provenance everywhere.** Layer values, readings and recommendations state
  which device or API produced them; indices state when a band order was
  assumed.
- **No emoji, no decorative filler.** SVG icons and real measurements only.

---

## 9. Verification evidence (for the "quality" panel)

- **294 pytest tests green in 10 s** (exit code 0, re-run 13 Oct 2026) — up
  from 143, including the full agronomy engine (`test_agronomy.py`) and its HTTP
  surface (`test_agronomy_api.py`: Pydantic bounds, and the engine's validation
  surfacing as a `400` rather than a `500`) and the OpenStreetMap layer
  (`test_osm.py`: provider posture, the rate gate's real spacing, Overpass query
  construction and GeoJSON conversion, transient-retry vs never-retry-429, and
  the picked-point→boundary path measured against the platform's own area maths).
- **Agronomy round-trips driven from the browser** (12 Oct 2026, not just by
  curl) — thermal time returned 149 cumulative GDD at stage *initial* with 392
  GDD to the next stage and a rendered cumulative curve; the water balance
  returned 112 mm of crop water use against 30 mm of effective rain with a
  0-stress-day verdict; the zones chain returned 3 contiguous NDVI zones with
  *strong* separation and fed a prescription of 225 / 162.7 / 162.0 kg/ha
  (area-weighted 168.9, +12.6% over flat rate, one row clamped); and the yield
  model returned its calibration recipe instead of a tonnage.
- **Vercel harness 15/15** — no auto-listen, `/tmp` cold-start seed, API and
  static routes green, demo routes 404; also passes against a simulated
  deployment bundle with root dependencies only.
- **Endpoint sweeps** — health, fields, sensors, identify, AI status all 200;
  console and mock AI confirmed running.
- **Console test suite** — `crop-ai/server.test.js`, **34 tests in ~13 s**: the
  data-integrity contract, device token auth (401) with timing-safe comparison,
  the sensor lifecycle, per-route rate limits that are enforced rather than only
  advertised, path-traversal rejection, the pure agronomy helpers, both AI
  normalizers, the workflow DAG (cycle rejection, hash caching, downstream
  invalidation), and the OSM provider layer (the CSP completes the basemap
  catalogue, requests are validated before any upstream call, Overpass queries
  are bounded, each element is attributed to exactly one class, undrawable
  elements are dropped rather than rendered).
- **Backend route sweep** — `tools/qa_sweep.mjs`, **73/73 checks, 0 failures**,
  across all 46 console routes including error paths and auth (8 Oct 2026).
- **Browser sweeps** — `tools/ui_sweep.sh` + `tools/ui_sweep2.sh` click through
  all nine tabs and every button with real browser input while an in-page
  `window.onerror` / `unhandledrejection` collector watches for faults:
  **zero page errors**, 29 screenshots archived in `qa-evidence/`. Workflow
  Run showed *0 ran / 3 reused* on a warm cache and *3 ran / 0 reused* when
  forced, and the SSE stream delivered live `workflow-node` frames.
- **Species identification, verified live** — a real 1200×900 photograph of a
  maize field returned *Rye Grass / Hordeum vulgare* at 0.85 confidence in
  99 s (full-frame) and 71 s (tile region), both through a local Ollama
  vision model (8 Oct 2026).
- **Live connector proof** — real Sentinel-2 scenes < 2 days old with previews,
  a 3-scene SAR series, DEM terrain at -4 m with a drainage verdict, and a
  weather cross-check that agrees with Open-Meteo to 0.27 °C over the days both
  sources report.
- **Browser checks** — all 9 tabs render, 139 unique DOM ids, zero console
  errors; the Workflows tab ran a real 3-node workflow from the UI and printed
  its per-node timings (CP4 session and again 8 Oct).
- **Installability checks** (12 Oct 2026) — console PWA verified from the
  browser as registered, active and controlling, with a populated shell cache
  (`/`, `/index.html`, manifest, both icons, SVG); the dashboard's service
  worker was verified in a production build the same way. Both manifests parse
  with 4 icons each and `display: standalone`.
- **Security checks** (12 Oct 2026) — the live CSP's three basemap tile hosts
  were matched against the hosts the code actually requests; security and
  `RateLimit-*` headers confirmed on real responses; the dashboard's new pages
  produced zero browser console errors.
- **OpenStreetMap checks** (13 Oct 2026) — **live** round-trips against the real
  services, not mocks: a search for *Emmeloord Flevoland* returned the real
  place; reverse geocoding at the demo field returned *“33, Zuidermeerweg,
  Nagele, Noordoostpolder, Flevoland”*; the feature layer returned **142 real
  OSM features** within 900 m of it (61 roads, 4 waterways, 4 water bodies, 73
  land-use polygons) and **400 capped** within 1.2 km of Luttelgeest; a picked
  point with `area_ha: 12` stored **12.00 ha** in EPSG:32631; the console's map
  loaded OSM tiles and drew 222 features from its own catalogue. The rate gate,
  the never-retry-429 rule and the 5xx retry are asserted in both suites, and a
  504 from the shared Overpass instance was observed, retried and recovered
  while the failure was shown honestly rather than drawn as an empty map.
- **Docs checks** — README 0 emoji, balanced code fences, table-of-contents
  anchors resolve.

---

## 10. Run it (quick-start block)

```bash
# install (once)
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt     # Python platform
npm --prefix frontend install               # dashboard
npm --prefix crop-ai install                # console deps
ollama pull qwen2.5vl:3b                    # local species-ID model (3.2 GB)

# one command starts console + mock AI + Ollama
./start.sh                                  # http://localhost:5177

# the Python platform (two terminals)
cd backend && uvicorn main:app --reload --port 8000   # API, docs on :8000/docs
cd frontend && npm run dev                           # dashboard on :5173

# tests
.venv/bin/python -m pytest tests -q         # 294 tests
cd crop-ai && npm test                      # 34 tests
node tools/vercel_harness.js                # 15 checks
```

| Port | Service |
|---|---|
| 5177 | Crop AI console (API + web console in one process) |
| 5199 | Reference crop-vision model (mock AI, optional) |
| 11434 | Ollama (species identification) |
| 8000 | FastAPI platform API |
| 5173 | React dashboard (Vite dev server) |

---

## 11. Deploy it

- **Long-lived host** — pm2 or a systemd unit behind a TLS-reverse proxy;
  health check `GET /api/health`; state is one folder (`crop-ai/data/`) so a
  host can be rebuilt from backups.
- **Docker** — one Dockerfile, two build targets (backend image + frontend
  image), `data/` and `outputs/` bind-mounted so results survive rebuilds.
- **Vercel (serverless)** — `api/index.js` re-exports the console, a catch-all
  rewrite routes all traffic to one function, `functions.includeFiles` bundles
  the console and its data, and the server seeds state into `/tmp` on cold
  start because the filesystem is read-only. Known limits: no background
  timers, no local Ollama (point the identify endpoint at a reachable host),
  state resets when an instance recycles.

**Security posture (say this out loud on a poster):** the console has **no
user authentication** — it is a demo/edge tool, so run it behind a TLS reverse
proxy or enable Vercel Deployment Protection rather than exposing it raw. The
one credential system it does have is device-side: every sensor registers with
its own `ingestToken`, and ingest returns 401 for a bad token.

---

## 12. Status and roadmap (the "what's next" panel)

**12 checkpoints, demo freeze 8 Oct 2026, production target 5 Nov 2026.**

- **Complete (CP1–CP4):** geo-mapped agronomy with 11 layers · sensor network
  grouped by site · console typography and GUI · six data-integrity fixes.
- **Delivered 8 Oct (Phase B pulled forward):** CP9 fusion data connectors —
  Sentinel-2, Sentinel-1, Copernicus DEM terrain and a NASA POWER
  cross-check, all with provenance; CP10 workflow DAG engine with hash
  caching, run history and the Workflows tab.
- **Delivered earlier:** plant species identification (5 Oct, re-verified
  8 Oct) · repository under version control (5 Oct) · full setup/run/deploy
  documentation and Vercel serverless compatibility (8 Oct).
- **Delivered 12 Oct (post-freeze capability + hardening pass):** the index
  engine went 4 → 13 indices; the **agronomy engine** landed (7 documented
  models, 8 endpoints) closing most of CP11; both frontends were rebuilt in a
  shared brutalist design system with View Transitions and scroll motion; both
  apps became installable PWAs; and the security posture became inspectable —
  10 headers plus CSP on the API, timing-safe device tokens and per-route limits
  on the console, and a `/api/security` endpoint with its own dashboard page.
- **In progress:** CP5 test coverage — **34 console tests** plus a 15-check
  serverless harness are green (pytest is now **253**); Playwright smoke and the
  UI regression pins are the open gap. CP6 demo polish: coordinates fixed, three
  items open.
- **Next:** fusion model library — harvest-period detection from Sentinel-2
  history, crop segmentation, micro-climate, cloud-free compositing (27 Oct) ·
  production hardening: auth and tenancy, PostgreSQL/PostGIS, observability, CI
  (5 Nov).

---

## 13. Suggested poster layout (7 panels — merge any two if you only have room for six)

| Panel | Headline | Body | Stat to feature |
|---|---|---|---|
| 1 | *See every tile of the field* | Drone photo in, 400 georeferenced tiles out, four ground classes, one laptop | 50 px tiles |
| 2 | *Numbers you can defend* | 13 features, kNN with 5-fold cross-validation, per-class precision/recall/F1, provenance on every value | 328 tests + 73 route checks green |
| 3 | *The weather is real* | Live Open-Meteo, 14 variables, soil moisture from satellite or probe, honest nulls | 14 live variables |
| 4 | *Name that plant* | Camera or field region → local vision model → species, confidence, candidates, traits; refuses to guess | 70–100 s on CPU, measured |
| 5 | *Water on evidence* | Soil moisture + rain + ET0 + stress → irrigate now / 24 h / none, with litres per acre and reasons | 9 sensor types |
| 6 | *The work you don't repeat* | Input-hash caching: a new probe reading re-ran 3 nodes and left 8 satellite fetches cached | 12 node types |
| 7 | *Ship it anywhere* | One command locally, pm2 or systemd, Docker, or a serverless function — the same code | 4 deploy targets |

---

## 14. Glossary (for the small print)

| Term | Meaning |
|---|---|
| NDVI / NDRE / EVI / SAVI | Vegetation indices computed from band ratios (greenness, chlorophyll, stressed canopy, soil-adjusted) |
| ET0 | Reference evapotranspiration, mm/day — how much water the field loses |
| VWC | Volumetric water content, % of soil volume that is water |
| GSD | Ground sample distance — metres represented by one pixel |
| AOI | Area of interest — the field polygon that clips a raster |
| kNN | k-nearest neighbours — the local classifier behind tile labels |
| SSE | Server-sent events — the live update stream to the browser |
| EXIF GPS | Location metadata embedded in a photo by the camera |
| GeoTIFF | Geo-referenced TIFF carrying CRS and coordinates |
| SAR | Synthetic aperture radar (Sentinel-1) — sees through cloud |

---

## 15. Sources and attribution

- Weather and soil: **Open-Meteo** (keyless API; attribution required).
- Map basemaps: **OpenStreetMap** contributors (**ODbL 1.0** — the street,
  humanitarian and terrain styles are the default), plus Esri World Imagery and
  Google satellite. Attribution is a licence condition here, so the credit is
  rendered under every map with a link to the OSM copyright page, published by
  `/api/geo/status` and shown on the Security page — not just tucked into a tile
  URL. Place names and map features are OpenStreetMap data via **Nominatim** and
  the **Overpass API**; the tile servers are donated capacity, used at
  interactive pace only.
- Species identification: **Ollama** running **Qwen2.5-VL** locally; any
  OpenAI-compatible vision API can be substituted.
- Roadmap reference architecture: **microsoft/farmvibes-ai**.
- Fonts: **Space Grotesk**, **Inter**, **JetBrains Mono**.
- Repository state: `main` tracking `origin/main`, first commit
  `b036487` (5 Oct 2026); figures in this document measured 8 Oct 2026.
