/**
 * ============================================================================
 *  VIBES LITE · CROP AI  —  Production Edition
 *  AI Crop Monitoring from Drone/Phone/Camera Images
 *  Single-file backend (A-to-Z). No external ML service. Runs on localhost.
 * ============================================================================
 *  REAL DATA PATHS
 *   • Camera/drone images: EXIF GPS is extracted → field is georeferenced for
 *     real (lat/lon/altitude). Images without GPS can be geotagged via UI.
 *   • Weather & soil: live Open-Meteo forecast+soil API (real, no key).
 *   • Device sensors: POST /api/fields/:id/ingest with per-field token
 *     (Arduino/ESP32/Raspberry Pi/phone) — readings stream to dashboards via SSE.
 *   • Geo mapping: field footprints + per-tile classifications exported as
 *     GeoJSON, rendered on Esri/Google satellite basemaps (Leaflet).
 * ============================================================================
 *  OpenCV: opencv-wasm (cvtColor/GaussianBlur/Canny) + exact JS fallback.
 *  Model: 13-dim tile features → cosine kNN with per-model standardization;
 *  k-fold cross-validation metrics (accuracy, per-class P/R/F1) on training.
 * ============================================================================
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const ExifReader = require('exifreader');
const aoiSat = require('./lib/aoi-satellite');
const wheatAdvisor = require('./lib/agronomy-wheat');

/* ----------------------------- OpenCV loading ----------------------------- */
let cv = null;
let CV_MODE = 'fallback';
try {
  cv = require('opencv-wasm').cv;
  if (!cv || typeof cv.cvtColor !== 'function') throw new Error('unexpected export shape');
  CV_MODE = 'wasm';
  console.log('[cv] OpenCV (opencv-wasm) loaded — native pipeline active');
} catch (e) {
  cv = null;
  CV_MODE = 'fallback';
  console.warn('[cv] opencv-wasm unavailable, using built-in pure-JS CV fallback:', e.message);
}

/* --------------------------------- Config --------------------------------- */
const _envPort = parseInt(process.env.PORT, 10);
const PORT = Number.isFinite(_envPort) && _envPort > 0 ? _envPort : 5177;
const ROOT = __dirname;
let DATA_DIR = path.join(ROOT, 'data');
let UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
let SAMPLE_DIR = path.join(DATA_DIR, 'samples'); // legacy location, purged at boot
const PUBLIC_DIR = path.join(ROOT, 'public');

// Vercel deploys a read-only filesystem: /tmp is the only writable place.
// On a cold start in that environment, seed a private copy of the deployed
// state under /tmp and read and write there. The copy lives for the
// instance's lifetime; a fresh instance re-seeds from the bundle, so changes
// made on one instance are not guaranteed to survive a cold start (documented
// serverless behavior - see README, Deploy to Vercel).
if (process.env.VERCEL) {
  try {
    const dst = path.join(os.tmpdir(), 'crop-ai-data');
    if (!fs.existsSync(path.join(dst, '.seeded'))) {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(DATA_DIR, dst, { recursive: true });
      fs.writeFileSync(path.join(dst, '.seeded'), new Date().toISOString());
    }
    DATA_DIR = dst;
    UPLOAD_DIR = path.join(dst, 'uploads');
    SAMPLE_DIR = path.join(dst, 'samples');
  } catch (e) {
    console.warn('[vercel] tmp data seed failed, using read-only bundled data:', e.message);
  }
}

const CONFIG = {
  tileSize: 50,           // tile size (px)
  knnK: 5,
  cvFolds: 5,             // k-fold cross-validation on training
  weatherCacheSeconds: 600,
  deviceReadingsCap: 240, // per-field device reading history
  fieldSizeHintM: 60,     // assumed ground width (m) when EXIF GSD unknown
};

const CLASSES = {
  healthy:  { label: 'Healthy crop',  color: [76, 175, 80],  hex: '#4CAF50' },
  stressed: { label: 'Stressed crop', color: [255, 193, 7],  hex: '#FFC107' },
  soil:     { label: 'Bare soil',     color: [121, 85, 72],  hex: '#795548' },
  weed:     { label: 'Weed area',     color: [46, 158, 91],  hex: '#2E9E5B' },
};
const CLASS_KEYS = Object.keys(CLASSES);

/* ------------------------------ Small helpers ----------------------------- */
const nowIso = () => new Date().toISOString();

function hashSeed(str) {
  let h = 2166136261;
  for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function ensureDirs() {
  for (const d of [DATA_DIR, UPLOAD_DIR, SAMPLE_DIR]) fs.mkdirSync(d, { recursive: true });
}
function loadJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { return fallback; }
}
function saveJSON(name, obj) {
  ensureDirs();
  const p = path.join(DATA_DIR, name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

/* ------------------------------ Image decode/encode ------------------------ */
let PNGlib, JPEGlib;
function pngjs() { PNGlib = PNGlib || require('pngjs').PNG; return PNGlib; }
function jpegjs() { JPEGlib = JPEGlib || require('jpeg-js'); return JPEGlib; }

function decodeImage(buf, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.png') { const p = pngjs().sync.read(buf); return { width: p.width, height: p.height, rgba: p.data }; }
  if (ext === '.jpg' || ext === '.jpeg') { const i = jpegjs().decode(buf, { useTArray: true, formatAsRGBA: true }); return { width: i.width, height: i.height, rgba: i.data }; }
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) { const p = pngjs().sync.read(buf); return { width: p.width, height: p.height, rgba: p.data }; }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) { const i = jpegjs().decode(buf, { useTArray: true, formatAsRGBA: true }); return { width: i.width, height: i.height, rgba: i.data }; }
  return null;
}
function encodePng(width, height, rgba) {
  const PNG = pngjs();
  const png = new PNG({ width, height });
  Buffer.from(rgba.buffer ? rgba.buffer : rgba).copy(png.data, 0, 0, width * height * 4);
  return PNG.sync.write(png);
}

/* --------------------------- EXIF GPS / georeferencing --------------------- */
/** Extract GPS + capture metadata from image bytes. Returns null-safe object. */
function extractGeo(buf) {
  try {
    const tags = ExifReader.load(buf);
    const dec = (tag, refTag, negLetter) => {
      const v = tag?.description;
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      const ref = String(refTag?.description || '');
      return +((ref[0] === negLetter) ? -v : v).toFixed(7);
    };
    const lat = dec(tags['GPSLatitude'], tags['GPSLatitudeRef'], 'S');
    const lon = dec(tags['GPSLongitude'], tags['GPSLongitudeRef'], 'W');
    const out = {
      lat, lon,
      altitude: tags['GPSAltitude']?.description ?? null,
      capturedAt: tags['DateTimeOriginal']?.description || tags['DateTime']?.description || null,
      cameraMake: tags['Make']?.description || null,
      cameraModel: tags['Model']?.description || null,
    };
    if (out.lat != null && out.lon != null) out.source = 'exif';
    return out;
  } catch { return { lat: null, lon: null, source: 'none' }; }
}

/** Geographic helpers for footprint math (small-area approximations). */
function metersPerDegLat() { return 111320; }
function metersPerDegLon(lat) { return 111320 * Math.cos((lat * Math.PI) / 180); }
function offsetMeters(lat, lon, dxM, dyM) {
  return [lon + dxM / metersPerDegLon(lat), lat + dyM / metersPerDegLat()];
}
/** Field footprint polygon (GeoJSON ring) from center + ground size (m). */
function footprintRing(lat, lon, widthM, heightM) {
  const hw = widthM / 2, hh = heightM / 2;
  return [
    offsetMeters(lat, lon, -hw, -hh),
    offsetMeters(lat, lon,  hw, -hh),
    offsetMeters(lat, lon,  hw,  hh),
    offsetMeters(lat, lon, -hw,  hh),
    offsetMeters(lat, lon, -hw, -hh),
  ];
}

/* ------------------------- OpenCV-backed tile features --------------------- */
function cvTileFeatures(rgba, w, h) {
  const mat = cv.matFromArray(h, w, cv.CV_8UC4, Array.from(rgba));
  try {
    const gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    let sum = 0, sum2 = 0, n = w * h;
    const gd = blurred.data;
    for (let i = 0; i < n; i++) { const v = gd[i]; sum += v; sum2 += v * v; }
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const edges = new cv.Mat();
    cv.Canny(blurred, edges, 60, 140);
    let edgeCount = 0;
    const ed = edges.data;
    for (let i = 0; i < n; i++) if (ed[i] > 0) edgeCount++;
    let dark = 0;
    for (let i = 0; i < n; i++) if (gd[i] < mean * 0.72) dark++;
    gray.delete(); blurred.delete(); edges.delete(); mat.delete();
    return { textureStd: std / 255, edgeDensity: edgeCount / n, darkShare: dark / n };
  } catch (e) {
    mat.delete();
    return jsTileTextureFeatures(rgba, w, h);
  }
}

function jsTileTextureFeatures(rgba, w, h) {
  const n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    gray[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  const tmp = new Float32Array(n), blurred = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += gray[y * w + clamp(x + k, 0, w - 1)];
    tmp[y * w + x] = s / 5;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += tmp[clamp(y + k, 0, h - 1) * w + x];
    blurred[y * w + x] = s / 5;
  }
  let sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) { const v = blurred[i]; sum += v; sum2 += v * v; }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  let edgeCount = 0, dark = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
    const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
    if (Math.sqrt(gx * gx + gy * gy) > 120) edgeCount++;
    if (blurred[i] < mean * 0.72) dark++;
  }
  return { textureStd: std / 255, edgeDensity: edgeCount / n, darkShare: dark / n };
}

/** Compute the 13-dim feature vector for one RGBA tile. */
function featuresForTile(rgba, w, h) {
  const n = w * h;
  let rS = 0, gS = 0, bS = 0, rS2 = 0, gS2 = 0, bS2 = 0;
  let exgS = 0, variS = 0, brightS = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    rS += r; gS += g; bS += b;
    rS2 += r * r; gS2 += g * g; bS2 += b * b;
    exgS += 2 * g - r - b;
    variS += (g - r) / Math.max(1, g + r + b);
    brightS += (r + g + b) / 3;
  }
  const rM = rS / n, gM = gS / n, bM = bS / n;
  const rSd = Math.sqrt(Math.max(0, rS2 / n - rM * rM));
  const gSd = Math.sqrt(Math.max(0, gS2 / n - gM * gM));
  const bSd = Math.sqrt(Math.max(0, bS2 / n - bM * bM));
  const tex = CV_MODE === 'wasm' ? cvTileFeatures(rgba, w, h) : jsTileTextureFeatures(rgba, w, h);
  return [
    +(rM / 255).toFixed(5), +(gM / 255).toFixed(5), +(bM / 255).toFixed(5),
    +(rSd / 255).toFixed(5), +(gSd / 255).toFixed(5), +(bSd / 255).toFixed(5),
    +((gM - rM) / 255).toFixed(5),
    +(((2 * gM) - rM - bM) / 255).toFixed(5),
    +(variS / n).toFixed(5),
    +(brightS / n / 255).toFixed(5),
    +tex.textureStd.toFixed(5),
    +tex.edgeDensity.toFixed(5),
    +tex.darkShare.toFixed(5),
  ];
}

/* ------------------------------- Tile slicing ------------------------------- */
function rgbaSlice(rgba, W, x, y, T, T2) {
  const out = new Uint8ClampedArray(T * T2 * 4);
  for (let yy = 0; yy < T2; yy++) {
    const src = ((y + yy) * W + x) * 4;
    out.set(rgba.subarray(src, src + T * 4), yy * T * 4);
  }
  return out;
}

/* ------------------------------ kNN classifier ----------------------------- */
function standardizeFit(model, samples) {
  const n = samples.length;
  const mu = new Array(13).fill(0);
  const sd = new Array(13).fill(0);
  for (let d = 0; d < 13; d++) {
    let s = 0; for (const smp of samples) s += smp.f[d];
    const m = s / n;
    let v = 0; for (const smp of samples) v += (smp.f[d] - m) ** 2;
    mu[d] = m;
    sd[d] = Math.sqrt(v / n) || 1e-6;
  }
  model.mu = mu; model.sd = sd;
}

function knnVote(samples, mu, sd, features, k) {
  const q = features.map((v, d) => (v - mu[d]) / sd[d]);
  let qn = 0; for (let d = 0; d < q.length; d++) qn += q[d] * q[d];
  qn = Math.sqrt(qn) || 1;
  const scored = samples.map((s) => {
    const t = s._std || (s._std = s.f.map((v, d) => (v - mu[d]) / sd[d]));
    let dot = 0, nt = 0;
    for (let d = 0; d < q.length; d++) { dot += q[d] * t[d]; nt += t[d] * t[d]; }
    return { c: s.c, sim: dot / (qn * (Math.sqrt(nt) || 1)) };
  });
  scored.sort((a, b) => b.sim - a.sim);
  const kk = Math.min(k, scored.length);
  const votes = {};
  for (let i = 0; i < kk; i++) votes[scored[i].c] = (votes[scored[i].c] || 0) + 1;
  let best = null, bestN = -1;
  for (const [c, n] of Object.entries(votes)) if (n > bestN) { bestN = n; best = c; }
  return { predictedClass: best, confidence: +(bestN / kk).toFixed(3), k: kk };
}
function knnPredict(model, features) {
  return knnVote(model.data, model.mu, model.sd, features, CONFIG.knnK);
}

/** k-fold cross-validation → honest out-of-sample metrics for the model. */
function crossValidate(samples, folds) {
  const rng = mulberry32(hashSeed('cv-' + samples.length));
  const idx = samples.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const cm = {};
  for (const t of CLASS_KEYS) cm[t] = Object.fromEntries(CLASS_KEYS.map(p => [p, 0]));
  let correct = 0, total = 0;
  const foldOf = new Map();
  for (let f = 0, p = 0; p < idx.length; p++, f = (f + 1) % folds) foldOf.set(idx[p], f);
  for (let f = 0; f < folds; f++) {
    const train = samples.filter((_, i) => foldOf.get(i) !== f);
    const test = samples.filter((_, i) => foldOf.get(i) === f);
    if (!train.length || !test.length) continue;
    const m = {};
    standardizeFit(m, train);
    for (const smp of test) {
      const p = knnVote(train, m.mu, m.sd, smp.f, CONFIG.knnK).predictedClass;
      cm[smp.c][p]++;
      total++; if (p === smp.c) correct++;
    }
  }
  const perClass = {};
  for (const t of CLASS_KEYS) {
    const tp = cm[t][t];
    const fp = CLASS_KEYS.reduce((a, p) => a + (p === t ? 0 : cm[p][t]), 0);
    const fn = CLASS_KEYS.reduce((a, p) => a + (p === t ? 0 : cm[t][p]), 0);
    perClass[t] = {
      precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null,
      recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null,
      f1: tp + fp && tp + fn ? +(2 * (tp / (tp + fp)) * (tp / (tp + fn)) / ((tp / (tp + fp)) + (tp / (tp + fn)))).toFixed(3) : null,
      support: CLASS_KEYS.reduce((a, p) => a + cm[t][p], 0),
    };
  }
  const f1s = Object.values(perClass).filter(x => x.f1 != null).map(x => x.f1);
  return {
    folds,
    accuracy: total ? +(correct / total).toFixed(3) : null,
    macroF1: f1s.length ? +(f1s.reduce((a, b) => a + b, 0) / f1s.length).toFixed(3) : null,
    perClass,
    confusion: cm,
    tested: total,
  };
}

/* ------------------------------- Field store ------------------------------- */
let fields = loadJSON('fields.json', {});
let models = loadJSON('models.json', {});
let sensors = loadJSON('sensors.json', {});

function persistAll() {
  const slim = {};
  for (const [k, f] of Object.entries(fields)) { const { imageData, ...rest } = f; slim[k] = rest; }
  saveJSON('fields.json', slim);
  const slimModels = {};
  for (const [k, m] of Object.entries(models)) slimModels[k] = { ...m, data: m.data.map(({ _std, ...rest }) => rest) };
  saveJSON('models.json', slimModels);
  saveJSON('sensors.json', sensors);
}

function ensureImageData(f) {
  if (f.imageData) return true;
  const p = path.join(ROOT, f.imagePath || '');
  if (!fs.existsSync(p)) return false;
  const img = decodeImage(fs.readFileSync(p), p);
  if (!img) return false;
  f.imageData = img.rgba;
  return true;
}

function fieldSummary(f) {
  if (!f) return null;
  const s = f.stats || {};
  const total = CLASS_KEYS.reduce((a, k) => a + (s[k] || 0), 0) || 1;
  return {
    fieldId: f.fieldId,
    imageName: f.imageName,
    status: f.status,
    grid: f.grid,
    tileSize: f.tileSize,
    width: f.width, height: f.height,
    uploadedAt: f.uploadedAt,
    analyzedAt: f.analyzedAt || null,
    modelId: f.modelId || null,
    gps: f.gps || null,
    geo: f.geo || null,
    groundWidthM: f.groundWidthM || null,
    stats: s,
    statsPct: Object.fromEntries(CLASS_KEYS.map(k => [k, +(((s[k] || 0) / total) * 100).toFixed(1)])),
    overlayPath: f.overlayPath ? `${f.overlayPath}?v=${f.overlayVersion || 0}` : null,
    irrigation: f.irrigation || null,
    hasSensorToken: !!f.ingestToken,
  };
}

/* ------------------------- Real weather (Open-Meteo) ----------------------- */
const weatherCache = new Map(); // key "lat,lon(3dp)" -> {t, data}

// Open-Meteo reports soil moisture as m3/m3 and uses exactly 0 as the ECMWF
// model's fill value over grid cells it does not cover. Real soil is never at
// 0% VWC, so a non-positive reading is a model gap, not a dry field -- it must
// stay null so irrigation and soil-quality scoring fall back to a real probe
// instead of inventing a bone-dry 0% that would raise a false critical alert.
function soilMoisturePct(m3) {
  if (typeof m3 !== 'number' || !Number.isFinite(m3) || m3 <= 0) return null;
  return +(m3 * 100).toFixed(1);
}

async function fetchRealWeather(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.t < CONFIG.weatherCacheSeconds * 1000) return hit.data;
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,et0_fao_evapotranspiration,'
    + 'soil_moisture_0_to_1cm,soil_moisture_3_9cm,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,pressure_msl,weather_code'
    + '&daily=precipitation_sum&timezone=auto';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const j = await res.json();
  const c = j.current || {};
  const data = {
    source: 'open-meteo',
    live: true,
    observedAt: c.time || null,
    timezone: j.timezone || null,
    airTempC: c.temperature_2m ?? null,
    feelsLikeC: c.apparent_temperature ?? null,
    humidityPct: c.relative_humidity_2m ?? null,
    precipitationMm: c.precipitation ?? null,
    rainTodayMm: j.daily?.precipitation_sum?.[0] ?? null,
    et0MmDay: c.et0_fao_evapotranspiration ?? null,
    soilMoisturePct: soilMoisturePct(c.soil_moisture_3_9cm),
    soilMoistureSurfacePct: soilMoisturePct(c.soil_moisture_0_to_1cm),
    soilTempC: null,
    windKmh: c.wind_speed_10m ?? null,
    windDirDeg: c.wind_direction_10m ?? null,
    windGustKmh: c.wind_gusts_10m ?? null,
    cloudPct: c.cloud_cover ?? null,
    pressureHpa: c.pressure_msl ?? null,
    weatherCode: c.weather_code ?? null,
    fetchedAt: nowIso(),
  };
  weatherCache.set(key, { t: Date.now(), data });
  return data;
}

/* ══════════ Real weather for any date (ERA5 / ERA5-Land reanalysis) ══════════
 * The forecast endpoint above answers "now" and the days ahead. This one
 * answers "what was it actually like on the day that image was taken", which is
 * the only way a single-date acquisition can be read in context.
 *
 * Windy cannot serve this at any price - its own pricing page says "It is not
 * possible to retrieve historical forecasts with past data", its free tier
 * returns "randomly shuffled and slightly modified data" for development only,
 * and its paid parameter list has no radiation, evapotranspiration or soil
 * moisture. So the same physics is fetched directly: ERA5/ERA5-Land through the
 * Open-Meteo archive, from 1940 to today, free and keyless.
 * ══════════════════════════════════════════════════════════════════════════ */
const ARCHIVE_DAILY_VARS = [
  'temperature_2m_max', 'temperature_2m_min', 'temperature_2m_mean',
  'relative_humidity_2m_mean', 'dew_point_2m_mean',
  'precipitation_sum', 'rain_sum',
  'wind_speed_10m_max', 'wind_speed_10m_mean', 'wind_gusts_10m_max', 'wind_direction_10m_dominant',
  'shortwave_radiation_sum', 'et0_fao_evapotranspiration',
  'cloud_cover_mean', 'pressure_msl_mean',
  'soil_moisture_0_to_7cm_mean', 'soil_temperature_0_to_7cm_mean',
];
const ARCHIVE_START_DAY = '1940-01-01';
// A reanalysis publishes its most recent days from a preliminary stream that can
// still be revised; past this many days a value is settled.
const PROVISIONAL_DAYS = 5;
const WEATHER_MAX_DAYS = 3660;

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const todayIso = () => isoDay(Date.now());
const addDays = (iso, days) => isoDay(new Date(`${iso}T00:00:00Z`).getTime() + days * 86400000);

/** Validate an ISO day string; returns the day or null. Pure. */
function parseIsoDay(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trip, so 2026-02-31 is rejected rather than silently rolled over.
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}

/** A named reason the window cannot be served, or null. Pure. */
function weatherWindowProblem(start, end) {
  if (!start || !end) return 'start and end must be ISO dates (YYYY-MM-DD).';
  if (start < ARCHIVE_START_DAY) return `the reanalysis archive starts on ${ARCHIVE_START_DAY}; ${start} is before it.`;
  if (end < start) return `start (${start}) is after end (${end}).`;
  const span = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (span > WEATHER_MAX_DAYS) return `a single request may span at most ${WEATHER_MAX_DAYS} days; ${span} were asked for.`;
  if (end > todayIso()) return `the archive ends today (${todayIso()}); ${end} is in the future. Use the forecast for the days ahead.`;
  return null;
}

/**
 * One archive response as canonical day rows. Pure.
 *
 * A day the provider does not report stays null and is counted, never
 * estimated: this is the record an image gets interpreted against, so a made-up
 * number here would quietly invalidate the interpretation.
 */
function normalizeWeatherDays(payload) {
  const daily = (payload && payload.daily) || {};
  const times = daily.time || [];
  const num = (key, i) => {
    const column = daily[key];
    const value = Array.isArray(column) ? column[i] : null;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const today = todayIso();
  return times.map((stamp, i) => {
    const date = String(stamp).slice(0, 10);
    const soil = num('soil_moisture_0_to_7cm_mean', i);
    const row = {
      date,
      tMaxC: num('temperature_2m_max', i),
      tMinC: num('temperature_2m_min', i),
      tMeanC: num('temperature_2m_mean', i),
      humidityPct: num('relative_humidity_2m_mean', i),
      dewPointC: num('dew_point_2m_mean', i),
      precipitationMm: num('precipitation_sum', i),
      rainMm: num('rain_sum', i),
      windMaxKmh: num('wind_speed_10m_max', i),
      windMeanKmh: num('wind_speed_10m_mean', i),
      windGustKmh: num('wind_gusts_10m_max', i),
      windDirDeg: num('wind_direction_10m_dominant', i),
      radiationMjM2: num('shortwave_radiation_sum', i),
      et0Mm: num('et0_fao_evapotranspiration', i),
      cloudPct: num('cloud_cover_mean', i),
      pressureHpa: num('pressure_msl_mean', i),
      soilMoisturePct: soilMoisturePct(soil),
      soilTempC: num('soil_temperature_0_to_7cm_mean', i),
      source: 'open-meteo-archive',
      provisional: date > addDays(today, -PROVISIONAL_DAYS),
    };
    row.reported = Object.keys(row).some((k) => row[k] !== null && !['date', 'source', 'provisional'].includes(k));
    return row;
  });
}

/** Rain, ET0, water balance and temperature range over the reported days. Pure. */
function weatherSeasonSummary(days) {
  const sum = (key) => {
    const values = days.map((d) => d[key]).filter((v) => typeof v === 'number');
    return values.length ? +values.reduce((a, b) => a + b, 0).toFixed(1) : null;
  };
  const mean = (key) => {
    const values = days.map((d) => d[key]).filter((v) => typeof v === 'number');
    return values.length ? +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) : null;
  };
  const extrema = (key, pick) => {
    const values = days.map((d) => d[key]).filter((v) => typeof v === 'number');
    return values.length ? pick(...values) : null;
  };
  const rain = sum('precipitationMm');
  const et0 = sum('et0Mm');
  return {
    daysReported: days.filter((d) => d.reported).length,
    daysMissing: days.length - days.filter((d) => d.reported).length,
    daysProvisional: days.filter((d) => d.provisional).length,
    rainSumMm: rain,
    et0SumMm: et0,
    waterBalanceMm: rain != null && et0 != null ? +(rain - et0).toFixed(1) : null,
    tMeanC: mean('tMeanC'),
    tMaxC: extrema('tMaxC', Math.max),
    tMinC: extrema('tMinC', Math.min),
    radiationSumMjM2: sum('radiationMjM2'),
    soilMoistureMeanPct: mean('soilMoisturePct'),
  };
}

/** One weather row per requested date, plus the dates nobody could answer. Pure. */
function matchWeatherToDates(days, dates) {
  const index = new Map(days.map((d) => [d.date, d]));
  const wanted = [...new Set(dates)];
  const matched = [];
  const missing = [];
  for (const date of wanted) {
    const row = index.get(date);
    if (row && row.reported) matched.push(row); else missing.push(date);
  }
  return { matched, missing };
}

/** Daily reanalysis weather for a window - the "any date" source. */
async function fetchWeatherHistory(lat, lon, start, end) {
  const problem = weatherWindowProblem(start, end);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const key = `wxhist:${lat.toFixed(3)},${lon.toFixed(3)}:${start}:${end}`;
  const hit = cacheGet(key, 6 * 60 * 60 * 1000);
  if (hit) return { ...hit, cached: true };

  const url = `${SOURCES['open-meteo-archive'].endpoint}?latitude=${lat}&longitude=${lon}`
    + `&start_date=${start}&end_date=${end}`
    + `&daily=${ARCHIVE_DAILY_VARS.join(',')}&timezone=UTC`;
  const payload = await fetchJson(url, { timeoutMs: 30000 });
  touchSource('open-meteo-archive');
  const days = normalizeWeatherDays(payload);
  if (!days.length) throw new Error('the reanalysis archive returned no days for this window');

  const warnings = [];
  const missing = days.filter((d) => !d.reported).map((d) => d.date);
  if (missing.length) {
    warnings.push(`${missing.length} day(s) are reported by no source (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', ...' : ''}); they stay null rather than being estimated.`);
  }
  if (days.some((d) => d.provisional)) {
    warnings.push(`the most recent ${PROVISIONAL_DAYS} days come from a preliminary stream and can still be revised.`);
  }
  const out = {
    window: { from: start, to: end, days: days.length },
    days,
    summary: weatherSeasonSummary(days),
    warnings,
    note: 'ERA5/ERA5-Land reanalysis aggregated to daily: a model reconstruction of the past, not a rain gauge. Rain and soil moisture are estimates of a grid cell, not a measurement at the field.',
    provenance: [provFor('open-meteo-archive')],
    fetchedAt: nowIso(),
    cached: false,
  };
  return cacheSet(key, out);
}

/** Weather on each scene's own acquisition date - the join that dates an image. */
async function weatherForSceneDates(lat, lon, scenes) {
  const dates = scenes
    .map((s) => (s.datetime ? String(s.datetime).slice(0, 10) : null))
    .filter((d) => d && parseIsoDay(d))
    .sort();
  if (!dates.length) throw Object.assign(new Error('none of these scenes carries an acquisition date'), { status: 400 });
  const history = await fetchWeatherHistory(lat, lon, dates[0], dates[dates.length - 1]);
  const { matched, missing } = matchWeatherToDates(history.days, dates);
  const byDate = new Map(matched.map((d) => [d.date, d]));
  return {
    scenes: scenes.map((scene) => {
      const date = scene.datetime ? String(scene.datetime).slice(0, 10) : null;
      return {
        id: scene.id,
        datetime: scene.datetime || null,
        cloudCover: scene.cloudCover ?? null,
        weather: date ? byDate.get(date) || null : null,
        weatherDate: date,
      };
    }),
    dates: matched.map((d) => d.date),
    missing,
    window: history.window,
    warnings: history.warnings,
    note: 'Each acquisition is paired with the weather of its own day, so a green or bare image can be read against what the weather was doing.',
    provenance: [provFor('open-meteo-archive')],
    fetchedAt: nowIso(),
  };
}

/* ------------------------------ Sensor model ------------------------------- */
function newSensorRecord(fieldId) {
  return {
    fieldId,
    weather: null,          // real Open-Meteo data (when field has GPS)
    weatherError: null,
    device: [],             // site-level device ingest readings [{t, ...values}]
    devices: {},            // registered sensors, keyed by deviceId
    updatedAt: nowIso(),
  };
}
function getSensor(fieldId) {
  if (!sensors[fieldId]) sensors[fieldId] = newSensorRecord(fieldId);
  return sensors[fieldId];
}

/** Refresh real weather for all georeferenced fields (non-blocking). */
async function refreshWeatherAll() {
  for (const f of Object.values(fields)) {
    if (!f.gps || f.gps.lat == null) continue;
    const rec = getSensor(f.fieldId);
    try {
      rec.weather = await fetchRealWeather(f.gps.lat, f.gps.lon);
      rec.weatherError = null;
    } catch (e) {
      rec.weatherError = e.message;
    }
    rec.updatedAt = nowIso();
  }
  saveJSON('sensors.json', sensors);
  sseSend('sensors', Object.values(sensors));
}


/* ----------------------------- Sensor registry -----------------------------
 * A SITE is a field. A site can carry MANY sensors, each with its own type,
 * position (lat/lon and/or tile) and reading history. Hardware posts with
 * X-Sensor-Token plus ?deviceId=... so every reading is attributable to the
 * exact probe that produced it.
 * ------------------------------------------------------------------------- */
const SENSOR_TYPES = {
  'soil-probe':      { label: 'Soil probe',      primary: 'soilMoisture', metrics: ['soilMoisture', 'soilTempC', 'ec', 'ph'],            unit: '% VWC' },
  'weather-station': { label: 'Weather station', primary: 'temperatureC', metrics: ['temperatureC', 'humidityPct', 'rainMm', 'windKmh', 'lightLux', 'battery'], unit: '°C' },
  'anemometer':      { label: 'Anemometer',      primary: 'windKmh',      metrics: ['windKmh'],                                  unit: 'km/h' },
  'rain-gauge':      { label: 'Rain gauge',      primary: 'rainMm',       metrics: ['rainMm'],                                   unit: 'mm' },
  'soil-temp':       { label: 'Soil temperature',primary: 'soilTempC',    metrics: ['soilTempC', 'soilMoisture'],                  unit: '°C' },
  'ph-ec':           { label: 'pH / EC probe',   primary: 'ph',           metrics: ['ph', 'ec'],                                  unit: 'pH' },
  'light':           { label: 'Light sensor',    primary: 'lightLux',     metrics: ['lightLux'],                                  unit: 'lux' },
  'camera':          { label: 'Field camera',    primary: 'battery',      metrics: ['battery'],                                   unit: '%' },
  'generic':         { label: 'Generic device',  primary: null,           metrics: [],                                             unit: '' },
};
const SENSOR_KEYS = Object.keys(SENSOR_TYPES);
const SENSOR_UNITS = {
  soilMoisture: '%', soilTempC: '°C', temperatureC: '°C', humidityPct: '%', ph: 'pH', ec: 'mS/cm',
  rainMm: 'mm', battery: '%', windKmh: 'km/h', lightLux: 'lux',
};

/** WGS84 centre of tile (r,c) inside a field footprint, or null without GPS. */
function tileGeo(field, r, c) {
  const g = field?.gps;
  if (!g || g.lat == null || g.lon == null) return { lat: null, lon: null };
  const geo = fieldGeometry(field);
  const dx = (c + 0.5 - geo.cols / 2) * geo.tileW;
  const dy = (geo.rows / 2 - r - 0.5) * geo.tileH;
  return {
    lat: +(g.lat + dy / metersPerDegLat()).toFixed(7),
    lon: +(g.lon + dx / metersPerDegLon(g.lat)).toFixed(7),
  };
}

function newDevice({ field, fieldId, name, type, lat, lon, r, c }) {
  const t = SENSOR_TYPES[type] ? type : 'generic';
  const fin = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);
  const rr = fin(r);
  const cc = fin(c);
  // A probe pinned to a tile sits exactly on that tile; otherwise fall back to
  // the coordinates it was registered with, then to the field centre.
  const fromTile = rr != null && cc != null ? tileGeo(field, rr, cc) : { lat: null, lon: null };
  const la = fin(lat), lo = fin(lon);
  return {
    deviceId: `S-${crypto.randomBytes(3).toString('hex')}`,
    fieldId,
    name: (name || SENSOR_TYPES[t].label).slice(0, 60),
    type: t,
    lat: la ?? fromTile.lat ?? field?.gps?.lat ?? null,
    lon: lo ?? fromTile.lon ?? field?.gps?.lon ?? null,
    r: rr,
    c: cc,
    ingestToken: crypto.randomBytes(8).toString('hex'),
    installedAt: nowIso(),
    lastSeen: null,
    count: 0,
    readings: [],
  };
}

/** Make sure every site record carries a valid devices map (schema migration). */
function ensureDevices(rec) {
  if (!rec.devices || typeof rec.devices !== 'object' || Array.isArray(rec.devices)) rec.devices = {};
  return rec.devices;
}

/** Latest reading of a device, or null. */
const deviceLatest = (dev) => (dev?.readings?.length ? dev.readings[dev.readings.length - 1] : null);

/** Summarise a device for the UI: identity, liveness and its primary metric. */
function deviceSummary(dev) {
  const spec = SENSOR_TYPES[dev.type] || SENSOR_TYPES.generic;
  const latest = deviceLatest(dev);
  const primaryKey = spec.primary;
  const value = latest && primaryKey ? latest[primaryKey] : null;
  const series = primaryKey ? (dev.readings || []).map((r) => r[primaryKey]).filter((v) => v != null) : [];
  const ageMin = dev.lastSeen ? (Date.now() - new Date(dev.lastSeen).getTime()) / 60000 : null;
  return {
    deviceId: dev.deviceId,
    fieldId: dev.fieldId,
    name: dev.name,
    type: dev.type,
    typeLabel: spec.label,
    metrics: spec.metrics,
    primaryKey,
    primaryUnit: spec.unit || SENSOR_UNITS[primaryKey] || '',
    value,
    latest,
    series: series.slice(-40),
    lat: dev.lat, lon: dev.lon, r: dev.r, c: dev.c,
    installedAt: dev.installedAt,
    lastSeen: dev.lastSeen,
    count: dev.count || 0,
    ageMinutes: ageMin == null ? null : +ageMin.toFixed(1),
    status: ageMin == null ? 'no-data' : ageMin < 15 ? 'live' : ageMin < 1440 ? 'stale' : 'offline',
  };
}

/* ---------------------------- Irrigation engine ---------------------------- */
/**
 * The freshest device reading on a site: the site-level stream plus every
 * registered sensor, newest timestamp wins. Null-safe against legacy records.
 */
function latestDeviceReading(rec) {
  let best = null;
  const consider = (d) => { if (d && (!best || (d.t || '') > (best.t || ''))) best = d; };
  if (rec && Array.isArray(rec.device)) consider(rec.device[rec.device.length - 1]);
  if (rec && rec.devices) for (const d of Object.values(rec.devices)) consider(deviceLatest(d));
  return best;
}

/**
 * A per-metric merged view of everything a site is reporting: for each key we
 * take the newest reading that actually CARRIES it, and remember which sensor
 * produced it. A site with twenty sensors must not let a wind-only anemometer
 * shadow the soil probe's moisture value just because it reported more recently.
 */
function mergedDeviceReading(rec) {
  const all = [];
  if (rec && Array.isArray(rec.device)) {
    for (const r of rec.device) if (r) all.push({ ...r, _src: r.deviceId || 'site-stream' });
  }
  if (rec && rec.devices) {
    for (const [key, d] of Object.entries(rec.devices)) {
      const l = deviceLatest(d);
      // The map key is the fallback attribution: older records were written
      // before every device carried its own deviceId field, and a reading with
      // no provenance at all is worse than one attributed to its registry slot.
      if (l) all.push({ ...l, _src: d.deviceId || key });
    }
  }
  if (!all.length) return null;
  all.sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')));
  const out = { t: all[0].t, sources: {} };
  for (const r of all) {
    for (const [k, v] of Object.entries(r)) {
      if (k === 't' || k === '_src' || v == null || out[k] != null) continue;
      out[k] = v;
      out.sources[k] = r._src;
    }
  }
  return out;
}

function recommendIrrigation(field) {
  const f = fieldSummary(field);
  const pct = f.statsPct;
  const rec = getSensor(field.fieldId);
  const wx = rec.weather;
  const dev = mergedDeviceReading(rec);
  const fromDevice = (k) => !!(dev && dev[k] != null && dev.sources && dev.sources[k]);

  const soilMoisture = dev?.soilMoisture ?? wx?.soilMoisturePct ?? null;
  const rainMm = wx?.precipitationMm ?? dev?.rainMm ?? null;
  const et0 = wx?.et0MmDay ?? null;
  const airTemp = dev?.temperatureC ?? wx?.airTempC ?? null;

  if (soilMoisture == null) {
    return {
      insufficient: true,
      reason: !dev && !wx
        ? 'No soil-moisture source: connect a device sensor (POST /api/fields/{id}/ingest) or georeference the field for satellite soil moisture.'
        : `No soil-moisture data available yet${dev ? ` (probe ${dev.deviceId || 'reading'} carries no moisture key)` : ''}.`,
    };
  }
  const sources = [
    dev ? 'device' : null,
    wx ? 'weather-api' : null,
  ].filter(Boolean);

  let need = soilMoisture < 24 ? 'high' : soilMoisture < 34 ? 'medium' : 'low';
  if ((rainMm ?? 0) > 6) need = 'low';
  if (pct.stressed > 20 && soilMoisture < 34) need = 'high';
  const dry = 100 - pct.healthy * 0.5 - pct.weed * 0.2;
  const liters = need === 'high' ? Math.round(320 + dry * 2.4)
               : need === 'medium' ? Math.round(180 + dry * 1.4) : 0;
  const alerts = [];
  if (pct.weed > 8) alerts.push({ level: 'warning', text: `Weed pressure ${pct.weed}% — scout & consider spot spraying` });
  if (pct.stressed > 18) alerts.push({ level: 'warning', text: `Crop stress ${pct.stressed}% — check irrigation uniformity` });
  if (pct.soil > 12) alerts.push({ level: 'info', text: `Bare soil ${pct.soil}% — possible germination gaps` });
  if (soilMoisture < 20) alerts.push({ level: 'critical', text: `Soil moisture critical (${soilMoisture}%)` });
  if ((airTemp ?? 0) > 34) alerts.push({ level: 'info', text: `Heat stress risk (${airTemp}°C)` });

  return {
    recommendation: need === 'high' ? 'Irrigate now' : need === 'medium' ? 'Irrigate within 24h' : 'No irrigation needed',
    urgency: need,
    litersPerAcre: liters,
    inputs: {
      soilMoisture, rainMm, et0, airTemp,
      soilMoistureSource: fromDevice('soilMoisture') ? `device:${dev.sources.soilMoisture}` : 'weather-api',
      dataSources: sources,
    },
    reasons: [
      `soil moisture ${soilMoisture}% (${fromDevice('soilMoisture') ? `probe ${dev.sources.soilMoisture}` : 'Open-Meteo satellite'})`,
      `stressed crop ${pct.stressed}%`,
      rainMm != null ? `precipitation ${rainMm} mm` : 'no rain data',
      et0 != null ? `ET0 ${et0} mm/day` : 'no ET0 data',
    ],
    alerts,
  };
}

/* ═══════════════════════════ EXTERNAL AI INTEGRATION ══════════════════════
 * The crop-condition model can run ANYWHERE (cloud GPU, colleague's box,
 * a vendor endpoint). This server talks to it over plain HTTP+JSON.
 *
 *   provider  'disabled' | 'generic' | 'openai'
 *   generic   POST {baseUrl}  {model, task, classes, image(dataURL), …}
 *   openai    POST {baseUrl}/chat/completions   (OpenAI-compatible vision)
 *
 * Response parsing is deliberately tolerant: any of label/class, confidence/
 * score/probabilities, health/vigor/quality, weed*, soil* and an optional
 * tile grid are accepted. Whatever comes back is normalized into one shape,
 * then combined with real ground data (tile geometry + device + weather) by
 * the agronomy engine below. With no AI configured the local kNN model is
 * used and the report says so — nothing is ever invented.
 * ═══════════════════════════════════════════════════════════════════════ */
let aiConfig = loadJSON('ai-config.json', {});
const aiState = { calls: 0, errors: 0, lastCallAt: null, lastLatencyMs: null, lastError: null, lastSource: null };
const idState = { calls: 0, errors: 0, lastCallAt: null, lastLatencyMs: null, lastError: null, lastSource: null };

function aiSettings() {
  const s = aiConfig || {};
  return {
    provider: process.env.AI_PROVIDER || s.provider || 'disabled',
    baseUrl: (process.env.AI_API_URL || s.baseUrl || '').trim(),
    apiKey: process.env.AI_API_KEY || s.apiKey || '',
    model: process.env.AI_MODEL || s.model || '',
    timeoutMs: Math.max(2000, +(process.env.AI_TIMEOUT_MS || s.timeoutMs || 45000)),
    enabled: s.enabled !== false,
  };
}
const aiConfigured = () => { const s = aiSettings(); return s.enabled && s.provider !== 'disabled' && !!s.baseUrl; };
const maskKey = (k) => (k ? (k.length <= 8 ? '••••••••' : `${k.slice(0, 3)}••••${k.slice(-3)}`) : '');

/* ---- Species identification: an OPTIONAL second endpoint -------------------
 * The agronomy model classifies ground cover (healthy/stressed/soil/weed);
 * naming a plant SPECIES needs a different, usually vision-LLM, model.
 * aiConfig.identify points at it; when empty, identification falls back to the
 * main endpoint so a single-model setup still works. ------------------------- */
function identifySettings() {
  const main = aiSettings();
  const s = aiConfig?.identify || {};
  if (!s.baseUrl) return { ...main, purpose: 'identify', dedicated: false };
  return {
    // 'disabled' must survive here — identifyConfigured() keys off it
    provider: ['disabled', 'generic', 'openai'].includes(s.provider) ? s.provider : 'openai',
    baseUrl: String(s.baseUrl).trim(),
    apiKey: s.apiKey || main.apiKey || '',
    model: s.model || 'qwen2.5vl:3b',
    // local vision models on CPU/M-series Macs take tens of seconds per photo
    timeoutMs: Math.max(5000, +s.timeoutMs || 120000),
    enabled: true,
    purpose: 'identify',
    dedicated: true,
  };
}
const identifyConfigured = () => { const s = identifySettings(); return s.enabled && s.provider !== 'disabled' && !!s.baseUrl; };

const AI_CONTRACT = `You are an agricultural vision model analysing aerial/field imagery.
Return ONLY a JSON object (no prose, no markdown) with these keys:
  "class": one of ${CLASS_KEYS.join(', ')} — dominant ground cover in the analysed region.
  "confidence": 0..1
  "classes": object with a 0..1 share for EACH of ${CLASS_KEYS.join(', ')}.
  "health": 0..100 crop vigour/quality score for the crop plants.
  "weed": 0..100 weed pressure (share of vegetation that is weed).
  "soil": 0..100 soil condition/quality score.
  "ndvi": 0..1 canopy greenness if computable.
  "grid": optional rows array (rows x cols) of the same class keys, for a classified tile grid.
Be conservative: only report values you can justify from the image.`;

const IDENTIFY_CONTRACT = `You are a botanist identifying plants from field photographs.
Return ONLY a JSON object (no prose, no markdown) with these keys:
  "common": common English name of the most likely species (null when unsure)
  "scientific": scientific Latin binomial, e.g. "Poa pratensis" (null when unsure)
  "family": plant family name (null when unsure)
  "type": one of crop, grass, weed, wildflower, tree, shrub, fungus, soil, unknown
  "confidence": 0..1 how sure you are about the species
  "candidates": array of up to 5 { "common", "scientific", "confidence" } ranked best first
  "health": 0..100 overall vigour of the plant material in frame
  "condition": one of thriving, healthy, stressed, diseased, dead, unknown
  "traits": array of short observable facts (leaf shape, margin, colour, habit, flowers, texture)
  "notes": one practical sentence — management note or caveat; never assume edibility
Be conservative: when the photo lacks detail, return "type":"unknown" with low
confidence instead of guessing. Never invent a species you cannot support from the image.
Your answer is ALWAYS about the plant you can see — never about the image file
(no dimensions, format, resolution, urls or camera data). Always emit one
complete, valid JSON object closing with }.`;

function encodeDataUrl(buf, mime) { return `data:${mime || 'image/png'};base64,${Buffer.from(buf).toString('base64')}`; }

/** One HTTP call to the configured external model. Returns normalized output.
 *  mode 'identify' swaps in the species contract, uses the identify settings
 *  (separate endpoint when configured) and returns the RAW parsed JSON for
 *  normalizeIdentifyResult instead of the crop normalizer. */
async function callExternalAI({ dataUrl, task, classes, gridHint, signalNote, mode = 'crop', settings }) {
  const s = settings || aiSettings();
  if (s.purpose === 'identify' ? !identifyConfigured() : !aiConfigured()) throw new Error('AI provider not configured');
  const st = mode === 'identify' ? idState : aiState;
  const system = mode === 'identify' ? IDENTIFY_CONTRACT : AI_CONTRACT;
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), s.timeoutMs);

  const headers = { 'Content-Type': 'application/json' };
  if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;

  let url = s.baseUrl;
  let body;
  if (s.provider === 'openai') {
    if (!/\/chat\/completions$/.test(url)) url = url.replace(/\/+$/, '') + '/chat/completions';
    // moondream-style local VLMs ignore a contract in the SYSTEM role but obey
    // the same rules when they arrive inside the user turn — identify mode puts
    // the whole contract there; the crop path keeps the system contract.
    const cropText = `${task}\n${Array.isArray(classes) && classes.length ? `Classes: ${classes.join(', ')}\n` : ''}${gridHint ? `\nImage is a ${gridHint.rows} x ${gridHint.cols} tile grid; if you return "grid" it must have exactly that shape.` : ''}`.trim();
    const userText = mode === 'identify' ? `${system}\n\n${task}` : cropText;
    const content = [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: dataUrl } }];
    body = {
      model: s.model || 'gpt-4o-mini',
      temperature: 0,
      // Cap the generation: a small local VLM asked for JSON will happily
      // ramble past 1400 tokens and get killed by the timeout, losing a valid
      // answer. An identification is ~100 tokens; a tile grid needs room.
      max_tokens: mode === 'identify' ? 400 : 1600,
      response_format: { type: 'json_object' },
      messages: mode === 'identify'
        ? [{ role: 'user', content }]
        : [{ role: 'system', content: system }, { role: 'user', content }],
    };
  } else {
    body = {
      model: s.model || 'crop-vision',
      task,
      classes,
      image: dataUrl,
      prompt: system,
      response_format: { type: 'json_object' },
    };
    if (gridHint) body.grid = gridHint;
    if (signalNote) body.context = signalNote;
  }

  st.calls++;
  st.lastCallAt = nowIso();
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`AI ${res.status}: ${text.slice(0, 200)}`);
    let raw;
    try { raw = JSON.parse(text); } catch { raw = text; }
    if (raw && typeof raw === 'object' && raw.error) throw new Error(`AI error: ${raw.error.message || raw.error}`);
    const content = raw?.choices?.[0]?.message?.content ?? raw;
    const parsed = parseAIJson(content);
    if (!parsed) throw new Error('AI response was not JSON');
    st.lastLatencyMs = Date.now() - started;
    st.lastError = null;
    st.lastSource = s.provider;
    return mode === 'identify' ? parsed : normalizeAIResult(parsed);
  } catch (e) {
    // `fetch` reports almost nothing useful on its own ("fetch failed"); the
    // actionable detail (ECONNREFUSED, ETIMEDOUT, ENOTFOUND) lives in .cause.
    const detail = [e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(' - ');
    st.errors++;
    st.lastError = detail;
    st.lastLatencyMs = Date.now() - started;
    const err = new Error(detail);
    err.cause = e;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Accept fenced JSON, prose-wrapped JSON, or a bare object. */
function parseAIJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch {}
  const start = s.search(/[[{]/);
  if (start >= 0) { try { return JSON.parse(s.slice(start)); } catch {} }
  return null;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pickNum = (...vals) => { for (const v of vals) { const n = num(v); if (n != null) return n; } return null; };
const CLASS_ALIASES = {
  healthy: 'healthy', crop: 'healthy', vegetation: 'healthy', good: 'healthy', ok: 'healthy',
  stressed: 'stressed', stress: 'stressed', diseased: 'stressed', sick: 'stressed', poor: 'stressed',
  soil: 'soil', bare: 'soil', background: 'soil', earth: 'soil',
  weed: 'weed', weeds: 'weed', grass: 'weed',
};
function normalizeClassName(v) {
  if (v == null) return null;
  const k = String(v).toLowerCase().replace(/[^a-z]/g, '');
  if (CLASS_KEYS.includes(k)) return k;
  return CLASS_ALIASES[k] || null;
}

/** Map whatever the external model returned onto one predictable shape. */
function normalizeAIResult(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const dist = r.classes || r.distribution || r.probabilities || r.class_distribution || r.predictions || {};
  const shares = {};
  let distSum = 0;
  if (dist && typeof dist === 'object' && !Array.isArray(dist)) {
    for (const [k, v] of Object.entries(dist)) {
      const cls = normalizeClassName(k);
      const n = num(Array.isArray(v) ? v[1] ?? v[0] : v);
      if (cls && n != null) { shares[cls] = n; distSum += n; }
    }
  }
  // normalize percentages → 0..1 shares when they look like percentages
  if (distSum > 1.5) for (const k of Object.keys(shares)) shares[k] = shares[k] / distSum;

  const dominantFromDist = Object.entries(shares).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const classFromLabel = normalizeClassName(
    r.class ?? r.label ?? r.predicted_class ?? r.predictedClass ?? r.result ?? r.dominant_class ?? r.category
  );

  let grid = null;
  const g = r.grid ?? r.tile_grid ?? r.tiles ?? r.classification_grid ?? r.matrix;
  if (Array.isArray(g) && g.length && Array.isArray(g[0])) {
    grid = g.map((row) => row.map((v) => normalizeClassName(typeof v === 'object' ? (v.class ?? v.label) : v)));
  }

  const weed = r.weed ?? r.weeds ?? r.weed_pressure ?? r.weedCoverage ?? r.weed_coverage ?? r.weedCoveragePct;
  const soil = r.soil ?? r.soil_quality ?? r.soilQuality ?? r.soil_score ?? r.soilCondition;
  return {
    class: classFromLabel || dominantFromDist,
    confidence: clamp(pickNum(r.confidence, r.conf, r.score, r.probability, r.certainty) ?? (dominantFromDist ? shares[dominantFromDist] : null) ?? 0, 0, 1),
    shares,
    health: clamp(pickNum(r.health, r.healthScore, r.health_score, r.plantHealth, r.vigor, r.vigour, r.quality, r.crop_quality), 0, 100),
    weedPressure: clamp(pickNum(weed), 0, 100),
    soilQuality: clamp(pickNum(soil), 0, 100),
    ndvi: clamp(pickNum(r.ndvi, r.NDVI), 0, 1),
    grid,
    raw: r,
  };
}

/* ---- Species identification normalizer ------------------------------------
 * Maps whatever the vision model returned onto one predictable shape. It
 * NEVER invents a name: if the model produced nothing species-shaped the
 * caller gets null and the route fails loudly. ------------------------------ */
const ID_TYPE_SET = ['crop', 'grass', 'weed', 'wildflower', 'tree', 'shrub', 'fungus', 'soil', 'unknown'];
const ID_TYPE_ALIASES = {
  crop: 'crop', crops: 'crop', cereal: 'crop', arable: 'crop', vegetable: 'crop', forage: 'crop', pasture: 'crop', cropplant: 'crop',
  grass: 'grass', grasses: 'grass', lawn: 'grass', turf: 'grass', sedge: 'grass', graminoid: 'grass',
  weed: 'weed', weeds: 'weed', invasive: 'weed',
  wildflower: 'wildflower', wildflowers: 'wildflower', flower: 'wildflower', flowers: 'wildflower', bloom: 'wildflower',
  tree: 'tree', sapling: 'tree', shrub: 'shrub', bush: 'shrub', bushes: 'shrub', hedge: 'shrub',
  fungus: 'fungus', fungi: 'fungus', mushroom: 'fungus', mushrooms: 'fungus', lichen: 'fungus',
  soil: 'soil', dirt: 'soil', earth: 'soil', bareground: 'soil', substrate: 'soil',
  vegetation: 'unknown', plant: 'unknown', unknown: 'unknown', other: 'unknown', none: 'unknown', NA: 'unknown',
};
const ID_CONDITION_ALIASES = {
  thriving: 'thriving', vigor: 'thriving', vigorous: 'thriving', excellent: 'thriving',
  healthy: 'healthy', good: 'healthy', ok: 'healthy',
  stressed: 'stressed', stress: 'stressed', drought: 'stressed', chlorotic: 'stressed', nutrientstress: 'stressed',
  diseased: 'diseased', disease: 'diseased', infected: 'diseased', sick: 'diseased',
  dead: 'dead', dying: 'dead', deceased: 'dead',
  unknown: 'unknown', other: 'unknown', none: 'unknown', NA: 'unknown',
};
const idKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');
const idType = (v) => ID_TYPE_ALIASES[idKey(v)] || 'unknown';
const idCondition = (v) => ID_CONDITION_ALIASES[idKey(v)] || 'unknown';
/** 0..1 from either a fraction or a percentage. */
const pct01 = (v) => (v == null ? null : v > 1 ? clamp(v / 100, 0, 1) : clamp(v, 0, 1));

function normalizeIdentifyResult(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = (v) => (v == null || typeof v === 'object' ? null : String(v).trim() || null);

  // species may arrive as an object, a bare string, or an array of candidates
  let sp = r.species ?? r.plant ?? r.taxonomy ?? null;
  if (Array.isArray(sp)) sp = sp[0];
  if (typeof sp === 'string') sp = { common: sp };
  const common0 = str(sp?.common ?? sp?.common_name ?? r.common ?? r.common_name ?? r.name ?? r.label ?? (typeof r.species === 'string' ? r.species : null));
  const common = common0 && idKey(common0) !== 'unknown' ? common0 : null;
  // Scientific names are binomials ("Lolium perenne") — a single token like
  // "tree" is the model rambling, not an identification, so it is dropped.
  const sci0 = str(sp?.scientific ?? sp?.scientific_name ?? sp?.binomial ?? r.scientific ?? r.scientific_name ?? r.binomial ?? r.latin);
  const scientific = sci0 && sci0.trim().includes(' ') ? sci0 : null;
  const family = str(sp?.family ?? r.family);

  // ranked candidates: array of objects, array of strings, or {name: conf} map.
  // Nameless entries (all fields null) are dropped — a model that fills the
  // schema with nulls has NOT identified anything and must not be stored.
  const candRaw = r.candidates ?? r.predictions ?? r.top_species ?? r.results ?? r.alternatives ?? r.suggestions;
  const candidates = [];
  if (Array.isArray(candRaw)) {
    for (const c of candRaw.slice(0, 5)) {
      if (typeof c === 'string') candidates.push({ common: c, scientific: null, confidence: null });
      else if (c && typeof c === 'object') {
        const cc = str(c.common ?? c.common_name ?? c.name ?? (typeof c.species === 'string' ? c.species : null) ?? c.label);
        const cs = str(c.scientific ?? c.scientific_name ?? c.binomial ?? (typeof c.species === 'object' ? c.species?.scientific : null));
        if (cc || cs) candidates.push({ common: cc, scientific: cs && cs.includes(' ') ? cs : cs, confidence: pct01(pickNum(c.confidence, c.conf, c.score, c.probability)) });
      }
    }
  } else if (candRaw && typeof candRaw === 'object') {
    for (const [k, v] of Object.entries(candRaw).slice(0, 5))
      candidates.push({ common: k, scientific: null, confidence: pct01(num(v)) });
  }

  let confidence = pickNum(r.confidence, r.conf, r.score, r.probability, r.certainty, r.species_confidence);
  if (confidence == null) confidence = candidates.find((c) => c.confidence != null)?.confidence ?? null;
  confidence = pct01(confidence) ?? 0;

  // health arrives as 0..1 or 0..100 depending on the model
  let health = pickNum(r.health, r.health_score, r.healthScore, r.plantHealth, r.quality, r.vigor, r.vigour);
  if (health != null && health <= 1) health *= 100;
  health = health == null ? null : clamp(health, 0, 100);

  const tr = r.traits ?? r.features ?? r.observations ?? r.characteristics;
  let traits = [];
  if (Array.isArray(tr)) {
    traits = tr
      .map((t) => (typeof t === 'string' ? t : typeof t?.label === 'string' ? t.label : t?.name ? `${t.name}${t.detail ? `: ${t.detail}` : ''}` : null))
      .filter(Boolean).slice(0, 8);
  } else if (typeof tr === 'string') {
    traits = tr.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  }
  const notes = str(r.notes ?? r.note ?? r.remarks ?? r.comment ?? r.description)?.slice(0, 400) || null;

  // Nothing species-shaped came back — the route turns this into a 502 rather
  // than fabricating an answer.
  if (!common && !scientific && !candidates.length) return null;

  const best = candidates[0] || null;
  return {
    common: common || best?.common || null,
    scientific: scientific || best?.scientific || null,
    family,
    type: idType(r.type ?? r.category ?? r.kind ?? r.plant_type ?? r.ground_cover),
    confidence: +confidence.toFixed(3),
    candidates,
    health: health == null ? null : +health.toFixed(1),
    condition: idCondition(r.condition ?? r.state ?? r.vigour ?? r.status),
    traits,
    notes,
    raw: r,
  };
}

/* ---------------------------- Agronomy engine ---------------------------- */
/** Real ground geometry: metres per tile and field area from the georeference. */
function fieldGeometry(f) {
  const widthM = f.groundWidthM || CONFIG.fieldSizeHintM;
  const heightM = widthM * ((f.height || 1) / (f.width || 1));
  const cols = f.grid?.cols || 1, rows = f.grid?.rows || 1;
  const tileW = widthM / cols, tileH = heightM / rows;
  return {
    widthM, heightM, cols, rows, tileW, tileH,
    tileAreaM2: tileW * tileH,
    fieldAreaM2: widthM * heightM,
    source: f.groundWidthM ? 'field-width' : 'default-hint',
  };
}
const M2_PER_HA = 10000, M2_PER_ACRE = 4046.8564224;
const round = (v, d = 1) => (v == null ? null : +Number(v).toFixed(d));

/** Soil quality index (0-100) built ONLY from measured inputs. */
function assessSoilQuality(field) {
  const f = fieldSummary(field);
  const rec = getSensor(field.fieldId);
  const dev = mergedDeviceReading(rec);
  const wx = rec.weather;
  const parts = [];
  const sources = [];
  let used = 0, total = 0;

  const moisture = dev?.soilMoisture ?? wx?.soilMoisturePct ?? null;
  const moistureFromProbe = !!(dev && dev.sources && dev.sources.soilMoisture);
  if (moisture != null) {
    // most crops are comfortable between 25-45% VWC; score falls off outside
    const score = moisture >= 25 && moisture <= 45 ? 100 : moisture < 25 ? clamp(100 - (25 - moisture) * 4.5, 0, 100) : clamp(100 - (moisture - 45) * 2.2, 0, 100);
    parts.push({ input: 'Soil moisture', value: `${moisture}%`, score: round(score), source: moistureFromProbe ? `device ${dev.sources.soilMoisture}` : 'open-meteo' });
    total += score; used++;
    sources.push(moistureFromProbe ? 'device-sensor' : 'weather-api');
  }
  const ph = dev?.ph ?? null;
  if (ph != null) {
    const score = ph >= 6.0 && ph <= 7.5 ? 100 : ph < 6.0 ? clamp(100 - (6.0 - ph) * 22, 0, 100) : clamp(100 - (ph - 7.5) * 22, 0, 100);
    parts.push({ input: 'Soil pH', value: ph.toFixed(2), score: round(score), source: `device ${dev.sources.ph}` });
    total += score; used++;
    sources.push('device-sensor');
  }
  const ec = dev?.ec ?? null;
  if (ec != null) {
    const score = ec <= 1.2 ? 100 : clamp(100 - (ec - 1.2) * 30, 0, 100);
    parts.push({ input: 'Soil EC', value: `${ec} mS/cm`, score: round(score), source: `device ${dev.sources.ec}` });
    total += score; used++;
    sources.push('device-sensor');
  }
  const rain = wx?.precipitationMm ?? dev?.rainMm ?? null;
  const et0 = wx?.et0MmDay ?? null;
  if (rain != null || et0 != null) {
    const balance = rain != null && et0 != null ? clamp(100 - ((et0 - rain) * 8), 0, 100) : 70;
    parts.push({ input: 'Water balance (ET0 vs rain)', value: `${et0 ?? '—'} / ${rain ?? '—'} mm`, score: round(balance), source: 'open-meteo' });
    total += balance; used++;
    sources.push('weather-api');
  }
  const bareSoilPct = f.statsPct?.soil ?? 0;
  parts.push({ input: 'Bare soil exposure', value: `${bareSoilPct}% of field`, score: round(clamp(100 - bareSoilPct * 1.6, 0, 100)), source: 'classification' });

  const gradeOf = (v) => (v >= 85 ? 'Good' : v >= 70 ? 'Fair' : v >= 50 ? 'Poor' : 'Critical');
  if (!used) {
    return {
      score: null, grade: 'Insufficient data', inputs: parts, dataSources: ['classification'],
      insufficient: true,
      note: 'No soil sensor or weather data connected. Add a device reading (POST /api/fields/:id/ingest) or georeference the field for satellite soil moisture.',
    };
  }
  const exposure = clamp(100 - bareSoilPct * 1.6, 0, 100);
  const score = round((total / used) * 0.75 + exposure * 0.25);
  return { score, grade: gradeOf(score), inputs: parts, dataSources: [...new Set(sources)], insufficient: false };
}

/**
 * Build the full field report: per-class ground area, canopy cover, plant
 * health/quality, weed area and soil quality — from real tile geometry,
 * real device/weather inputs and (optionally) the external AI model.
 */
function buildFieldReport(field, { ai, source, mode }) {
  const f = fieldSummary(field);
  const geo = fieldGeometry(field);
  const counts = { healthy: 0, stressed: 0, soil: 0, weed: 0 };
  let labelled = 0;
  for (const t of field.tiles || []) {
    const cls = t.manualClass || t.predictedClass;
    if (cls && counts[cls] != null) { counts[cls]++; if (t.manualClass) labelled++; }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return null;

  const areas = {};
  for (const k of CLASS_KEYS) {
    const m2 = counts[k] * geo.tileAreaM2;
    areas[k] = {
      label: CLASSES[k].label,
      tiles: counts[k],
      pct: round((counts[k] / total) * 100, 2),
      m2: round(m2, 1),
      ha: round(m2 / M2_PER_HA, 4),
      acres: round(m2 / M2_PER_ACRE, 4),
    };
  }
  const canopyPct = round(((counts.healthy + counts.stressed) / total) * 100, 2);
  const weedAreaM2 = areas.weed.m2;
  const plantAreaM2 = round(areas.healthy.m2 + areas.stressed.m2, 1);

  // Plant health / quality: classification mix + optional AI health score.
  const fromMix = clamp(100 - areas.stressed.pct * 0.75 - areas.weed.pct * 0.35 - areas.soil.pct * 0.15, 0, 100);
  const aiHealth = ai?.health ?? null;
  const conf = ai?.confidence ?? null;
  const healthScore = round(aiHealth != null && conf != null ? (aiHealth * clamp(conf, 0.1, 1)) + fromMix * (1 - clamp(conf, 0.1, 1)) : fromMix, 1);
  const healthGrade = healthScore >= 85 ? 'Excellent' : healthScore >= 70 ? 'Good' : healthScore >= 55 ? 'Fair' : healthScore >= 40 ? 'Poor' : 'Critical';

  const soil = assessSoilQuality(field);
  const alerts = [];
  if (areas.weed.pct > 8) alerts.push({ level: 'warning', text: `Weed area ${areas.weed.pct}% (${areas.weed.m2} m²) — scout and consider spot spraying` });
  if (areas.stressed.pct > 18) alerts.push({ level: 'warning', text: `Stressed crop ${areas.stressed.pct}% (${areas.stressed.m2} m²) — check irrigation uniformity and leaf health` });
  if (areas.soil.pct > 12) alerts.push({ level: 'info', text: `Bare soil ${areas.soil.pct}% (${areas.soil.m2} m²) — possible germination gaps` });
  if (healthScore < 55) alerts.push({ level: 'critical', text: `Plant health ${healthScore}/100 — investigate stress drivers` });
  if (soil.score != null && soil.score < 55) alerts.push({ level: 'warning', text: `Soil quality ${soil.score}/100 — review pH/EC/moisture` });
  if (canopyPct < 40) alerts.push({ level: 'warning', text: `Low canopy cover ${canopyPct}% — check stand establishment` });

  const recommendations = [];
  if (areas.weed.pct > 8) recommendations.push('Scout weed hotspots and spot-treat only affected tiles.');
  if (areas.stressed.pct > 18) recommendations.push('Walk the stressed zones; cross-check leaf condition with the AI tile classifier.');
  if (soil.score != null && soil.score < 70) recommendations.push('Soil is below fair condition — verify probe placement and calibrate pH/EC.');
  if (canopyPct >= 70 && healthScore >= 70) recommendations.push('Canopy is uniform and vigorous — hold current management.');

  return {
    fieldId: field.fieldId,
    generatedAt: nowIso(),
    source,                                   // 'external-ai' | 'local-model' | 'ground-truth'
    mode: mode || 'local',
    labels: { manualTiles: labelled, predictedTiles: total - labelled },
    geometry: {
      groundWidthM: round(geo.widthM, 2),
      groundHeightM: round(geo.heightM, 2),
      grid: `${geo.rows}×${geo.cols}`,
      tileSizeM: `${round(geo.tileW, 2)}×${round(geo.tileH, 2)}`,
      tileAreaM2: round(geo.tileAreaM2, 2),
      fieldAreaM2: round(geo.fieldAreaM2, 1),
      fieldAreaHa: round(geo.fieldAreaM2 / M2_PER_HA, 4),
      fieldAreaAcres: round(geo.fieldAreaM2 / M2_PER_ACRE, 4),
      widthSource: geo.source,
      georeferenced: field.gps?.lat != null,
    },
    classes: areas,
    plant: {
      canopyCoverPct: canopyPct,
      plantAreaM2: plantAreaM2,
      plantAreaHa: round(plantAreaM2 / M2_PER_HA, 4),
      healthyAreaM2: areas.healthy.m2,
      stressedAreaM2: areas.stressed.m2,
      healthScore, healthGrade,
      aiHealth: round(aiHealth, 1),
      aiConfidence: round(conf, 3),
      ndvi: ai?.ndvi ?? null,
    },
    weed: {
      areaM2: weedAreaM2,
      areaHa: round(weedAreaM2 / M2_PER_HA, 4),
      pct: areas.weed.pct,
      pressure: ai?.weedPressure ?? null,
      level: areas.weed.pct > 15 ? 'high' : areas.weed.pct > 8 ? 'medium' : 'low',
    },
    soil,
    alerts,
    recommendations,
  };
}

/**
 * Apply an AI-returned per-tile classification grid to a field. Manual labels
 * always win, then recomputes stats and re-renders the overlay.
 * @returns {boolean} true when at least one tile was re-classified.
 */
function applyAiGrid(field, grid, confidence) {
  if (!Array.isArray(grid) || !grid.length) return false;
  const counts = { healthy: 0, stressed: 0, soil: 0, weed: 0 };
  let changed = 0;
  for (const t of field.tiles || []) {
    if (!t.manualClass) {
      const cls = grid[t.r]?.[t.c];
      if (cls && CLASSES[cls]) { t.predictedClass = cls; t.confidence = confidence || 0; changed++; }
    }
    const cls = t.manualClass || t.predictedClass;
    if (cls && counts[cls] != null) counts[cls]++;
  }
  if (changed) {
    field.stats = counts;
    field.classifiedBy = 'external-ai';
    writeOverlay(field);
  }
  return changed > 0;
}

/** Class counts from the local model / manual labels (no external AI). */
function localClassCounts(field) {
  const counts = { healthy: 0, stressed: 0, soil: 0, weed: 0 };
  for (const t of field.tiles || []) {
    const cls = t.manualClass || t.predictedClass;
    if (cls && counts[cls] != null) counts[cls]++;
  }
  return counts;
}

function publicAiStatus() {
  const s = aiSettings();
  const i = identifySettings();
  return {
    configured: aiConfigured(),
    provider: s.provider,
    baseUrl: s.baseUrl || null,
    model: s.model || null,
    apiKeyMasked: maskKey(s.apiKey),
    hasApiKey: !!s.apiKey,
    timeoutMs: s.timeoutMs,
    enabled: s.enabled,
    runtime: { ...aiState },
    identify: {
      configured: identifyConfigured(),
      provider: i.provider,
      baseUrl: i.baseUrl || null,
      model: i.model || null,
      timeoutMs: i.timeoutMs,
      dedicated: i.dedicated,          // false -> reuses the main endpoint
      runtime: { ...idState },
      stored: identifications.length,
    },
    fallback: 'Local kNN model (trained on your labeled tiles) is used whenever the external AI is not configured or fails.',
    envVars: ['AI_PROVIDER', 'AI_API_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_TIMEOUT_MS'],
  };
}

/* ------------------------------- SSE live feed ------------------------------ */
const sseClients = new Set();
function sseSend(type, payload) {
  const msg = `data: ${JSON.stringify({ type, payload, time: nowIso() })}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch { sseClients.delete(res); } }
}

/* ------------------------------- GeoJSON export ----------------------------- */
function fieldGeoJSON(field, opts = {}) {
  const g = field.gps || {};
  if (g.lat == null || g.lon == null) return null;
  const widthM = field.groundWidthM || CONFIG.fieldSizeHintM;
  const heightM = widthM * (field.height / field.width);
  const ring = footprintRing(g.lat, g.lon, widthM, heightM);
  const features = [];
  features.push({
    type: 'Feature',
    properties: {
      kind: 'field-boundary',
      fieldId: field.fieldId,
      name: field.imageName,
      status: field.status,
      source: g.source,
      groundWidthM: widthM,
    },
    geometry: { type: 'Polygon', coordinates: [ring] },
  });
  if (opts.tiles !== false && field.tiles && field.stats) {
    const cols = field.grid.cols, rows = field.grid.rows;
    const dx = widthM / cols, dy = heightM / rows;
    for (const t of field.tiles) {
      if (!t.predictedClass) continue;
      const lon0 = g.lon + ((t.c - cols / 2) * dx) / metersPerDegLon(g.lat);
      const lon1 = g.lon + ((t.c + 1 - cols / 2) * dx) / metersPerDegLon(g.lat);
      const lat1 = g.lat + ((rows / 2 - t.r) * dy) / metersPerDegLat();
      const lat0 = g.lat + ((rows / 2 - t.r - 1) * dy) / metersPerDegLat();
      features.push({
        type: 'Feature',
        properties: {
          kind: 'tile',
          fieldId: field.fieldId,
          class: t.predictedClass,
          confidence: t.confidence,
          r: t.r, c: t.c,
        },
        geometry: { type: 'Polygon', coordinates: [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/* ----------------------------- Tile infrastructure -------------------------- */
function makeTiles(field) {
  const cols = Math.floor(field.width / CONFIG.tileSize);
  const rows = Math.floor(field.height / CONFIG.tileSize);
  field.tileSize = CONFIG.tileSize;
  field.grid = { rows, cols };
  field.tiles = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    field.tiles.push({ r, c, x: c * CONFIG.tileSize, y: r * CONFIG.tileSize, predictedClass: null, confidence: 0 });
}

function writeTiles(field) {
  const { width: W, tileSize: T } = field;
  const dir = path.join(UPLOAD_DIR, `${field.fieldId}-tiles`);
  fs.mkdirSync(dir, { recursive: true });
  for (const t of field.tiles) {
    const tile = rgbaSlice(field.imageData, W, t.x, t.y, T, T);
    fs.writeFileSync(path.join(dir, `tile-${t.r}-${t.c}.png`), encodePng(T, T, tile));
  }
  field.tilesPath = `data/uploads/${field.fieldId}-tiles`;
}

function buildOverlay(field) {
  const W = field.width, H = field.height, T = field.tileSize;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const src = field.imageData;
  if (!src) return null;
  for (let i = 0; i < W * H * 4; i += 4) {
    rgba[i] = src[i] * 0.45; rgba[i + 1] = src[i + 1] * 0.45; rgba[i + 2] = src[i + 2] * 0.45; rgba[i + 3] = 255;
  }
  for (const t of field.tiles || []) {
    const cls = t.predictedClass;
    if (!cls || !CLASSES[cls]) continue;
    const [cr, cg, cb] = CLASSES[cls].color;
    const alpha = 0.30 + 0.35 * (t.confidence || 0.5);
    for (let y = t.y; y < t.y + T; y++) for (let x = t.x; x < t.x + T; x++) {
      const o = (y * W + x) * 4;
      rgba[o] = clamp(rgba[o] * (1 - alpha) + cr * alpha, 0, 255);
      rgba[o + 1] = clamp(rgba[o + 1] * (1 - alpha) + cg * alpha, 0, 255);
      rgba[o + 2] = clamp(rgba[o + 2] * (1 - alpha) + cb * alpha, 0, 255);
    }
    for (let x = t.x; x < t.x + T; x++) for (const y of [t.y, t.y + T - 1]) {
      if (y < 0 || y >= H) continue;
      const o = (y * W + x) * 4;
      rgba[o] = cr; rgba[o + 1] = cg; rgba[o + 2] = cb;
    }
    for (let y = t.y; y < t.y + T; y++) for (const x of [t.x, t.x + T - 1]) {
      if (x < 0 || x >= W) continue;
      const o = (y * W + x) * 4;
      rgba[o] = cr; rgba[o + 1] = cg; rgba[o + 2] = cb;
    }
  }
  return rgba;
}
function writeOverlay(field) {
  const rgba = buildOverlay(field);
  if (!rgba) return;
  fs.writeFileSync(path.join(UPLOAD_DIR, `${field.fieldId}-overlay.png`), encodePng(field.width, field.height, rgba));
  field.overlayPath = `data/uploads/${field.fieldId}-overlay.png`;
  field.overlayVersion = (field.overlayVersion || 0) + 1;
}

function hydrateFields() {
  // Boot sanitizer: this build accepts REAL imagery only. Legacy synthetic
  // artifacts are removed from the store and from disk.
  let purged = 0;
  let migrated = 0;
  for (const [id, f] of Object.entries(fields)) {
    const legacy = f.isDemo || f.groundTruth || (f.imagePath || '').includes('data/samples/');
    if (legacy || !ensureImageData(f)) {
      if (legacy) purged++;
      else console.warn(`[boot] dropping field ${id} — image file missing`);
      delete fields[id];
      delete sensors[id];
      try { fs.rmSync(path.join(UPLOAD_DIR, `${id}-tiles`), { recursive: true, force: true }); } catch {}
      try { fs.rmSync(path.join(UPLOAD_DIR, `${id}-overlay.png`), { force: true }); } catch {}
      continue;
    }
    delete f.groundTruth;
    delete f.isDemo;
    if (!f.ingestToken) f.ingestToken = crypto.randomBytes(8).toString('hex');
    // Migrate any legacy sensor record onto the current schema. Flat legacy
    // fields came from the old simulator and are dropped, never promoted to
    // "real" device readings.
    const rec = sensors[id];
    if (!rec || !Array.isArray(rec.device)) {
      sensors[id] = rec
        ? { fieldId: id, weather: rec.weather || null, weatherError: rec.weatherError || null, device: [], devices: rec.devices || {}, updatedAt: rec.updatedAt || nowIso() }
        : newSensorRecord(id);
      migrated++;
    }
    ensureDevices(sensors[id]);
  }
  try { fs.rmSync(SAMPLE_DIR, { recursive: true, force: true }); } catch {}
  if (purged) console.log(`[boot] purged ${purged} legacy synthetic field(s) — real imagery only`);
  if (migrated) console.log(`[boot] migrated ${migrated} legacy sensor record(s) onto the device-ingest schema`);
}

/** Keep only training data traceable to surviving (real) fields. */
function sanitizeTrainingStore() {
  const ds = loadJSON('dataset.json', { samples: [] });
  const before = ds.samples.length;
  ds.samples = ds.samples.filter((s) => s.fieldId && fields[s.fieldId]);
  if (ds.samples.length !== before) {
    saveJSON('dataset.json', ds);
    console.log(`[boot] dataset: removed ${before - ds.samples.length} sample(s) from purged fields`);
  }
  for (const [id, m] of Object.entries(models)) {
    const orphaned = m.data?.some((s) => !s.fieldId || !fields[s.fieldId]);
    if (orphaned) {
      delete models[id];
      console.log(`[boot] dropped model ${id} — trained on purged data`);
    }
  }
  for (const rec of Object.values(sensors)) delete rec.demo; // strip any legacy simulator state
}

/* ═══════════════════════════ SECURITY ════════════════════════════════════
 * Everything the console ships in front of its own routes: hardening headers
 * with a Content-Security-Policy matched to the real asset graph, a per-client
 * token-bucket rate limiter, strict id/slug validation, prototype-pollution
 * rejection and timing-safe device-token comparison.
 * ═══════════════════════════════════════════════════════════════════════════= */

/**
 * The single framing origin the console allows. Held as its own constant and
 * interpolated into the policy below, so the suite can assert the Windy map is
 * actually permitted instead of trusting a comment.
 */
const CSP_FRAME_SRC = "frame-src https://embed.windy.com https://www.windy.com";

/** Origins the console legitimately loads from. Anything else is blocked. */
/**
 * Every directive except `upgrade-insecure-requests`, which is only correct on a
 * TLS-served page - see cspFor() below for why that one is decided per request.
 */
const CSP_BASE = [
  "default-src 'self'",
  // Leaflet is vendored into this app, so no third-party script origin is
  // allowed at all - a map that needs a CDN cannot work on a restricted
  // field network.
  "script-src 'self'",
  // app.js renders inline style attributes for data-driven colours/widths.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  // Basemap tile hosts: Esri, Google, and every OpenStreetMap style the
  // console offers (street, humanitarian, terrain). A basemap swap that
  // forgets one of these fails visibly instead of silently.
  "img-src 'self' data: blob: https://server.arcgisonline.com https://mt1.google.com https://mt2.google.com https://mt3.google.com https://tile.openstreetmap.org https://tile.openstreetmap.fr https://a.tile.opentopomap.org",
  "connect-src 'self'",
  // The Windy forecast map is Windy's own embed widget: exactly one framing
  // origin, and no script, style or font from it - it stays a sandboxed frame.
  CSP_FRAME_SRC,
  "worker-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** The policy a TLS-served deployment gets, and the one /api/security reports. */
const CSP = `${CSP_BASE}; upgrade-insecure-requests`;

/** Is this request - or the proxy in front of it - actually on TLS? */
function servedOverTls(req) {
  return !!req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
}

/**
 * `upgrade-insecure-requests` is only correct on a TLS-served page: it makes the
 * browser fetch that page's own subresources over https. On a plain-http origin
 * - which is how this console is run on a field LAN - there is no TLS to upgrade
 * to, so Chrome rewrites ./app.js and ./styles.css to https:// and they die with
 * ERR_SSL_PROTOCOL_ERROR: a blank page, no style, no script, and nothing on
 * screen to say why. Measured on http://<lan-ip>:5177, which is also the case
 * geolocation cannot work in (no secure context), so that page must still load
 * and say so rather than not render at all. Same rule HSTS already follows.
 */
function cspFor(req) {
  return servedOverTls(req) ? CSP : CSP_BASE;
}

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': cspFor(req),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-DNS-Prefetch-Control': 'off',
    'X-XSS-Protection': '0', // modern engines: CSP replaces the legacy auditor
  });
  // Only meaningful over TLS, and only asserted when actually deployed on it.
  if (servedOverTls(req)) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/**
 * Fixed-window token bucket per client. `cost` lets an expensive route burn
 * more than one token, so a single client cannot hammer inference or ingest.
 */
const buckets = new Map();
const BUCKET_SWEEP_MS = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if (now - b.reset > BUCKET_SWEEP_MS) buckets.delete(key);
}, BUCKET_SWEEP_MS).unref?.();

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimit({ name, limit, windowMs, cost = 1 }) {
  return (req, res, next) => {
    const key = `${name}:${clientKey(req)}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.reset >= windowMs) { b = { count: 0, reset: now }; buckets.set(key, b); }
    b.count += cost;
    const remaining = Math.max(0, limit - b.count);
    res.set('RateLimit-Limit', String(limit));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(Math.ceil((b.reset + windowMs - now) / 1000)));
    if (b.count > limit) {
      const retry = Math.ceil((b.reset + windowMs - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({
        error: 'TooManyRequests',
        detail: `Rate limit exceeded for ${name} — retry in ${retry}s.`,
        retryAfter: retry,
      });
    }
    return next();
  };
}

/**
 * Budgets, in requests per minute, for the routes whose work is worth
 * protecting: file writes, training, inference and outbound model calls.
 * Exposed through GET /api/security so the console can show them.
 */
const RATE_LIMIT_BUDGETS = new Map([
  ['global', { limit: 600, windowMs: 60_000 }],
  ['upload', { limit: 20, windowMs: 60_000 }],
  ['ingest', { limit: 240, windowMs: 60_000 }],
  ['train', { limit: 12, windowMs: 60_000 }],
  ['predict', { limit: 60, windowMs: 60_000 }],
  ['ai', { limit: 30, windowMs: 60_000 }],
  ['export', { limit: 60, windowMs: 60_000 }],
  // A device reporting its own position: generous enough for a watching GPS
  // stream, bounded so a looping client cannot use it as a disk-write amplifier.
  ['location', { limit: 120, windowMs: 60_000 }],
]);

/** Hard ceiling on concurrent Server-Sent Events listeners. */
const SSE_CLIENT_CAP = 64;

/** Reject keys that could poison the prototype chain of a parsed body. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function assertCleanBody(req, res, next) {
  const body = req.body;
  if (body && typeof body === 'object') {
    const seen = new Set();
    const walk = (v) => {
      if (!v || typeof v !== 'object' || seen.has(v)) return true;
      seen.add(v);
      for (const k of Object.keys(v)) {
        if (FORBIDDEN_KEYS.has(k)) return false;
        if (!walk(v[k])) return false;
      }
      return true;
    };
    if (!walk(body)) {
      return res.status(400).json({ error: 'BadRequest', detail: 'Request body contains a forbidden key.' });
    }
  }
  return next();
}

/**
 * A filesystem-safe identifier. Field ids arrive from clients and are later
 * joined into paths, so they are constrained to a strict slug instead of being
 * trusted — this closes the traversal that a `../` in a fieldId would open.
 */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
function safeId(value) {
  const s = String(value ?? '').trim();
  if (!ID_RE.test(s) || s === '.' || s === '..' || s.includes('..')) return null;
  return s;
}

/** Constant-time string compare that never throws on length mismatch. */
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const A = Buffer.from(a, 'utf8');
  const B = Buffer.from(b, 'utf8');
  if (A.length !== B.length) {
    // Still burn a comparison so timing does not leak the length relationship.
    crypto.timingSafeEqual(B, B);
    return false;
  }
  return crypto.timingSafeEqual(A, B);
}

/* --------------------------------- Express --------------------------------- */
const app = express();
app.disable('x-powered-by');
app.set('etag', 'strong');
// Behind Vercel/nginx the real client IP arrives in X-Forwarded-For; without
// this every request would share one rate-limit bucket.
app.set('trust proxy', 1);

app.use(securityHeaders);
app.use(express.json({
  limit: '2mb',
  strict: true,
  // A JSON payload that is not an object or array is rejected outright.
  verify: (req, _res, buf) => { req.rawBodyLength = buf.length; },
}));
app.use(assertCleanBody);

// Global ceiling, then per-route budgets applied where the work is expensive.
app.use(rateLimit({ name: 'global', limit: 600, windowMs: 60_000 }));
const limitHeavy = (name, limit) => rateLimit({ name, limit, windowMs: 60_000 });

app.use((req, _res, next) => { console.log(`[api] ${req.method} ${req.url}`); next(); });

// Static assets.
//
// Cache policy is chosen by mutability, not convenience:
//   · HTML/JS/CSS/manifest carry no content hash in their filename, so they are
//     `no-cache` — stored, but always revalidated against the ETag. Caching
//     them for an hour would keep a redeploy invisible for an hour.
//   · icons and fonts are content-stable and safe to pin for a week.
//   · the service worker is never cached at all.
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    res.set('X-Content-Type-Options', 'nosniff');
    if (filePath.endsWith('sw.js')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Service-Worker-Allowed', '/');
      return;
    }
    if (filePath.endsWith('.webmanifest')) {
      res.set('Content-Type', 'application/manifest+json; charset=utf-8');
      res.set('Cache-Control', 'no-cache');
      return;
    }
    if (/\.(png|svg|ico|woff2?)$/.test(filePath)) {
      res.set('Cache-Control', 'public, max-age=604800, immutable');
      return;
    }
    res.set('Cache-Control', 'no-cache');
  },
}));
app.use('/data/uploads', express.static(UPLOAD_DIR, { index: false, dotfiles: 'deny' }));
app.use('/data/samples', express.static(SAMPLE_DIR, { index: false, dotfiles: 'deny' }));

// A malformed JSON body must produce a clean 400, not an HTML stack trace.
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'BadRequest', detail: 'Malformed JSON body.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PayloadTooLarge', detail: 'Request body exceeds the 2 MB limit.' });
  }
  return next(err);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, `field-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  limits: { fileSize: 40 * 1024 * 1024 },
});

function getOr404(req, res) {
  const f = fields[req.params.fieldId];
  if (!f) { res.status(404).json({ error: 'Field not found' }); return null; }
  return f;
}

/* --------------------------------- Routes ---------------------------------- */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'vibes-lite-crop-ai', edition: 'production', opencv: CV_MODE, time: nowIso() });
});

/**
 * Live security posture. This is documentation the console can render and a
 * test can assert against — it reports the controls that are actually wired
 * into this process, not an aspirational list.
 */
app.get('/api/security', (_req, res) => {
  res.json({
    headers: [
      'Content-Security-Policy', 'X-Content-Type-Options', 'X-Frame-Options',
      'Referrer-Policy', 'Permissions-Policy', 'Cross-Origin-Opener-Policy',
      'Cross-Origin-Resource-Policy', 'Strict-Transport-Security (over TLS)',
    ],
    policy: {
      scriptSrc: ["'self'"],
      thirdPartyScripts: 'none — Leaflet is vendored in vendor/leaflet',
      frameAncestors: 'none',
      objectSrc: 'none',
      upgradeInsecureRequests: 'sent only when the request is on TLS (or behind an https proxy) — directing a plain-http origin to upgrade its own scripts to https breaks the console instead of protecting it',
    },
    rateLimits: Object.fromEntries([...RATE_LIMIT_BUDGETS].map(([k, v]) => [k, `${v.limit}/${v.windowMs / 1000}s`])),
    bodyLimit: '2mb',
    deviceAuth: 'X-Sensor-Token, compared with crypto.timingSafeEqual',
    idValidation: String(ID_RE),
    prototypePollutionGuard: true,
    uploadLimitMb: 40,
    sseClientCap: SSE_CLIENT_CAP,
    note: 'The console itself has no user accounts. Put TLS and an authenticating reverse proxy in front of it before exposing it to the internet.',
  });
});

/* ---- OpenStreetMap: search, reverse geocoding, real map features -----------
 * Everything goes through this server, so the browser's connect-src stays
 * 'self' and the Nominatim per-second policy is enforced in one place.
 * ------------------------------------------------------------------------- */
app.get('/api/geo/status', (_req, res) => res.json(osmStatus()));

app.get('/api/geo/search', async (req, res) => {
  try {
    res.json(await osmSearch(req.query.q, { limit: +req.query.limit || undefined, country: req.query.country }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.status === 400 ? 'BadRequest' : 'UpstreamUnavailable', detail: e.message });
  }
});

app.get('/api/geo/reverse', async (req, res) => {
  try {
    res.json(await osmReverse(req.query.lat, req.query.lon, +req.query.zoom || 18));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.status === 400 ? 'BadRequest' : 'UpstreamUnavailable', detail: e.message });
  }
});

app.get('/api/geo/features', async (req, res) => {
  try {
    res.json(await osmFeatures(req.query.lat, req.query.lon, {
      radiusM: +req.query.radius_m || undefined,
      kinds: req.query.kinds,
      limit: +req.query.limit || undefined,
    }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.status === 400 ? 'BadRequest' : 'UpstreamUnavailable', detail: e.message });
  }
});

app.get('/api/cv-status', (_req, res) => {
  res.json({
    opencv: CV_MODE === 'wasm', mode: CV_MODE,
    ops: CV_MODE === 'wasm' ? ['cvtColor', 'GaussianBlur', 'Canny', 'morphologyEx', 'resize'] : ['js-grayscale', 'js-box-blur', 'js-sobel'],
  });
});

app.get('/api/events', (req, res) => {
  // Refuse rather than quietly accumulate: an unbounded SSE fan-out is a
  // trivially triggered resource leak.
  if (sseClients.size >= SSE_CLIENT_CAP) {
    return res.status(503).json({ error: 'ServiceUnavailable', detail: `Event stream is at capacity (${SSE_CLIENT_CAP} listeners). Retry shortly.` });
  }
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', payload: farmState(), time: nowIso() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function farmState() {
  return {
    fields: Object.values(fields).map(fieldSummary),
    // The whole farm picture includes where the console itself is, so a second
    // tab - or a second operator on the LAN - sees the same fix immediately.
    location: locationPublic(),
    system: {
      opencv: CV_MODE === 'wasm', cvMode: CV_MODE,
      trained: Object.keys(models).length > 0,
      models: Object.keys(models).length,
      fieldsAnalyzed: Object.values(fields).filter(f => f.status === 'analyzed').length,
      georeferenced: Object.values(fields).filter(f => f.gps?.lat != null).length,
      time: nowIso(),
    },
  };
}

/* ---- Stage 1: ingest imagery (camera/drone) with EXIF georeferencing ------ */
app.post('/api/upload', limitHeavy('upload', 20), upload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded (field name: "image")' });
    const buf = fs.readFileSync(req.file.path);
    const img = decodeImage(buf, req.file.originalname);
    if (!img) return res.status(400).json({ error: 'Unsupported file. Use PNG or JPG.' });
    if (Math.floor(img.width / CONFIG.tileSize) < 2 || Math.floor(img.height / CONFIG.tileSize) < 2)
      return res.status(400).json({ error: `Image too small — need ≥${CONFIG.tileSize * 2}px square, got ${img.width}×${img.height}.` });

    const requestedId = req.body?.fieldId ? safeId(req.body.fieldId) : null;
    if (req.body?.fieldId && !requestedId) {
      return res.status(400).json({ error: 'BadRequest', detail: 'fieldId must be 1-64 characters of A-Z a-z 0-9 . _ - with no path segments.' });
    }
    const fieldId = requestedId || `F-${Date.now().toString(36)}`;
    const exif = extractGeo(buf);
    let lat = exif.lat, lon = exif.lon, geoSource = exif.source || 'none';
    if ((lat == null || lon == null) && req.body?.lat && req.body?.lon) {
      lat = +req.body.lat; lon = +req.body.lon; geoSource = 'manual';
    }
    const groundWidthM = +req.body?.fieldWidthMeters > 0 ? +req.body.fieldWidthMeters : CONFIG.fieldSizeHintM;

    fields[fieldId] = {
      fieldId,
      imageName: req.file.originalname,
      imagePath: `data/uploads/${req.file.filename}`,
      imageData: img.rgba,
      width: img.width, height: img.height,
      status: 'uploaded',
      uploadedAt: nowIso(),
      gps: { lat, lon, altitude: exif.altitude, source: geoSource, capturedAt: exif.capturedAt, camera: [exif.cameraMake, exif.cameraModel].filter(Boolean).join(' ') || null },
      geo: geoSource === 'exif' ? { lat, lon } : (lat != null ? { lat, lon } : null),
      groundWidthM,
      ingestToken: crypto.randomBytes(8).toString('hex'),
    };
    makeTiles(fields[fieldId]);
    getSensor(fieldId);
    writeTiles(fields[fieldId]);
    persistAll();
    refreshWeatherAll().catch(() => {});
    sseSend('field-uploaded', fieldSummary(fields[fieldId]));
    res.json({ ok: true, field: fieldSummary(fields[fieldId]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/** Geotag an existing field manually (when the camera had no GPS). */
app.post('/api/fields/:fieldId/geotag', (req, res) => {
  const f = getOr404(req, res); if (!f) return;
  const { lat, lon, groundWidthM } = req.body || {};
  if (!Number.isFinite(+lat) || !Number.isFinite(+lon) || +lat < -90 || +lat > 90 || +lon < -180 || +lon > 180)
    return res.status(400).json({ error: 'Valid lat and lon required' });
  f.gps = { lat: +lat, lon: +lon, altitude: f.gps?.altitude ?? null, source: f.gps?.source === 'exif' ? 'exif' : 'manual', capturedAt: f.gps?.capturedAt ?? null, camera: f.gps?.camera ?? null };
  f.geo = { lat: +lat, lon: +lon };
  if (+groundWidthM > 0) f.groundWidthM = +groundWidthM;
  persistAll();
  refreshWeatherAll().catch(() => {});
  sseSend('field-updated', fieldSummary(f));
  res.json({ ok: true, field: fieldSummary(f) });
});

/* ---- (removed: synthetic field generation — this build ingests REAL imagery only) ---- */

/* ---- Stage 2: tiles -------------------------------------------------------- */
app.get('/api/fields/:fieldId/tiles/:r/:c.png', (req, res) => {
  const fieldId = safeId(req.params.fieldId);
  const f = fieldId ? fields[fieldId] : null;
  if (!f) return res.status(404).json({ error: 'Field not found' });
  // Row/col must be plain integers — never a path fragment.
  const r = Number(req.params.r);
  const c = Number(req.params.c);
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r > 4096 || c > 4096) {
    return res.status(400).json({ error: 'BadRequest', detail: 'Tile row and column must be integers within range.' });
  }
  const dir = path.join(UPLOAD_DIR, `${safeId(f.fieldId)}-tiles`);
  const p = path.join(dir, `tile-${r}-${c}.png`);
  // Belt-and-braces: the resolved path must stay inside the tile directory.
  if (!p.startsWith(dir + path.sep)) return res.status(400).json({ error: 'BadRequest', detail: 'Invalid tile path.' });
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Tile not found' });
  res.sendFile(p);
});

/* ---- Labeling & dataset ----------------------------------------------------- */
app.post('/api/label', (req, res) => {
  try {
    const { fieldId, r, c, class: cls } = req.body || {};
    const f = fields[fieldId];
    if (!f) return res.status(404).json({ error: 'Field not found' });
    if (!CLASS_KEYS.includes(cls)) return res.status(400).json({ error: `class must be one of ${CLASS_KEYS.join(', ')}` });
    const tile = (f.tiles || []).find(t => t.r === +r && t.c === +c);
    if (!tile) return res.status(404).json({ error: 'Tile not found' });
    tile.manualClass = cls;
    f.labeled = (f.labeled || 0) + 1;
    persistAll();
    sseSend('tile-labeled', { fieldId, r: +r, c: +c, class: cls });
    res.json({ ok: true, tile });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dataset/stats', (_req, res) => {
  const ds = loadJSON('dataset.json', { samples: [] });
  const perClass = Object.fromEntries(CLASS_KEYS.map(k => [k, 0]));
  for (const s of ds.samples) perClass[s.c] = (perClass[s.c] || 0) + 1;
  res.json({ samples: ds.samples.length, perClass, featureDim: 13 });
});

/** Manual-labels → dataset (production path: your labeled tiles). */
app.post('/api/dataset/from-labels', (_req, res) => {
  try {
    const existing = loadJSON('dataset.json', { samples: [] });
    const seen = new Set(existing.samples.map(s => s.key || ''));
    let added = 0; const perClass = { healthy: 0, stressed: 0, soil: 0, weed: 0 };
    for (const f of Object.values(fields)) {
      ensureImageData(f);
      const W = f.width, T = CONFIG.tileSize;
      for (const t of f.tiles || []) {
        if (!t.manualClass) continue;
        const key = `${f.fieldId}:${t.r}:${t.c}`;
        if (seen.has(key)) continue;
        const tile = rgbaSlice(f.imageData, W, t.x, t.y, T, T);
        existing.samples.push({ key, f: featuresForTile(tile, T, T), c: t.manualClass, fieldId: f.fieldId });
        seen.add(key); added++; perClass[t.manualClass]++;
      }
    }
    saveJSON('dataset.json', existing);
    sseSend('dataset-updated', { samples: existing.samples.length, added });
    res.json({ ok: true, added, samples: existing.samples.length, perClass });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

/* ---- (removed: ground-truth dataset builder — label real tiles instead) ---- */

/* ---- Stage 3: training + cross-validation ----------------------------------- */
app.post('/api/train', limitHeavy('train', 12), (_req, res) => {
  try {
    const ds = loadJSON('dataset.json', { samples: [] });
    const perClass = Object.fromEntries(CLASS_KEYS.map(k => [k, 0]));
    for (const s of ds.samples) perClass[s.c] = (perClass[s.c] || 0) + 1;
    const present = CLASS_KEYS.filter(k => perClass[k] > 0);
    if (present.length < 2) return res.status(400).json({ error: `Need samples for ≥2 classes. Have: ${present.join(', ') || 'none'}.` });

    // Labelling the same tiles twice must not pile up identical models: if a
    // model already exists for exactly this dataset, hand that one back.
    const dataHash = crypto.createHash('sha1')
      .update(ds.samples.map(s => `${s.c}:${s.f.map(v => v.toFixed(6)).join(',')}`).join('|'))
      .digest('hex').slice(0, 16);
    const twin = Object.values(models).find(m => m.dataHash === dataHash);
    if (twin) {
      return res.json({
        ok: true, modelId: twin.modelId, reused: true, samples: twin.samples,
        perClass: twin.perClass, classes: twin.classes, metrics: twin.metrics,
      });
    }

    const modelId = `model-${Date.now().toString(36)}`;
    const model = {
      modelId, name: `kNN crop-condition (${present.join('/')})`,
      classes: present, samples: ds.samples.length, perClass, featureDim: 13,
      trainedAt: nowIso(), data: ds.samples, dataHash,
    };
    standardizeFit(model, ds.samples);
    const minClass = Math.min(...present.map(k => perClass[k]));
    const folds = Math.max(2, Math.min(CONFIG.cvFolds, minClass));
    model.metrics = crossValidate(ds.samples, folds);
    models[modelId] = model;
    persistAll();
    sseSend('trained', { modelId, samples: ds.samples.length, perClass, metrics: model.metrics });
    res.json({ ok: true, modelId, samples: ds.samples.length, perClass, classes: present, metrics: model.metrics });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/models', (_req, res) => {
  res.json(Object.values(models).map(m => ({
    modelId: m.modelId, name: m.name, classes: m.classes, samples: m.samples,
    perClass: m.perClass, trainedAt: m.trainedAt, metrics: m.metrics || null,
  })));
});

/* ---- Stage 4: classify a single unseen tile ---------------------------------- */
app.post('/api/tile', limitHeavy('predict', 60), upload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded (field name: "image")' });
    const img = decodeImage(fs.readFileSync(req.file.path), req.file.originalname);
    if (!img) return res.status(400).json({ error: 'Unsupported file. Use PNG or JPG.' });
    const model = req.body?.modelId ? models[req.body.modelId] : Object.values(models).at(-1);
    const f = featuresForTile(img.rgba, img.width, img.height);
    const out = { ok: true, features: f, imageSize: { w: img.width, h: img.height } };
    if (model) out.prediction = knnPredict(model, f);
    else out.note = 'No trained model yet — features extracted.';
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- Stage 5: whole-field prediction ------------------------------------------ */
app.post('/api/predict', limitHeavy('predict', 60), async (req, res) => {
  try {
    const f = fields[req.body?.fieldId];
    if (!f) return res.status(404).json({ error: 'Field not found' });
    ensureImageData(f);
    const useAi = req.body?.ai === true;
    const model = req.body?.modelId ? models[req.body.modelId] : Object.values(models).at(-1);
    if (!model && !useAi)
      return res.status(409).json({ error: 'No trained model. Train first (POST /api/train), or turn on external AI in the AI Integration tab.' });

    const W = f.width, T = f.tileSize;
    const stats = { healthy: 0, stressed: 0, soil: 0, weed: 0 };
    let aiResult = null, aiError = null, gridApplied = false;
    if (model) {
      for (const t of f.tiles) {
        const tile = rgbaSlice(f.imageData, W, t.x, t.y, T, T);
        const p = knnPredict(model, featuresForTile(tile, T, T));
        t.predictedClass = p.predictedClass;
        t.confidence = p.confidence;
      }
    }

    // External AI refinement: one vision call over the whole field. If the model
    // returns a per-tile grid it becomes the classification; otherwise its
    // health/weed/soil scores feed the agronomy report.
    if (useAi) {
      if (!aiConfigured()) aiError = 'AI provider not configured';
      else {
        try {
          const payload = fieldImagePayload(f, 1024);
          const { rows, cols } = f.grid || { rows: 1, cols: 1 };
          aiResult = await callExternalAI({
            dataUrl: payload.dataUrl,
            task: `Analyse this ${cols}×${rows} grid of ${T}px tiles covering one farm field. `
              + 'Report the dominant ground-cover class, per-class share, crop health, weed pressure, soil quality and NDVI.',
            classes: CLASS_KEYS,
            gridHint: { rows, cols },
            signalNote: { fieldId: f.fieldId, gps: f.gps || null, groundWidthM: f.groundWidthM || null },
          });
          gridApplied = applyAiGrid(f, aiResult.grid, aiResult.confidence);
        } catch (e) { aiError = e.message; console.warn('[ai] predict fell back to local model:', e.message); }
      }
    }

    for (const t of f.tiles) {
      const cls = t.manualClass || t.predictedClass;
      if (cls && stats[cls] != null) stats[cls]++;
    }
    f.status = 'analyzed';
    if (model) f.modelId = model.modelId;
    if (aiResult) { f.ai = { source: gridApplied ? 'external-ai+grid' : 'external-ai', at: nowIso(), error: null, normalized: { ...aiResult, raw: undefined } }; }
    f.analyzedAt = nowIso();
    f.stats = stats;
    f.irrigation = recommendIrrigation(f);
    writeOverlay(f);
    persistAll();
    const source = aiResult ? (gridApplied ? 'external-ai+grid' : 'external-ai') : (model ? 'local-model' : 'unclassified');
    const report = buildFieldReport(f, { ai: aiResult, source, mode: aiResult ? 'external-ai' : 'local-model' });
    if (report) sseSend('ai-analyzed', { fieldId: f.fieldId, source, error: aiError });
    sseSend('field-analyzed', fieldSummary(f));
    res.json({ ok: true, field: fieldSummary(f), report, source, aiError, gridApplied, usedModel: model?.modelId || null });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/fields/:fieldId/overlay.png', (req, res) => {
  const f = fields[req.params.fieldId];
  if (!f || !f.overlayPath) return res.status(404).json({ error: 'Overlay not generated yet. POST /api/predict first.' });
  res.sendFile(path.join(ROOT, f.overlayPath));
});

/* ═════════════════════════ MAP LAYER METRICS ═══════════════════════════════
 * Everything the map needs to draw an environmental layer, computed from real
 * pixels plus real device readings. Nothing here is invented: a metric that has
 * no real input is reported as null and the map renders it as "no data".
 * ------------------------------------------------------------------------- */

/** Real per-tile greenness from the pixels: mean excess-green, cover, texture. */
function tileVitals(rgba, W, t, T) {
  let n = 0, veg = 0, exSum = 0, lumSum = 0, lumSq = 0;
  const stride = Math.max(1, Math.floor(T / 20));
  for (let y = t.y; y < t.y + T; y += stride) {
    for (let x = t.x; x < t.x + T; x += stride) {
      const o = (y * W + x) * 4;
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      lumSum += lum; lumSq += lum * lum; n++;
      const exG = 2 * g - r - b;
      if (exG > 12) { veg++; exSum += exG; }
    }
  }
  if (!n) return { vigor: 0, cover: 0, texture: 0, lum: 0 };
  const meanLum = lumSum / n;
  return {
    vigor: clamp((veg ? exSum / veg : 0) / 160, 0, 1),
    cover: veg / n,
    texture: clamp(Math.sqrt(Math.max(0, lumSq / n - meanLum * meanLum)) / 60, 0, 1),
    lum: meanLum / 255,
  };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compassOf = (deg) => (deg == null ? null : COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]);

/**
 * Everything the map draws for one field: per-tile metrics for every layer,
 * plus the site-level environment (weather, wind, soil quality) and the sensors
 * that are physically installed on that site.
 */
app.get('/api/fields/:fieldId/layers', (req, res) => {
  const f = getOr404(req, res); if (!f) return;
  ensureImageData(f);
  const T = f.tileSize || CONFIG.tileSize;
  const W = f.width;
  const rec = getSensor(f.fieldId);
  const devices = Object.values(ensureDevices(rec)).map(deviceSummary);
  const report = buildFieldReport(f, { ai: f.ai?.normalized || null, source: f.ai?.source || 'local-model', mode: 'cached' });
  const soil = assessSoilQuality(f);
  const wx = rec.weather;

  // Probe readings are attributed to the tile they were installed on, so the
  // map can show real sensor coverage instead of a smooth guess.
  const byTile = new Map();
  for (const d of devices) {
    if (d.r == null || d.c == null) continue;
    if (d.latest?.soilMoisture == null && d.latest?.ph == null && d.latest?.ec == null) continue;
    byTile.set(`${d.r}:${d.c}`, d);
  }

  // Every tile gets its real centre in WGS84 so the map, the device markers and
  // any downstream GIS tool agree on where the tile actually is.
  const geo = fieldGeometry(f);
  const tileCentre = (r, c) => tileGeo(f, r, c);

  const tiles = (f.tiles || []).map((t) => {
    const vit = tileVitals(f.imageData, W, t, T);
    const cls = t.manualClass || t.predictedClass || null;
    const dev = byTile.get(`${t.r}:${t.c}`) || null;
    const isCrop = cls === 'healthy' || cls === 'stressed';
    const { lat, lon } = tileCentre(t.r, t.c);
    return {
      r: t.r, c: t.c,
      lat, lon,
      class: cls,
      confidence: t.confidence || 0,
      manual: !!t.manualClass,
      vigor: round(vit.vigor, 3),
      cover: round(vit.cover, 3),
      texture: round(vit.texture, 3),
      // plant health only exists where there are plants
      health: isCrop ? round(clamp(vit.vigor * 108, 0, 100), 0) : null,
      // weed load: classified weed area is high; low-vigour off-crop growth is partial
      weed: cls === 'weed' ? round(clamp(72 + vit.vigor * 28, 0, 100), 0)
          : cls === 'stressed' ? round(clamp(vit.vigor * 34, 0, 100), 0) : 0,
      // imagery-derived soil condition: tilth texture + organic proxy, penalised by exposure
      soil: cls === 'soil'
        ? round(clamp(38 + vit.texture * 34 + vit.texture * (0.55 - vit.lum) * 60, 0, 100), 0)
        : null,
      // probe-only: real instrument readings, null where no probe is installed
      moisture: dev?.latest?.soilMoisture ?? null,
      ph: dev?.latest?.ph ?? null,
      ec: dev?.latest?.ec ?? null,
      soilTempC: dev?.latest?.soilTempC ?? null,
      deviceId: dev?.deviceId || null,
      moistureSource: dev ? 'device-probe' : null,
    };
  });

  res.json({
    fieldId: f.fieldId,
    grid: f.grid,
    geometry: { ...geo, ...(report?.geometry || {}) },
    classifiedBy: f.classifiedBy || (f.modelId ? 'local-model' : null),
    gps: f.gps || null,
    imageSize: { width: f.width, height: f.height, tileSize: T },
    tiles,
    site: {
      weather: wx,
      wind: wx && wx.windKmh != null
        ? { kmh: wx.windKmh, gustKmh: wx.windGustKmh, dirDeg: wx.windDirDeg, compass: compassOf(wx.windDirDeg), bearingRad: wx.windDirDeg == null ? null : (wx.windDirDeg * Math.PI) / 180 }
        : null,
      climate: {
        et0MmDay: wx?.et0MmDay ?? null,
        rainTodayMm: wx?.rainTodayMm ?? null,
        precipitationMm: wx?.precipitationMm ?? null,
        humidityPct: wx?.humidityPct ?? null,
        feelsLikeC: wx?.feelsLikeC ?? null,
        cloudPct: wx?.cloudPct ?? null,
        pressureHpa: wx?.pressureHpa ?? null,
        soilMoisturePct: wx?.soilMoisturePct ?? null,
        soilMoistureSurfacePct: wx?.soilMoistureSurfacePct ?? null,
      },
      compass: compassOf(wx?.windDirDeg),
      soilQuality: { score: soil.score, grade: soil.grade, insufficient: soil.insufficient, inputs: soil.inputs },
      plantHealth: report?.plant ? { score: report.plant.healthScore, grade: report.plant.healthGrade, ndvi: report.plant.ndvi } : null,
      weed: report?.weed || null,
      // Recomputed live rather than read off the field record: a probe reading
      // that landed since the last analysis must change the advisory on the map.
      irrigation: recommendIrrigation(f),
      labels: report?.labels || null,
    },
    devices,
    sensorTypes: SENSOR_TYPES,
    sensorUnits: SENSOR_UNITS,
  });
});

/**
 * The whole sensor estate grouped by site — this is what the Sensors tab and the
 * map legend render. One row per site, every installed device underneath it.
 */
app.get('/api/sensors/sites', (_req, res) => {
  const out = [];
  for (const f of Object.values(fields)) {
    const rec = sensors[f.fieldId] || newSensorRecord(f.fieldId);
    const devices = Object.values(ensureDevices(rec)).map(deviceSummary);
    // Crop and soil are the context a probe reading only makes sense inside:
    // a moisture value alone says nothing about the crop it is growing.
    const report = buildFieldReport(f, { ai: f.ai?.normalized || null, source: f.ai?.source || 'local-model', mode: 'cached' });
    const soil = assessSoilQuality(f);
    const merged = mergedDeviceReading(rec);
    out.push({
      siteId: f.fieldId,
      name: f.imageName,
      status: f.status,
      gps: f.gps || null,
      grid: f.grid,
      weather: rec.weather,
      weatherError: rec.weatherError,
      wind: rec.weather?.windKmh != null
        ? { kmh: rec.weather.windKmh, gustKmh: rec.weather.windGustKmh, dirDeg: rec.weather.windDirDeg, compass: compassOf(rec.weather.windDirDeg) }
        : null,
      updatedAt: rec.updatedAt,
      deviceCount: devices.length,
      liveCount: devices.filter((d) => d.status === 'live').length,
      devices,
      summary: fieldSummary(f),
      crop: report ? {
        canopyPct: report.plant.canopyCoverPct,
        healthScore: report.plant.healthScore,
        healthGrade: report.plant.healthGrade,
        ndvi: report.plant.ndvi,
        fieldAreaHa: report.geometry.fieldAreaHa,
        healthyHa: report.classes.healthy.ha,
        stressedHa: report.classes.stressed.ha,
        soilHa: report.classes.soil.ha,
        weedHa: report.classes.weed.ha,
        weedPct: report.weed.pct,
        source: report.source,
      } : null,
      soil: {
        score: soil.score,
        grade: soil.grade,
        insufficient: soil.insufficient,
        inputs: soil.inputs,
        dataSources: soil.dataSources,
        // The freshest value per metric, and which sensor produced it.
        moisturePct: merged?.soilMoisture ?? rec.weather?.soilMoisturePct ?? null,
        moistureSource: merged?.sources?.soilMoisture || (rec.weather?.soilMoisturePct != null ? 'open-meteo' : null),
        ph: merged?.ph ?? null,
        phSource: merged?.sources?.ph || null,
        ec: merged?.ec ?? null,
        soilTempC: merged?.soilTempC ?? null,
      },
    });
  }
  res.json({ sites: out, totalDevices: out.reduce((a, s) => a + s.deviceCount, 0) });
});

/** Register a sensor on a site. Returns its device id + ingest token (shown once). */
app.post('/api/fields/:fieldId/sensors', (req, res) => {
  const f = fields[req.params.fieldId];
  if (!f) return res.status(404).json({ error: 'Field not found' });
  const b = req.body || {};
  const dev = newDevice({
    field: f,
    fieldId: f.fieldId,
    name: b.name,
    type: b.type,
    lat: b.lat,
    lon: b.lon,
    r: b.r,
    c: b.c,
  });
  // Default a missing tile to the middle of the field so the marker lands on soil.
  if (dev.r == null && f.grid) { dev.r = Math.floor(f.grid.rows / 2); dev.c = Math.floor(f.grid.cols / 2); }
  const rec = getSensor(f.fieldId);
  ensureDevices(rec)[dev.deviceId] = dev;
  rec.updatedAt = nowIso();
  persistAll();
  sseSend('device-added', { fieldId: f.fieldId, device: deviceSummary(dev) });
  res.json({ ok: true, device: deviceSummary(dev), ingestToken: dev.ingestToken });
});

/** Remove a sensor and its reading history from a site. */
app.delete('/api/fields/:fieldId/sensors/:deviceId', (req, res) => {
  const rec = sensors[req.params.fieldId];
  if (!rec) return res.status(404).json({ error: 'Site not found' });
  const devices = ensureDevices(rec);
  const dev = devices[req.params.deviceId];
  if (!dev) return res.status(404).json({ error: 'Sensor not found' });
  delete devices[req.params.deviceId];
  rec.updatedAt = nowIso();
  persistAll();
  sseSend('device-removed', { fieldId: req.params.fieldId, deviceId: req.params.deviceId });
  res.json({ ok: true, removed: req.params.deviceId });
});

/* ═══════════════════════ External AI API surface ═════════════════════════════
 * GET  /api/ai/status   – provider config + live call/error/latency stats
 * GET  /api/ai/config   – stored config (API key masked)
 * POST /api/ai/config   – save provider / baseUrl / apiKey / model / timeout
 * POST /api/ai/test     – real round-trip to the model, returns latency + parsed JSON
 * POST /api/ai/tile     – classify ONE tile with the external model
 * POST /api/ai/field    – full agronomy report: plant detection, plant area,
 *                         plant health/quality, weed area, soil quality.
 *                         Falls back to the local kNN model, and says so.
 * GET  /api/fields/:id/report – cached report from the last analysis (no AI call)
 * ============================================================================ */

/** Downscale + JPEG-encode a field image so vision models get a sane payload. */
function fieldImagePayload(f, maxDim = 1024) {
  ensureImageData(f);
  const scale = Math.min(1, maxDim / Math.max(f.width, f.height));
  const w = Math.max(1, Math.round(f.width * scale));
  const h = Math.max(1, Math.round(f.height * scale));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(f.height - 1, Math.round((y / h) * f.height));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(f.width - 1, Math.round((x / w) * f.width));
      const so = (sy * f.width + sx) * 4, dof = (y * w + x) * 4;
      out[dof] = f.imageData[so]; out[dof + 1] = f.imageData[so + 1];
      out[dof + 2] = f.imageData[so + 2]; out[dof + 3] = 255;
    }
  }
  const enc = jpegjs().encode({ data: out, width: w, height: h }, 85);
  return { dataUrl: encodeDataUrl(enc.data, 'image/jpeg'), width: w, height: h, bytes: enc.data.length };
}

/** One tile crop as a PNG data URL (tiles are 50px, so this stays tiny). */
function tileImagePayload(f, t) {
  ensureImageData(f);
  const T = f.tileSize || CONFIG.tileSize;
  const tile = rgbaSlice(f.imageData, f.width, t.x, t.y, T, T);
  const buf = encodePng(T, T, tile);
  return { dataUrl: encodeDataUrl(buf, 'image/png'), width: T, height: T, bytes: buf.length };
}

/**
 * Box-average downscale — enough for a vision model, no image library needed.
 * Returns the input untouched when it already fits inside maxSide.
 */
function downscaleRgba(rgba, w, h, maxSide) {
  if (w <= maxSide && h <= maxSide) return { rgba, width: w, height: h };
  const scale = maxSide / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(nw * nh * 4);
  const xr = w / nw, yr = h / nh;
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor(y * yr), sy1 = Math.min(h, Math.max(sy0 + 1, Math.floor((y + 1) * yr)));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor(x * xr), sx1 = Math.min(w, Math.max(sx0 + 1, Math.floor((x + 1) * xr)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * w + sx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { rgba: out, width: nw, height: nh };
}

/**
 * Species identification needs a PHOTOGRAPH, not a 50 px map tile — no vision
 * model can name a plant from a thumbnail of a field. This sends the largest
 * sensible view of the source imagery: a square region centred on the requested
 * tile (or the whole frame for a test round-trip), downscaled to a bounded side
 * so the call stays fast. The crop is reported back for provenance.
 */
function speciesImagePayload(f, { tile = null, maxSide = 448, regionTiles = 8 } = {}) {
  ensureImageData(f);
  const T = f.tileSize || CONFIG.tileSize;
  let sx = 0, sy = 0, sw = f.width, sh = f.height, kind = 'full-frame';
  if (tile) {
    const side = Math.min(Math.max(T * regionTiles, T * 3), f.width, f.height);
    sw = side; sh = side;
    const cx = Math.round(tile.x + T / 2), cy = Math.round(tile.y + T / 2);
    sx = Math.min(Math.max(0, cx - Math.round(sw / 2)), f.width - sw);
    sy = Math.min(Math.max(0, cy - Math.round(sh / 2)), f.height - sh);
    kind = 'tile-region';
  }
  const cropPx = rgbaSlice(f.imageData, f.width, sx, sy, sw, sh);
  const small = downscaleRgba(cropPx, sw, sh, maxSide);
  const buf = encodePng(small.width, small.height, small.rgba);
  return {
    dataUrl: encodeDataUrl(buf, 'image/png'),
    width: small.width, height: small.height, bytes: buf.length,
    crop: { x: sx, y: sy, w: sw, h: sh, source: kind, tileSizePx: T },
  };
}

const aiFieldsReport = (f) => buildFieldReport(f, { ai: f.ai?.normalized || null, source: f.ai?.source || (f.stats ? 'local-model' : 'unclassified'), mode: 'cached' });

app.get('/api/ai/status', (_req, res) => res.json(publicAiStatus()));

app.get('/api/ai/config', (_req, res) => res.json(publicAiStatus()));

app.post('/api/ai/config', limitHeavy('ai', 30), (req, res) => {
  try {
    const b = req.body || {};
    if (b.provider != null) {
      if (!['disabled', 'generic', 'openai'].includes(b.provider))
        return res.status(400).json({ error: `provider must be one of disabled, generic, openai` });
      aiConfig.provider = b.provider;
    }
    if (b.baseUrl !== undefined) {
      const u = String(b.baseUrl || '').trim();
      if (u && !/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'baseUrl must start with http:// or https://' });
      aiConfig.baseUrl = u;
    }
    if (b.apiKey !== undefined) {
      const k = b.apiKey === null ? '' : String(b.apiKey);
      // an unchanged masked key means "keep what is stored"
      aiConfig.apiKey = (k.includes('•') || k === maskKey(aiConfig.apiKey)) ? (aiConfig.apiKey || '') : k.trim();
    }
    if (b.model !== undefined) aiConfig.model = String(b.model || '').trim();
    if (b.timeoutMs !== undefined) aiConfig.timeoutMs = Math.max(2000, +b.timeoutMs || 45000);
    if (b.enabled !== undefined) aiConfig.enabled = !!b.enabled;
    if (b.identify !== undefined) {
      const ib = b.identify || {};
      const next = { ...(aiConfig.identify || {}) };
      if (ib.provider !== undefined) {
        if (!['disabled', 'generic', 'openai'].includes(ib.provider))
          return res.status(400).json({ error: 'identify.provider must be one of disabled, generic, openai' });
        next.provider = ib.provider;
      }
      if (ib.baseUrl !== undefined) {
        const u = String(ib.baseUrl || '').trim();
        if (u && !/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'identify.baseUrl must start with http:// or https://' });
        next.baseUrl = u;
      }
      if (ib.apiKey !== undefined) {
        const k = String(ib.apiKey);
        next.apiKey = (k.includes('•') || k === maskKey(next.apiKey)) ? (next.apiKey || '') : k.trim();
      }
      if (ib.model !== undefined) next.model = String(ib.model || '').trim();
      if (ib.timeoutMs !== undefined) next.timeoutMs = Math.max(5000, +ib.timeoutMs || 120000);
      aiConfig.identify = next;
    }
    saveJSON('ai-config.json', aiConfig);
    console.log(`[ai] config saved — provider=${aiSettings().provider} model=${aiSettings().model || '—'} identify=${aiConfig.identify?.baseUrl || 'main endpoint'}`);
    res.json({ ok: true, ...publicAiStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Real round-trip: sends actual imagery, returns latency + the parsed model JSON. */
app.post('/api/ai/test', limitHeavy('ai', 30), async (req, res) => {
  try {
    if (!aiConfigured()) return res.status(409).json({ error: 'AI provider not configured. Save a provider and baseUrl first.', ...publicAiStatus() });
    const f = fields[req.body?.fieldId] || Object.values(fields)[0];
    let payload, probeOnly = false;
    if (f) {
      ensureImageData(f);
      const t = (f.tiles || [])[0];
      if (t) payload = tileImagePayload(f, t);
      else payload = fieldImagePayload(f, 512);
    } else {
      probeOnly = true;
      const blank = Buffer.from([10, 143, 71, 255]);
      payload = { dataUrl: encodeDataUrl(encodePng(1, 1, blank), 'image/png'), width: 1, height: 1, bytes: 4 };
    }
    const started = Date.now();
    const normalized = await callExternalAI({
      dataUrl: payload.dataUrl,
      task: probeOnly
        ? 'Connection test. No field imagery exists yet — return {"class":"soil","confidence":0.1}.'
        : `Connectivity test: analyse this single ${payload.width}x${payload.height} px field tile.`,
      classes: CLASS_KEYS,
    });
    res.json({
      ok: true, probeOnly, latencyMs: Date.now() - started,
      request: { bytes: payload.bytes, width: payload.width, height: payload.height },
      normalized: { ...normalized, raw: undefined },
      raw: normalized.raw,
    });
  } catch (e) {
    res.status(502).json({ error: `AI request failed: ${e.message}`, ...publicAiStatus() });
  }
});

/** Classify ONE tile with the external model (plant / weed / soil + health). */
app.post('/api/ai/tile', limitHeavy('ai', 30), async (req, res) => {
  const f = fields[req.body?.fieldId];
  if (!f) return res.status(404).json({ error: 'Field not found' });
  if (!aiConfigured()) return res.status(409).json({ error: 'AI provider not configured', ...publicAiStatus() });
  const t = (f.tiles || []).find(x => x.r === +req.body?.r && x.c === +req.body?.c);
  if (!t) return res.status(404).json({ error: 'Tile not found' });
  try {
    ensureImageData(f);
    const payload = tileImagePayload(f, t);
    const started = Date.now();
    const normalized = await callExternalAI({
      dataUrl: payload.dataUrl, task: `Classify this single ${payload.width}x${payload.height} px field tile.`, classes: CLASS_KEYS,
    });
    res.json({
      ok: true, fieldId: f.fieldId, r: t.r, c: t.c,
      latencyMs: Date.now() - started,
      tileM2: round(fieldGeometry(f).tileAreaM2, 2),
      prediction: { ...normalized, raw: undefined },
      raw: normalized.raw,
    });
  } catch (e) { res.status(502).json({ error: `AI request failed: ${e.message}` }); }
});

/**
 * Full-field AI analysis. Calls the external model ONCE with the georeferenced
 * image, optionally accepts a per-tile classification grid, then combines the
 * answer with real tile geometry, device sensors and Open-Meteo to produce:
 *   • plant detection + plant area (m² / ha / acres)
 *   • plant health & quality score
 *   • weed area + weed pressure
 *   • soil quality score with per-input provenance
 * Any failure degrades to the local kNN model and reports `aiError` honestly.
 */
app.post('/api/ai/field', limitHeavy('ai', 30), async (req, res) => {
  const f = fields[req.body?.fieldId];
  if (!f) return res.status(404).json({ error: 'Field not found' });
  const started = Date.now();
  let normalized = null, aiError = null, gridApplied = false, gridRequested = req.body?.grid !== false;

  if (aiConfigured()) {
    try {
      ensureImageData(f);
      const payload = fieldImagePayload(f, +(req.body?.maxDim) || 1024);
      const { rows, cols } = f.grid || { rows: 1, cols: 1 };
      normalized = await callExternalAI({
        dataUrl: payload.dataUrl,
        task: `Analyse this ${cols}×${rows} grid of ${f.tileSize || CONFIG.tileSize}px tiles covering one farm field. `
          + 'Report the dominant ground-cover class, per-class share, crop health, weed pressure, soil quality and NDVI.',
        classes: CLASS_KEYS,
        gridHint: gridRequested ? { rows, cols } : null,
        signalNote: { fieldId: f.fieldId, gps: f.gps || null, groundWidthM: f.groundWidthM || null, analyzedAt: f.analyzedAt || null },
      });
      gridApplied = applyAiGrid(f, normalized.grid, normalized.confidence);
    } catch (e) {
      aiError = e.message;
      console.warn(`[ai] field ${f.fieldId} fell back to local model:`, e.message);
    }
  } else {
    aiError = 'AI provider not configured';
  }

  const source = normalized ? (gridApplied ? 'external-ai+grid' : 'external-ai') : (f.stats ? 'local-model' : 'unclassified');
  const report = buildFieldReport(f, { ai: normalized, source, mode: normalized ? 'external-ai' : 'local-model' });
  if (!report) return res.status(409).json({ error: 'Field has no classified tiles yet. Run Analyze Field first.' });

  f.ai = { source, at: nowIso(), latencyMs: Date.now() - started, error: aiError, normalized: normalized ? { ...normalized, raw: undefined } : null };
  f.irrigation = recommendIrrigation(f);
  persistAll();
  sseSend('ai-analyzed', { fieldId: f.fieldId, source, latencyMs: f.ai.latencyMs, error: aiError });
  sseSend('field-analyzed', fieldSummary(f));
  res.json({ ok: true, source, aiError, gridApplied, latencyMs: Date.now() - started, report, ai: f.ai });
});

/* ---- Species identification ------------------------------------------------
 * Point the camera (or a map tile) at a plant: ONE real model call, the result
 * stored with time + place, broadcast on SSE. Nothing is ever guessed locally —
 * an unconfigured or unreachable endpoint fails loudly with a real error.
 *   POST /api/ai/identify   { image, thumb?, gps?, source? } | { fieldId, r, c }
 *   GET  /api/identify      stored history (most recent first)
 *   POST /api/ai/test-identify  round-trip against a real tile, NOT saved
 * ============================================================================ */

let identifications = loadJSON('identifications.json', []);
if (!Array.isArray(identifications)) identifications = [];
const IDENTIFY_TASK = 'Identify the plant species in this photograph.';

function rememberIdentification(entry) {
  identifications.unshift(entry);
  if (identifications.length > 100) identifications.length = 100;   // bounded store
  try { saveJSON('identifications.json', identifications); }
  catch (e) { console.warn('[identify] persist failed:', e.message); }
}

app.get('/api/identify', (_req, res) => res.json({ total: identifications.length, items: identifications }));

app.post('/api/ai/identify', limitHeavy('ai', 30), async (req, res) => {
  try {
    const b = req.body || {};
    if (!identifyConfigured())
      return res.status(409).json({
        error: 'Species identification endpoint not configured. Save one in AI Model → Species identification endpoint (default: local Ollama at http://localhost:11434/v1).',
        ...publicAiStatus(),
      });

    let dataUrl, source, place = {};
    if (b.fieldId) {
      const f = fields[b.fieldId];
      if (!f) return res.status(404).json({ error: 'Field not found' });
      const t = (f.tiles || []).find((x) => x.r === +b.r && x.c === +b.c);
      if (!t) return res.status(404).json({ error: 'Tile not found' });
      ensureImageData(f);
      const shot = speciesImagePayload(f, { tile: t });
      dataUrl = shot.dataUrl;
      source = 'field-region';
      place = {
        fieldId: f.fieldId, r: t.r, c: t.c,
        crop: shot.crop,
        gps: f.gps?.lat != null ? { lat: f.gps.lat, lon: f.gps.lon } : null,
      };
    } else if (b.image) {
      if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]{16,2500000}$/i.test(String(b.image)))
        return res.status(400).json({ error: 'image must be a base64 PNG/JPEG/WebP data URL' });
      dataUrl = String(b.image);
      source = b.source === 'map' ? 'map' : 'camera';
      place = { gps: b.gps && Number.isFinite(+b.gps.lat) && Number.isFinite(+b.gps.lon) ? { lat: +b.gps.lat, lon: +b.gps.lon } : null };
    } else {
      return res.status(400).json({ error: 'Send an image data URL, or { fieldId, r, c } for a map tile' });
    }

    const settings = identifySettings();
    const started = Date.now();
    // Small local VLMs occasionally answer with prose or image-file metadata;
    // one retry of the SAME real call absorbs that flakiness. If both attempts
    // yield nothing species-shaped, fail honestly — we never invent a name.
    let result = null, lastErr = null;
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      try {
        const raw = await callExternalAI({ dataUrl, task: IDENTIFY_TASK, mode: 'identify', settings });
        result = normalizeIdentifyResult(raw);
        if (result) break;
        lastErr = new Error('model returned no species information — try a close, sharp photo of a single plant');
      } catch (e) { lastErr = e; }
    }
    if (!result) throw lastErr || new Error('model returned no species information');

    const entry = {
      id: `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      at: nowIso(),
      source,
      ...place,
      thumb: typeof b.thumb === 'string' && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]{16,300000}$/.test(b.thumb) ? b.thumb : null,
      result: { ...result, raw: undefined },
      model: settings.model || settings.baseUrl,
      provider: settings.provider,
      latencyMs: Date.now() - started,
    };
    rememberIdentification(entry);
    sseSend('plant-identified', {
      id: entry.id, source, at: entry.at,
      common: entry.result.common, scientific: entry.result.scientific,
      type: entry.result.type, confidence: entry.result.confidence,
    });
    console.log(`[identify] ${entry.id} ${source} -> ${entry.result.common || entry.result.scientific || '?'} (${entry.result.type}, ${(entry.result.confidence * 100).toFixed(0)}%) in ${entry.latencyMs} ms`);
    res.json({ ok: true, id: entry.id, latencyMs: entry.latencyMs, model: entry.model, result: entry.result });
  } catch (e) {
    console.warn('[identify] failed:', e.message);
    res.status(502).json({ error: `Species identification failed: ${e.message}`, ...publicAiStatus() });
  }
});

/** Round-trip against the SPECIES endpoint with real tile imagery. Not saved. */
app.post('/api/ai/test-identify', limitHeavy('ai', 30), async (req, res) => {
  try {
    if (!identifyConfigured())
      return res.status(409).json({ error: 'Species identification endpoint not configured.', ...publicAiStatus() });
    const f = fields[req.body?.fieldId] || Object.values(fields)[0];
    if (!f) return res.status(409).json({ error: 'No field imagery to test with — upload an image first.' });
    if (!(f.tiles || []).length) return res.status(409).json({ error: 'Field has no tiles to test with.' });
    // Round-trip with the full frame: this is the same view a user's own photo
    // gives the model, so a pass here means the species endpoint really works.
    const payload = speciesImagePayload(f, { maxSide: 512 });
    const settings = identifySettings();
    const started = Date.now();
    const raw = await callExternalAI({ dataUrl: payload.dataUrl, task: IDENTIFY_TASK, mode: 'identify', settings });
    const result = normalizeIdentifyResult(raw);
    if (!result) throw new Error('model returned no species information — the test image is a whole field, so try the Identify button on a close-up photo');
    res.json({
      ok: true, latencyMs: Date.now() - started,
      model: settings.model || settings.baseUrl, provider: settings.provider,
      request: { bytes: payload.bytes, width: payload.width, height: payload.height, fieldId: f.fieldId, crop: payload.crop },
      result, saved: false,
    });
  } catch (e) {
    res.status(502).json({ error: `Species identification failed: ${e.message}`, ...publicAiStatus() });
  }
});

/** Cached report — no external call, so it is instant and free. */
app.get('/api/fields/:fieldId/report', (req, res) => {
  const f = getOr404(req, res); if (!f) return;
  const report = aiFieldsReport(f);
  if (!report) return res.status(409).json({ error: 'Field has no classified tiles yet. Run Analyze Field first.' });
  res.json(report);
});

/* ---- GeoJSON / geo mapping ------------------------------------------------------ */
app.get('/api/fields/:fieldId/geojson', (req, res) => {
  const f = getOr404(req, res); if (!f) return;
  const gj = fieldGeoJSON(f, { tiles: req.query.tiles !== 'false' });
  if (!gj) return res.status(409).json({ error: 'Field has no geolocation. Geotag it via EXIF, POST /api/fields/:id/geotag, or upload with lat/lon.' });
  res.json(gj);
});

/* ---- Listings --------------------------------------------------------------------- */
app.get('/api/fields', (_req, res) => res.json(Object.values(fields).map(fieldSummary)));

app.get('/api/fields/:fieldId', (req, res) => {
  const f = getOr404(req, res); if (!f) return;
  const out = fieldSummary(f);
  out.tiles = f.tiles;
  out.imagePath = f.imagePath;
  out.groundTruth = f.groundTruth || null;
  out.labeled = f.labeled || 0;
  out.ingestToken = f.ingestToken; // owner view
  return res.json(out);
});

app.delete('/api/fields/:fieldId', (req, res) => {
  const f = fields[req.params.fieldId];
  if (!f) return res.status(404).json({ error: 'Field not found' });
  delete fields[f.fieldId];
  delete sensors[f.fieldId];
  for (const p of [path.join(ROOT, f.imagePath || ''), path.join(UPLOAD_DIR, `${f.fieldId}-overlay.png`)]) {
    try { fs.rmSync(p, { force: true }); } catch {}
  }
  try { fs.rmSync(path.join(UPLOAD_DIR, `${f.fieldId}-tiles`), { recursive: true, force: true }); } catch {}
  persistAll();
  sseSend('field-deleted', { fieldId: f.fieldId });
  res.json({ ok: true });
});

/* ---- Stage 6: sensors — real weather + per-device ingest ------------------------- */
app.get('/api/sensors', (_req, res) => res.json(Object.values(sensors)));

/**
 * Real device ingest: POST /api/fields/:id/ingest?deviceId=S-xxxx  (X-Sensor-Token).
 * With a deviceId the reading is attributed to that exact installed sensor, so a
 * site with twenty probes keeps twenty independent histories. Without one the
 * reading lands in the legacy site-level stream.
 */
app.post('/api/fields/:fieldId/ingest', limitHeavy('ingest', 240), (req, res) => {
  const f = fields[req.params.fieldId];
  if (!f) return res.status(404).json({ error: 'Field not found' });
  const token = String(req.get('X-Sensor-Token') || req.query.token || req.body?.token || '');
  const rec = getSensor(f.fieldId);
  const deviceId = req.query.deviceId || req.body?.deviceId || null;
  const devices = ensureDevices(rec);
  const dev = deviceId ? devices[deviceId] : null;

  if (deviceId && !dev) return res.status(404).json({ error: `Sensor ${deviceId} is not registered on ${f.fieldId}` });
  // Constant-time compare: a byte-by-byte `===` leaks the shared prefix length.
  const good = dev
    ? (tokenEquals(token, dev.ingestToken) || tokenEquals(token, f.ingestToken))
    : tokenEquals(token, f.ingestToken);
  if (!good) return res.status(401).json({ error: 'Invalid or missing sensor token (X-Sensor-Token header)' });

  const b = req.body || {};
  const num = (v) => (Number.isFinite(+v) ? +v : undefined);
  const reading = { t: nowIso() };
  const FIELDS_MAP = {
    soilMoisture: [0, 100], temperatureC: [-40, 80], humidityPct: [0, 100],
    ph: [0, 14], ec: [0, 10], rainMm: [0, 500], battery: [0, 100],
    soilTempC: [-40, 80], windKmh: [0, 200], lightLux: [0, 200000],
  };
  for (const [k, [lo, hi]] of Object.entries(FIELDS_MAP)) {
    const v = num(b[k]);
    if (v !== undefined) reading[k] = clamp(v, lo, hi);
  }
  if (Object.keys(reading).length === 1) return res.status(400).json({ error: `No valid readings. Accepted: ${Object.keys(FIELDS_MAP).join(', ')}` });

  const rec2 = rec;
  if (dev) {
    dev.readings.push(reading);
    if (dev.readings.length > CONFIG.deviceReadingsCap) dev.readings = dev.readings.slice(-CONFIG.deviceReadingsCap);
    dev.lastSeen = reading.t;
    dev.count = (dev.count || 0) + 1;
    if (b.lat != null || b.lon != null) {
      if (Number.isFinite(+b.lat) && b.lat !== '') dev.lat = +b.lat;
      if (Number.isFinite(+b.lon) && b.lon !== '') dev.lon = +b.lon;
    }
  } else {
    rec2.device.push(reading);
    if (rec2.device.length > CONFIG.deviceReadingsCap) rec2.device = rec2.device.slice(-CONFIG.deviceReadingsCap);
  }
  rec2.updatedAt = nowIso();
  persistAll();
  sseSend('device-reading', { fieldId: f.fieldId, deviceId: dev?.deviceId || null, reading });
  res.json({ ok: true, deviceId: dev?.deviceId || null, accepted: Object.keys(reading).filter(k => k !== 't'), reading });
});

app.post('/api/sensors/refresh-weather', async (_req, res) => {
  try {
    await refreshWeatherAll();
    res.json({ ok: true, sensors: Object.values(sensors) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════ OPENSTREETMAP ═════════════════════════════════
 * Nominatim (place search, reverse geocoding) and Overpass (real map features),
 * both proxied through this server rather than called from the tab:
 *   · the Nominatim usage policy requires an identifying User-Agent and at most
 *     one request per second, which is enforceable here and not in a browser;
 *   · the CSP keeps connect-src 'self' with no third-party origin added;
 *   · replies are cached, so repeat lookups cost the public services nothing.
 * Failures always name the provider - nothing here invents a coordinate, a
 * place name or a map feature.
 * ══════════════════════════════════════════════════════════════════════════ */
const OSM = {
  nominatim: process.env.OSM_NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
  overpass: process.env.OSM_OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
  userAgent: process.env.OSM_USER_AGENT || 'VibesLiteCropAI/1.0 (field analysis console)',
  contact: process.env.OSM_CONTACT || '',
  minIntervalMs: 1100,            // Nominatim's published limit is 1 request/second
  ttlMs: 15 * 60 * 1000,
  timeoutMs: 12000,
  maxRadiusM: 5000,
  maxFeatures: 400,
  maxResults: 8,
};
const OSM_ATTRIBUTION = 'OpenStreetMap contributors (ODbL 1.0)';
const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';
const OSM_TILE_POLICY = 'OpenStreetMap tile servers are donated capacity: interactive use at a human pace, no bulk download or AOI prefetch.';

/** Basemap styles the console offers, with the host the CSP has to allow. */
const OSM_BASEMAPS = {
  osm: { label: 'OSM Street', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', host: 'tile.openstreetmap.org', attr: 'OpenStreetMap contributors', maxZoom: 19 },
  hot: { label: 'OSM Humanitarian', url: 'https://tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', host: 'tile.openstreetmap.fr', attr: 'OpenStreetMap contributors, Tiles: HOT', maxZoom: 20 },
  topo: { label: 'OSM Terrain', url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png', host: 'a.tile.opentopomap.org', attr: 'OpenStreetMap contributors, SRTM | OpenTopoMap (CC-BY-SA)', maxZoom: 17 },
};

/** Overpass selectors per drawable feature class. */
const OSM_FEATURE_KINDS = {
  roads: { label: 'Roads and tracks', selectors: ['way["highway"]'], style: { color: '#ffd12e', weight: 2 } },
  waterways: { label: 'Waterways and ditches', selectors: ['way["waterway"]'], style: { color: '#4aa3ff', weight: 2 } },
  water: { label: 'Water bodies', selectors: ['nwr["natural"="water"]', 'nwr["landuse"="reservoir"]'], style: { color: '#2f6fb5', weight: 1 } },
  landuse: { label: 'Land use', selectors: ['nwr["landuse"]'], style: { color: '#9ee04a', weight: 1 } },
  buildings: { label: 'Buildings and yards', selectors: ['way["building"]', 'way["man_made"="storage_tank"]'], style: { color: '#ff8c2b', weight: 1 } },
  barriers: { label: 'Hedges and fences', selectors: ['way["barrier"="hedge"]', 'way["barrier"="fence"]'], style: { color: '#cbff3c', weight: 1 } },
};
const OSM_DEFAULT_KINDS = ['roads', 'waterways', 'water', 'landuse'];
const OSM_KEEP_TAGS = ['name', 'highway', 'waterway', 'water', 'landuse', 'natural', 'building', 'barrier', 'surface', 'tracktype', 'width', 'agricultural', 'crop', 'seasonal', 'intermittent', 'usage', 'ref', 'operator', 'access'];

const osmCache = new Map();            // cache key -> { t, data }
let osmLastCall = 0;
const osmTelemetry = { lastError: null, lastOkAt: null, calls: 0 };

function osmCacheGet(key) {
  const hit = osmCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > OSM.ttlMs) { osmCache.delete(key); return null; }
  return hit.data;
}
function osmCacheSet(key, data) {
  osmCache.set(key, { t: Date.now(), data });
  if (osmCache.size > 256) {
    for (const [k] of [...osmCache].sort((a, b) => a[1].t - b[1].t).slice(0, 64)) osmCache.delete(k);
  }
  return data;
}

/** Space outbound calls so the one-request-per-second policy actually holds. */
async function osmThrottle() {
  const now = Date.now();
  const wait = OSM.minIntervalMs - (now - osmLastCall);
  osmLastCall = now + Math.max(0, wait);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const osmUserAgent = () =>
  (OSM.contact && !OSM.userAgent.includes(OSM.contact) ? `${OSM.userAgent} (${OSM.contact})` : OSM.userAgent);

/** One upstream GET carrying the identifying header the policy requires. */
async function osmGetJson(url, params, provider) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  ).toString();
  osmTelemetry.calls += 1;
  try {
    const data = await fetchJson(`${url}?${qs}`, {
      timeoutMs: OSM.timeoutMs,
      headers: { 'User-Agent': osmUserAgent(), Referer: OSM.contact || 'http://localhost/' },
    });
    osmTelemetry.lastOkAt = nowIso();
    osmTelemetry.lastError = null;
    return data;
  } catch (e) {
    osmTelemetry.lastError = `${provider}: ${e.message}`;
    const err = new Error(
      `${provider} is unreachable or refused the request (${e.message}). Place search and map features need `
      + 'outbound network access; the basemaps keep working from the tile server.',
    );
    err.status = 502;
    throw err;
  }
}

/** Normalise one Nominatim record into the console's shape. */
function osmPlace(entry) {
  const b = Array.isArray(entry.boundingbox) && entry.boundingbox.length === 4
    ? [Number(entry.boundingbox[2]), Number(entry.boundingbox[0]), Number(entry.boundingbox[3]), Number(entry.boundingbox[1])]
    : null;
  const address = entry.address && typeof entry.address === 'object' ? entry.address : {};
  return {
    displayName: entry.display_name || entry.name || '',
    name: entry.name || address.village || address.town || address.city || '',
    lat: entry.lat != null ? Number(entry.lat) : null,
    lon: entry.lon != null ? Number(entry.lon) : null,
    category: entry.category || entry.class || '',
    type: entry.type || '',
    importance: entry.importance != null ? Number(entry.importance) : null,
    placeId: entry.place_id ?? null,
    osmType: entry.osm_type || null,
    osmId: entry.osm_id ?? null,
    bounds: b && b.every(Number.isFinite) ? b : null,
    address,
  };
}

/** Forward geocoding. Not autocomplete: Nominatim forbids per-keystroke use. */
async function osmSearch(query, { limit, country } = {}) {
  const text = String(query || '').trim().replace(/\s+/g, ' ');
  if (text.length < 3) { const e = new Error('Enter at least 3 characters to search'); e.status = 400; throw e; }
  if (text.length > 200) { const e = new Error('Search text is too long (200 character limit)'); e.status = 400; throw e; }
  const capped = Math.max(1, Math.min(20, Number(limit) || OSM.maxResults));
  const countries = String(country || '').toLowerCase().replace(/[^a-z,]/g, '').slice(0, 60) || null;
  const params = { q: text, format: 'jsonv2', limit: capped, addressdetails: 1, countrycodes: countries };
  const key = `search:${JSON.stringify(params)}`;
  const hit = osmCacheGet(key);
  if (hit) return { ...hit, cached: true };

  await osmThrottle();
  const raw = await osmGetJson(`${OSM.nominatim.replace(/\/+$/, '')}/search`, params, 'Nominatim');
  if (!Array.isArray(raw)) { const e = new Error('Nominatim returned an unexpected payload'); e.status = 502; throw e; }
  const results = raw.map(osmPlace);
  return osmCacheSet(key, {
    query: text, results, count: results.length,
    provider: 'Nominatim (OpenStreetMap)', attribution: OSM_ATTRIBUTION, licence: 'ODbL 1.0',
    copyrightUrl: OSM_COPYRIGHT, cached: false,
    note: 'Geocoding by Nominatim, the OpenStreetMap search service. Volunteer-mapped data ranked by an importance heuristic - an exact address can rank below a better-known nearby place.',
  });
}

/** Reverse geocoding: name the place at a coordinate (what a map click asks). */
async function osmReverse(lat, lon, zoom = 18) {
  const lat1 = Number(lat); const lon1 = Number(lon);
  if (!Number.isFinite(lat1) || lat1 < -90 || lat1 > 90) { const e = new Error('Latitude must be between -90 and 90'); e.status = 400; throw e; }
  if (!Number.isFinite(lon1) || lon1 < -180 || lon1 > 180) { const e = new Error('Longitude must be between -180 and 180'); e.status = 400; throw e; }
  const level = Math.max(3, Math.min(18, Number(zoom) || 18));
  const params = { lat: lat1.toFixed(7), lon: lon1.toFixed(7), format: 'jsonv2', zoom: level, addressdetails: 1 };
  const key = `reverse:${JSON.stringify(params)}`;
  const hit = osmCacheGet(key);
  if (hit) return { ...hit, cached: true };

  await osmThrottle();
  const raw = await osmGetJson(`${OSM.nominatim.replace(/\/+$/, '')}/reverse`, params, 'Nominatim');
  const place = raw && !raw.error ? osmPlace(raw) : null;
  return osmCacheSet(key, {
    lat: lat1, lon: lon1, zoom: level, place,
    provider: 'Nominatim (OpenStreetMap)', attribution: OSM_ATTRIBUTION, licence: 'ODbL 1.0',
    copyrightUrl: OSM_COPYRIGHT, cached: false,
    note: place
      ? 'Place name and address resolved from OpenStreetMap data by Nominatim.'
      : `OpenStreetMap has no named feature at this point (${(raw && raw.error) || 'no result'}). The coordinate is still valid - it is simply unmapped.`,
  });
}

/** Build the Overpass QL for the requested feature classes. */
function osmOverpassQuery(lat, lon, radiusM, kinds, limit) {
  const lines = ['[out:json][timeout:25];', '('];
  for (const kind of kinds) {
    for (const sel of OSM_FEATURE_KINDS[kind].selectors) {
      lines.push(`  ${sel}(around:${radiusM},${lat.toFixed(6)},${lon.toFixed(6)});`);
    }
  }
  lines.push(');');
  lines.push(`out geom ${limit};`);   // geometry inline: no second round-trip for node references
  return lines.join('\n');
}

/** One Overpass element -> GeoJSON feature (null when it cannot be drawn). */
function osmFeatureElement(el, kind) {
  const tags = el.tags && typeof el.tags === 'object' ? el.tags : {};
  const props = {
    osmId: `${el.type}/${el.id}`, osmType: el.type, kind,
    kindLabel: OSM_FEATURE_KINDS[kind].label,
    label: tags.name || OSM_FEATURE_KINDS[kind].label,
    tags: Object.fromEntries(
      OSM_KEEP_TAGS.filter((k) => tags[k] != null && tags[k] !== '')
        .slice(0, 12).map((k) => [k, String(tags[k]).slice(0, 120)]),
    ),
  };
  let geometry = null;
  if (el.type === 'node') {
    if (el.lat == null || el.lon == null) return null;
    geometry = { type: 'Point', coordinates: [Number(el.lon), Number(el.lat)] };
  } else if (el.type === 'way') {
    const pts = (el.geometry || []).filter((p) => p && p.lat != null && p.lon != null)
      .map((p) => [Number(p.lon), Number(p.lat)]);
    if (pts.length < 2) return null;
    const closed = pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
    geometry = closed ? { type: 'Polygon', coordinates: [pts] } : { type: 'LineString', coordinates: pts };
  } else return null;   // a relation has no single ring; drawing one would misrepresent geometry
  return { type: 'Feature', geometry, properties: props };
}

function osmMatches(kind, tags) {
  if (!tags) return false;
  if (kind === 'roads') return 'highway' in tags;
  if (kind === 'waterways') return 'waterway' in tags;
  if (kind === 'water') return tags.natural === 'water' || tags.landuse === 'reservoir';
  if (kind === 'landuse') return 'landuse' in tags;
  if (kind === 'buildings') return 'building' in tags || tags.man_made === 'storage_tank';
  if (kind === 'barriers') return tags.barrier === 'hedge' || tags.barrier === 'fence';
  return false;
}

/** Real OSM features around a point, as a GeoJSON FeatureCollection. */
async function osmFeatures(lat, lon, { radiusM, kinds, limit } = {}) {
  const lat1 = Number(lat); const lon1 = Number(lon);
  if (!Number.isFinite(lat1) || lat1 < -90 || lat1 > 90) { const e = new Error('Latitude must be between -90 and 90'); e.status = 400; throw e; }
  if (!Number.isFinite(lon1) || lon1 < -180 || lon1 > 180) { const e = new Error('Longitude must be between -180 and 180'); e.status = 400; throw e; }
  const requested = (Array.isArray(kinds) ? kinds : String(kinds || '').split(','))
    .map((k) => String(k).trim()).filter(Boolean);
  const keys = requested.length ? requested : OSM_DEFAULT_KINDS;
  const unknown = keys.filter((k) => !OSM_FEATURE_KINDS[k]);
  if (unknown.length) { const e = new Error(`Unknown feature kind(s): ${unknown.join(', ')}`); e.status = 400; throw e; }
  const wanted = Math.min(OSM.maxRadiusM, Math.max(50, Number(radiusM) || 1000));
  const capped = Math.max(1, Math.min(2000, Number(limit) || OSM.maxFeatures));

  const query = osmOverpassQuery(lat1, lon1, wanted, keys, capped);
  const key = `overpass:${query}`;
  const hit = osmCacheGet(key);
  if (hit) return { ...hit, cached: true };

  await osmThrottle();
  let raw;
  // The public Overpass instance 504s under load. One spaced retry turns a
  // blank layer into a drawn one; a 429 is never retried, because that is the
  // provider asking us to slow down.
  const transient = new Set([500, 502, 503, 504]);
  for (let attempt = 0; ; attempt += 1) {
    osmTelemetry.calls += 1;
    try {
      const res = await fetch(OSM.overpass, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': osmUserAgent(),
        },
        body: new URLSearchParams({ data: query }).toString(),
      });
      if (!res.ok) {
        const failure = new Error(`HTTP ${res.status}`);
        failure.httpStatus = res.status;
        throw failure;
      }
      raw = await res.json();
      osmTelemetry.lastOkAt = nowIso();
      osmTelemetry.lastError = null;
      break;
    } catch (e) {
      const status = e.httpStatus || 0;
      if (attempt === 0 && transient.has(status)) {
        osmTelemetry.lastError = `Overpass API: transient ${status}, retried once`;
        await new Promise((r) => setTimeout(r, OSM.minIntervalMs));
        continue;
      }
      osmTelemetry.lastError = `Overpass API: ${e.message}`;
      const err = new Error(
        `The Overpass API is unreachable or refused the query (${e.message}). Large radii and many feature `
        + 'classes are expensive for a public instance - narrow the request or retry shortly.',
      );
      err.status = 502;
      throw err;
    }
  }
  if (!raw || !Array.isArray(raw.elements)) { const e = new Error('The Overpass API returned an unexpected payload'); e.status = 502; throw e; }

  const features = [];
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  let skipped = 0;
  for (const el of raw.elements) {
    const tags = el && el.tags;
    const matched = keys.find((k) => osmMatches(k, tags));
    if (!matched) { skipped += 1; continue; }
    const feature = osmFeatureElement(el, matched);
    if (!feature) { skipped += 1; continue; }
    features.push(feature);
    counts[matched] += 1;
  }
  return osmCacheSet(key, {
    center: { lat: lat1, lon: lon1 }, radiusM: wanted, kinds: keys,
    kindsAvailable: Object.entries(OSM_FEATURE_KINDS).map(([k, v]) => ({ key: k, label: v.label, style: v.style })),
    geojson: { type: 'FeatureCollection', features },
    featureCount: features.length, counts, skipped, truncated: features.length >= capped,
    provider: 'Overpass API (OpenStreetMap)', attribution: OSM_ATTRIBUTION,
    licence: 'ODbL 1.0', copyrightUrl: OSM_COPYRIGHT, cached: false,
    note: `Real OpenStreetMap features within ${wanted} m, queried live from the Overpass API. OSM is volunteer-mapped: a missing hedge means unmapped, not absent, and field boundaries are far from complete in most regions.`,
  });
}

/** What the OSM integration provides, and under what terms. */
function osmStatus() {
  return {
    enabled: true,
    providers: [
      { name: 'Nominatim', role: 'forward and reverse geocoding', url: OSM.nominatim, licence: 'ODbL 1.0', attribution: OSM_ATTRIBUTION, policy: 'Max 1 request/second plus an identifying User-Agent - both enforced here.' },
      { name: 'Overpass API', role: 'map features as GeoJSON', url: OSM.overpass, licence: 'ODbL 1.0', attribution: OSM_ATTRIBUTION, policy: 'Shared public instance: radius-capped and cached, not streamed per pan.' },
      { name: 'OSM raster tiles', role: 'basemaps', hosts: Object.values(OSM_BASEMAPS).map((b) => b.host), licence: 'ODbL 1.0', attribution: OSM_ATTRIBUTION, policy: OSM_TILE_POLICY },
    ],
    basemaps: Object.entries(OSM_BASEMAPS).map(([key, v]) => ({ key, label: v.label, url: v.url, host: v.host, attribution: v.attr, licence: 'ODbL 1.0', maxZoom: v.maxZoom })),
    featureKinds: Object.entries(OSM_FEATURE_KINDS).map(([key, v]) => ({ key, label: v.label })),
    defaultKinds: OSM_DEFAULT_KINDS,
    limits: {
      minIntervalMs: OSM.minIntervalMs, cacheSeconds: OSM.ttlMs / 1000,
      maxResults: OSM.maxResults, maxRadiusM: OSM.maxRadiusM, maxFeatures: OSM.maxFeatures,
      retryOnceOnGatewayErrors: true, neverRetried: [429],
    },
    lastOkAt: osmTelemetry.lastOkAt, lastError: osmTelemetry.lastError,
    upstreamCalls: osmTelemetry.calls, cachedEntries: osmCache.size,
    note: 'A 5xx from a provider is retried once after a pause; a 429 is never retried. All OpenStreetMap access is server-side, so connect-src stays self and the per-second policy is enforced in one place. Data is OpenStreetMap contributors under ODbL 1.0 - attribution is a licence condition.',
  };
}

/* ═══════════════════════ CP9 · FUSION-READY CONNECTORS ═════════════════════
 * Every connector below fetches a REAL public dataset, keeps its provenance
 * (product, endpoint, attribution, fetch time) and fails loudly: a source that
 * cannot be reached is reported as an error, never replaced by invented data.
 *
 *   Sentinel-2 L2A   optical scenes, Earth Search STAC API (keyless, AWS OD)
 *   Sentinel-1 GRD   C-band SAR scenes, same catalogue - sees through cloud
 *   Elevation/slope  Copernicus DEM through the Open-Meteo elevation API
 *   Weather          Open-Meteo forecast (primary) + NASA POWER (cross-check)
 * ══════════════════════════════════════════════════════════════════════════ */

const SOURCES = {
  'sentinel-2-l2a': {
    id: 'sentinel-2-l2a',
    label: 'Sentinel-2 L2A (optical)',
    kind: 'imagery',
    product: 'Copernicus Sentinel-2 Level-2A surface reflectance, 10-20 m, 5-day revisit',
    endpoint: 'https://earth-search.aws.element84.com/v1/search',
    attribution: 'Contains modified Copernicus Sentinel data',
  },
  'sentinel-1-grd': {
    id: 'sentinel-1-grd',
    label: 'Sentinel-1 GRD (SAR)',
    kind: 'imagery',
    product: 'Copernicus Sentinel-1 C-band ground-range-detected SAR, 10 m, cloud-penetrating',
    endpoint: 'https://earth-search.aws.element84.com/v1/search',
    attribution: 'Contains modified Copernicus Sentinel data',
  },
  'open-meteo-forecast': {
    id: 'open-meteo-forecast',
    label: 'Open-Meteo forecast + soil',
    kind: 'weather',
    product: 'Live forecast, ET0 and soil moisture for the field coordinates',
    endpoint: 'https://api.open-meteo.com/v1/forecast',
    attribution: 'Weather data by Open-Meteo.com',
  },
  'open-meteo-archive': {
    id: 'open-meteo-archive',
    label: 'ERA5 / ERA5-Land reanalysis (any date)',
    kind: 'weather',
    product: 'Daily reanalysis 1940 -> today: temperature, rain, wind, radiation, ET0 and soil moisture',
    endpoint: 'https://archive-api.open-meteo.com/v1/archive',
    attribution: 'Weather data by Open-Meteo.com - Contains modified Copernicus Climate Change Service information',
  },
  'open-meteo-elevation': {
    id: 'open-meteo-elevation',
    label: 'Elevation (Copernicus DEM GLO-90)',
    kind: 'terrain',
    product: '90 m digital elevation model sampled around the field footprint',
    endpoint: 'https://api.open-meteo.com/v1/elevation',
    attribution: 'Elevation data by Open-Meteo.com (Copernicus DEM GLO-90)',
  },
  'nasa-power': {
    id: 'nasa-power',
    label: 'NASA POWER (agrometeorology)',
    kind: 'weather',
    product: 'Daily temperature, precipitation and humidity for cross-validation',
    endpoint: 'https://power.larc.nasa.gov/api/temporal/daily/point',
    attribution: 'NASA POWER (Prediction Of Worldwide Energy Resources)',
  },
};
const SOURCE_IDS = Object.keys(SOURCES);

/* ---- Windy.com: the forecast map, never the numbers ------------------------
 * Windy was asked for and is used here - for the thing it can actually do.
 * Its own Point Forecast documentation rules it out as this app's data source:
 *   · "Point forecast returns exclusively the most recent forecast values. It
 *     is not possible to retrieve historical forecasts with past data"
 *     (https://api.windy.com/point-forecast/pricing) - so no date before today,
 *     by design, in any tier and for any model;
 *   · the free Testing key "Returns randomly shuffled and slightly modified
 *     data ... Development purpose only" - fabricated numbers, which is the one
 *     thing a field console must never present as a reading;
 *   · Professional is 990 EUR/year, excludes ECMWF, and its parameter list has
 *     no solar radiation, no evapotranspiration and no soil moisture - exactly
 *     the variables agronomy needs.
 * So Windy supplies its interactive wind/rain/temperature map centred on the
 * field, and every number keeps coming from the reanalysis archive, which does
 * cover any date back to 1940. Windy's terms require its logo to stay visible
 * and clickable on an embed, so the attribution is part of the payload rather
 * than a line of chrome the UI can quietly drop.
 * ------------------------------------------------------------------------- */
const WINDY = {
  enabled: process.env.VIBES_WINDY_ENABLED !== 'false',
  embedUrl: 'https://embed.windy.com/embed2.html',
  siteUrl: 'https://www.windy.com',
  termsUrl: 'https://account.windy.com/agreements/windy-terms-of-use',
  apiDocsUrl: 'https://api.windy.com/point-forecast/docs',
  apiPricingUrl: 'https://api.windy.com/point-forecast/pricing',
  attribution: 'Weather map by Windy.com',
  // Windy's own documented overlay identifiers; the labels and units are ours.
  // These are the layers agronomy actually reads, wind and rain first.
  overlays: [
    { key: 'wind', label: 'Wind', unit: 'km/h' },
    { key: 'gust', label: 'Gusts', unit: 'km/h' },
    { key: 'rain', label: 'Rain', unit: 'mm' },
    { key: 'temp', label: 'Temperature', unit: '\u00b0C' },
    { key: 'rh', label: 'Humidity', unit: '%' },
    { key: 'clouds', label: 'Clouds', unit: '%' },
    { key: 'pressure', label: 'Pressure', unit: 'hPa' },
  ],
  defaultOverlay: 'wind',
  licenceNote: "Windy's terms require the Windy logo to stay visible and clickable wherever the embed appears, and describe widgets as intended for media use rather than commercial sites - so this map is on only while VIBES_WINDY_ENABLED is not false, and the attribution travels with it.",
};
WINDY.overlayKeys = WINDY.overlays.map((o) => o.key);

/**
 * Windy's documented embed URL for one point and one overlay. Pure, so the
 * suite can assert the URL shape without a browser or the network.
 * An unknown overlay falls back to the default instead of building a map that
 * silently shows something else than was asked for.
 */
function windyEmbedUrl({ lat, lon, overlay, zoom = 12, width = 960, height = 520 }) {
  const key = WINDY.overlayKeys.includes(overlay) ? overlay : WINDY.defaultOverlay;
  const q = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
    detailLat: lat.toFixed(4),
    detailLon: lon.toFixed(4),
    width: String(width),
    height: String(height),
    zoom: String(zoom),
    level: 'surface',
    overlay: key,
    menu: '',
    message: '',
    marker: 'true',
    calendar: 'now',
    pressure: '',
    type: 'map',
    location: 'coordinates',
    detail: '',
    metricWind: 'default',
    metricTemp: 'default',
    radarRange: '-1',
  });
  return `${WINDY.embedUrl}?${q.toString()}`;
}

const sourceCache = new Map();   // cache key -> { t, data }
const sourceLastFetch = {};      // sourceId -> ISO timestamp of the last real fetch
const SOURCE_TTL_MS = 30 * 60 * 1000;

const touchSource = (id) => { sourceLastFetch[id] = nowIso(); };
const provFor = (id) => ({
  source: id,
  label: SOURCES[id].label,
  endpoint: SOURCES[id].endpoint,
  attribution: SOURCES[id].attribution,
});

function cacheGet(key, ttlMs = SOURCE_TTL_MS) {
  const hit = sourceCache.get(key);
  return hit && Date.now() - hit.t < ttlMs ? hit.data : null;
}
function cacheSet(key, data) { sourceCache.set(key, { t: Date.now(), data }); return data; }

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** JSON over HTTP with a timeout and a readable error (fetch hides the cause). */
async function fetchJson(url, { method = 'GET', body, timeoutMs = 25000, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 160)}`);
    try { return JSON.parse(text); } catch { throw new Error('response was not JSON'); }
  } catch (e) {
    throw new Error([e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(' - ') || 'request failed');
  } finally { clearTimeout(timer); }
}

/* ---- Sentinel scenes through the STAC catalogue ----------------------------- */
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const ymdDash = (d) => d.toISOString().slice(0, 10);
const STAC_COLLECTIONS = ['sentinel-2-l2a', 'sentinel-1-grd'];

/** Real Sentinel scene search (optical or SAR) for one point AOI. */
async function searchSentinel({ lat, lon, collection = 'sentinel-2-l2a', days = 90, maxCloud = 60, limit = 8 }) {
  if (!STAC_COLLECTIONS.includes(collection)) throw Object.assign(new Error(`unsupported collection ${collection}`), { status: 400 });
  const key = `stac:${collection}:${lat.toFixed(4)},${lon.toFixed(4)}:${days}:${maxCloud}:${limit}`;
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };

  const from = new Date(Date.now() - days * 86400000);
  const to = new Date(Date.now() + 3 * 86400000);
  const body = {
    collections: [collection],
    intersects: { type: 'Point', coordinates: [+lon.toFixed(6), +lat.toFixed(6)] },
    datetime: `${ymdDash(from)}T00:00:00Z/${ymdDash(to)}T23:59:59Z`,
    limit: Math.max(1, Math.min(20, limit)),
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  };
  if (collection === 'sentinel-2-l2a') body.query = { 'eo:cloud_cover': { lt: maxCloud } };

  const raw = await fetchJson(SOURCES[collection].endpoint, { method: 'POST', body });
  touchSource(collection);
  const scenes = (raw.features || []).map((f) => {
    const p = f.properties || {};
    return {
      id: f.id,
      datetime: p.datetime || null,
      platform: p.platform || null,
      cloudCover: p['eo:cloud_cover'] ?? null,
      gridCode: p['grid:code'] || null,
      bbox: f.bbox || null,
      thumbnail: f.assets?.thumbnail?.href || f.assets?.visual?.href || null,
      stacItem: `https://earth-search.aws.element84.com/v1/collections/${collection}/items/${f.id}`,
    };
  });
  // SAR scenes carry no cloud cover, so both cloud aggregates stay null there.
  const clouds = scenes.map((s) => s.cloudCover).filter((v) => v != null);
  const out = {
    collection,
    collectionLabel: SOURCES[collection].label,
    count: scenes.length,
    scenes,
    leastCloudy: scenes.filter((s) => s.cloudCover != null).sort((a, b) => a.cloudCover - b.cloudCover)[0] || null,
    meanCloudPct: clouds.length ? +avg(clouds).toFixed(1) : null,
    window: { days, from: ymdDash(from), to: ymdDash(to) },
    provenance: provFor(collection),
    fetchedAt: nowIso(),
    cached: false,
  };
  return cacheSet(key, out);
}

/* ---- Terrain: elevation + derived slope ------------------------------------ */
async function fetchTerrain(field) {
  const g = field?.gps;
  if (!g || g.lat == null || g.lon == null) throw Object.assign(new Error('field has no GPS georeference'), { status: 409 });
  const geo = fieldGeometry(field);
  const widthM = geo.widthM || CONFIG.fieldSizeHintM;
  const heightM = geo.heightM || widthM;
  const key = `elev:${g.lat.toFixed(4)},${g.lon.toFixed(4)}:${Math.round(widthM)}x${Math.round(heightM)}`;
  const hit = cacheGet(key, 6 * 60 * 60 * 1000);
  if (hit) return { ...hit, cached: true };

  const dLat = heightM / 2 / metersPerDegLat();
  const dLon = widthM / 2 / metersPerDegLon(g.lat);
  const pts = [
    { role: 'centre', lat: g.lat, lon: g.lon },
    { role: 'north', lat: g.lat + dLat, lon: g.lon },
    { role: 'south', lat: g.lat - dLat, lon: g.lon },
    { role: 'east', lat: g.lat, lon: g.lon + dLon },
    { role: 'west', lat: g.lat, lon: g.lon - dLon },
  ];
  const url = `${SOURCES['open-meteo-elevation'].endpoint}?latitude=${pts.map((p) => p.lat.toFixed(6)).join(',')}&longitude=${pts.map((p) => p.lon.toFixed(6)).join(',')}`;
  const j = await fetchJson(url);
  touchSource('open-meteo-elevation');
  const ele = Array.isArray(j.elevation) ? j.elevation.map(Number) : [];
  if (ele.length !== pts.length || ele.some((v) => !Number.isFinite(v))) throw new Error('elevation response incomplete');

  const [centre, north, south, east, west] = ele;
  const dzNS = north - south, dzEW = east - west;
  const grad = Math.sqrt((dzNS / heightM) ** 2 + (dzEW / widthM) ** 2);
  const out = {
    samples: pts.map((p, i) => ({ role: p.role, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), elevationM: ele[i] })),
    elevationM: centre,
    reliefM: +(Math.max(...ele) - Math.min(...ele)).toFixed(2),
    slopePct: +(grad * 100).toFixed(2),
    slopeDeg: +((Math.atan(grad) * 180) / Math.PI).toFixed(2),
    aspectDeg: +((((Math.atan2(dzEW, dzNS) * 180) / Math.PI) + 360) % 360).toFixed(1),
    drainage: grad * 100 < 1 ? 'flat - ponding risk' : grad * 100 < 5 ? 'gentle - well drained' : 'sloped - runoff risk',
    provenance: provFor('open-meteo-elevation'),
    fetchedAt: nowIso(),
    cached: false,
  };
  return cacheSet(key, out);
}

/* ---- Weather cross-validation: Open-Meteo vs NASA POWER -------------------- */
async function crossCheckWeather(field) {
  const g = field?.gps;
  if (!g || g.lat == null || g.lon == null) throw Object.assign(new Error('field has no GPS georeference'), { status: 409 });
  const key = `xc:${g.lat.toFixed(3)},${g.lon.toFixed(3)}`;
  const hit = cacheGet(key, 60 * 60 * 1000);
  if (hit) return { ...hit, cached: true };

  const omDaily = await fetchJson(`${SOURCES['open-meteo-forecast'].endpoint}?latitude=${g.lat}&longitude=${g.lon}`
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&past_days=8&forecast_days=0&timezone=UTC');
  touchSource('open-meteo-forecast');
  const power = await fetchJson(`${SOURCES['nasa-power'].endpoint}?parameters=T2M,PRECTOTCORR,RH2M`
    + `&community=AG&longitude=${g.lon}&latitude=${g.lat}&start=${ymd(new Date(Date.now() - 6 * 86400000))}&end=${ymd(new Date())}&format=JSON`,
    { timeoutMs: 30000 });
  touchSource('nasa-power');

  const par = power?.properties?.parameter;
  if (!par || !par.T2M) throw new Error('NASA POWER returned no parameter block');

  // NASA POWER writes a fill sentinel (-999 by default) for days it has not
  // processed yet - typically the last one or two. Averaging those in would
  // produce absurd numbers, so every value is filtered and the two sources are
  // compared ONLY over days where both report real data.
  const fill = Number(power?.header?.fill_value ?? -999);
  const real = (v) => Number.isFinite(v) && v !== fill && v > fill + 1;
  const cleanMap = (obj) => {
    const outMap = {};
    for (const [k, v] of Object.entries(obj || {})) { const n = Number(v); if (real(n)) outMap[k] = n; }
    return outMap;
  };
  const pwT = cleanMap(par.T2M), pwR = cleanMap(par.PRECTOTCORR), pwH = cleanMap(par.RH2M);

  const d = omDaily.daily || {};
  const om = (d.time || []).map((t, i) => ({
    date: String(t).replace(/-/g, ''),
    day: t,
    tMax: Number.isFinite(Number(d.temperature_2m_max?.[i])) ? Number(d.temperature_2m_max[i]) : null,
    tMin: Number.isFinite(Number(d.temperature_2m_min?.[i])) ? Number(d.temperature_2m_min[i]) : null,
    rainMm: Number.isFinite(Number(d.precipitation_sum?.[i])) ? Number(d.precipitation_sum[i]) : null,
  }));
  const tempDays = om.filter((x) => x.tMax != null && x.tMin != null && pwT[x.date] != null);
  const rainDays = om.filter((x) => x.rainMm != null && pwR[x.date] != null);
  if (!tempDays.length) throw new Error('no complete day in the window is reported by both Open-Meteo and NASA POWER');

  const omMeanTemp = +avg(tempDays.map((x) => (x.tMax + x.tMin) / 2)).toFixed(2);
  const pwMeanTemp = +avg(tempDays.map((x) => pwT[x.date])).toFixed(2);
  const omRainSum = +sum(rainDays.map((x) => x.rainMm)).toFixed(2);
  const pwRainSum = +sum(rainDays.map((x) => pwR[x.date])).toFixed(2);
  const pwRhValues = Object.values(pwH);
  const deltaTempC = +(omMeanTemp - pwMeanTemp).toFixed(2);
  const deltaRainMm = +(omRainSum - pwRainSum).toFixed(2);
  const out = {
    days: tempDays.length,
    rainDays: rainDays.length,
    window: { from: tempDays[0].day, to: tempDays[tempDays.length - 1].day },
    skippedDays: {
      openMeteoMissing: om.length - tempDays.length,
      nasaPowerNotYetProcessed: om.length - Object.keys(pwT).length,
    },
    primary: { source: 'open-meteo', meanTempC: omMeanTemp, rainSumMm: omRainSum, daily: om },
    crosscheck: {
      source: 'nasa-power',
      meanTempC: pwMeanTemp,
      rainSumMm: pwRainSum,
      meanHumidityPct: pwRhValues.length ? +avg(pwRhValues).toFixed(1) : null,
      days: Object.keys(pwT).length,
      fillValue: fill,
    },
    delta: { meanTempC: deltaTempC, rainSumMm: deltaRainMm },
    agreement: Math.abs(deltaTempC) <= 3 && Math.abs(deltaRainMm) <= 5 ? 'close' : 'divergent',
    note: `Compared only the ${tempDays.length} days both sources report; NASA POWER lags real time and marks unprocessed days with its ${fill} fill value.`,
    provenance: [provFor('open-meteo-forecast'), provFor('nasa-power')],
    fetchedAt: nowIso(),
    cached: false,
  };
  return cacheSet(key, out);
}

/* ═══════════════════════ DEVICE LOCATION — the real fix ═══════════════════
 * The truest coordinate this console can hold is where the device actually is.
 * A fix arrives from the browser (navigator.geolocation), is validated here,
 * persisted once, and then every location-scoped read - live weather, the
 * reanalysis archive, Sentinel-2 scenes, terrain, OpenStreetMap context and the
 * forecast map - is fetched for that real point instead of for a coordinate
 * somebody typed into a form.
 *
 * Three rules the rest of the file depends on:
 *   · nothing is invented. With no fix stored and none supplied, these routes
 *     answer 404/409 rather than falling back to a default coordinate, because
 *     a plausible-looking number for the wrong place is worse than an honest
 *     "I do not know where you are".
 *   · (0, 0) is rejected. It is what a GPS stack returns when it has no fix at
 *     all (Null Island), and no field is there.
 *   · a moved fix is persisted, an unmoved one is not: a device watching its
 *     position must not turn a one-hertz GPS stream into a one-hertz writer.
 * ══════════════════════════════════════════════════════════════════════════ */

const LOCATION_STORE = 'location.json';
const LOCATION_MOVE_EPSILON_M = 5;       // under this, the stored fix stands
const LOCATION_MAX_ACCURACY_M = 100_000; // past this a "fix" is not a location
const LOCATION_STALE_AFTER_S = 900;      // 15 minutes

let deviceLocation = loadJSON(LOCATION_STORE, null) || null;
let locationLiveCache = null;            // last live bundle, memory only

const EARTH_R_M = 6_371_000;
/** Great-circle metres between two WGS84 points. */
function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Validate one incoming device fix. Pure, so the suite can walk the boundaries
 * - Null Island, the poles, the antimeridian, an absurd accuracy claim - without
 * a browser or the network. Returns { fix } or { error }.
 */
function locationFix(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  // Numbers only - not `true`, not an object, not an array. Number(true) is 1,
  // so a loose coercion would quietly turn a buggy client into a fix at (1, 1).
  const numeric = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
    return null;
  };
  const lat = numeric(src.lat);
  const lon = numeric(src.lon);
  if (lat === null || lon === null) {
    return { error: 'lat and lon are required and must be finite WGS84 degrees.' };
  }
  if (lat < -90 || lat > 90) return { error: `lat must be between -90 and 90, got ${lat}.` };
  if (lon < -180 || lon > 180) return { error: `lon must be between -180 and 180, got ${lon}.` };
  if (lat === 0 && lon === 0) {
    return { error: 'lat 0 / lon 0 is the coordinate a GPS stack returns when it has no fix at all (Null Island); no site is reported there. Take a fresh reading or place the point yourself.' };
  }

  const has = (v) => v !== null && v !== undefined && v !== '';
  const accRaw = src.accuracyM ?? src.accuracy;
  const acc = has(accRaw) ? numeric(accRaw) : null;
  if (has(accRaw) && acc === null) return { error: 'accuracyM must be a number of metres.' };
  if (acc != null) {
    if (acc < 0) return { error: 'accuracyM must be a non-negative number of metres.' };
    if (acc > LOCATION_MAX_ACCURACY_M) {
      return { error: `accuracyM of ${acc} m is not a location - that is a network-estimated city, not a device fix.` };
    }
  }
  const altRaw = src.altitudeM ?? src.altitude;
  const alt = has(altRaw) ? numeric(altRaw) : null;
  if (has(altRaw) && alt === null) return { error: 'altitudeM must be a number of metres.' };
  if (alt != null && (alt < -500 || alt > 12000)) {
    return { error: 'altitudeM must be between -500 m and 12000 m when supplied.' };
  }

  let capturedAt = null;
  if (src.capturedAt) {
    const t = Date.parse(src.capturedAt);
    if (!Number.isFinite(t)) return { error: 'capturedAt must be an ISO 8601 timestamp when supplied.' };
    capturedAt = new Date(t).toISOString();
  }
  const label = typeof src.label === 'string' ? src.label.trim().slice(0, 80) || null : null;

  return {
    fix: {
      lat: +lat.toFixed(7),
      lon: +lon.toFixed(7),
      accuracyM: acc == null ? null : +acc.toFixed(1),
      altitudeM: alt == null ? null : +alt.toFixed(1),
      capturedAt: capturedAt || nowIso(),
      source: 'device',
      label,
      place: null,
    },
  };
}

/** The nearest georeferenced field to a point, so the console can say how far. */
function nearestFieldTo(lat, lon) {
  let best = null;
  for (const f of Object.values(fields)) {
    if (!f.gps || f.gps.lat == null || f.gps.lon == null) continue;
    const m = haversineM(lat, lon, f.gps.lat, f.gps.lon);
    if (!best || m < best.metres) best = { fieldId: f.fieldId, metres: m, kilometres: +(m / 1000).toFixed(2) };
  }
  return best ? { fieldId: best.fieldId, kilometres: best.kilometres } : null;
}

/** Persist a fix - but only when it has genuinely moved. */
function setDeviceLocation(fix) {
  const prev = deviceLocation;
  const movedM = prev ? +haversineM(prev.lat, prev.lon, fix.lat, fix.lon).toFixed(1) : null;
  const significant = !prev || (movedM != null && movedM > LOCATION_MOVE_EPSILON_M);
  deviceLocation = {
    ...fix,
    // A re-fix on the same spot keeps the place we already resolved and the
    // time we first saw it, so a watching device cannot churn the store with
    // its own jitter - and the console keeps showing the same real place name.
    place: significant ? null : (prev?.place || null),
    firstSeenAt: significant ? nowIso() : (prev?.firstSeenAt || nowIso()),
    storedAt: nowIso(),
  };
  if (significant) {
    locationLiveCache = null;
    saveJSON(LOCATION_STORE, deviceLocation);
  }
  return { movedM, significant };
}

function clearDeviceLocation() {
  const had = !!deviceLocation;
  deviceLocation = null;
  locationLiveCache = null;
  try { fs.rmSync(path.join(DATA_DIR, LOCATION_STORE), { force: true }); } catch {}
  return had;
}

/** Owner view of the stored fix: age, staleness, real place, nearest site. */
function locationPublic(loc = deviceLocation) {
  if (!loc) return null;
  const since = Date.parse(loc.storedAt || loc.capturedAt || '') || Date.now();
  const ageSeconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return {
    lat: loc.lat,
    lon: loc.lon,
    coordinatesText: `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`,
    accuracyM: loc.accuracyM ?? null,
    altitudeM: loc.altitudeM ?? null,
    source: loc.source || 'device',
    label: loc.label || null,
    place: loc.place || null,
    capturedAt: loc.capturedAt || null,
    firstSeenAt: loc.firstSeenAt || null,
    storedAt: loc.storedAt || null,
    ageSeconds,
    stale: ageSeconds > LOCATION_STALE_AFTER_S,
    staleAfterSeconds: LOCATION_STALE_AFTER_S,
    nearestField: nearestFieldTo(loc.lat, loc.lon),
    liveFetchedAt: locationLiveCache?.fetchedAt || null,
    origin: 'navigator.geolocation on this device, validated and persisted by the server',
  };
}

/**
 * Which point a location-scoped read should use: explicit coordinates first,
 * then the stored device fix. Returns an error instead of a guessed point, so
 * no route can quietly answer for somewhere the caller never asked about.
 */
function resolveLocation(req) {
  const q = (req && req.query) || {};
  if (q.lat !== undefined && q.lat !== '' && q.lon !== undefined && q.lon !== '') {
    const { fix, error } = locationFix({ lat: q.lat, lon: q.lon, accuracyM: q.accuracy_m });
    if (error) return { status: 400, error: 'BadRequest', detail: error };
    return { lat: fix.lat, lon: fix.lon, origin: 'query' };
  }
  if (deviceLocation) return { lat: deviceLocation.lat, lon: deviceLocation.lon, origin: 'stored' };
  return {
    status: 409,
    error: 'NoLocation',
    detail: 'No device location is stored. Grant the browser location permission and POST the fix to /api/location, or pass lat and lon explicitly.',
  };
}

/** Run one provider for the live bundle without letting it take the rest down. */
async function livePart(key, fn) {
  try { return { key, ok: true, value: await fn() }; }
  catch (e) { return { key, ok: false, error: (e && e.message) || String(e) }; }
}

/**
 * Everything this console can truthfully say about one real point, in one call.
 *
 * Every provider is asked in parallel and each part carries its own error, so a
 * single dead upstream (NASA POWER lags real time and is the usual one) leaves
 * the rest of the panel populated instead of blanking it. There is no
 * simulation and no default value anywhere in here: a part that fails is
 * reported as failed, with the provider's own message.
 */
async function liveLocationBundle(lat, lon, { days = 30, radiusM = 1000 } = {}) {
  const end = todayIso();
  const start = addDays(end, -6);
  // Terrain and the cross-check read a field-shaped object. This one carries no
  // imagery at all, which is the point: the fix itself is the site.
  const site = {
    fieldId: 'device-location',
    gps: { lat: +lat, lon: +lon, source: 'device' },
    groundWidthM: CONFIG.fieldSizeHintM,
  };

  const parts = await Promise.all([
    livePart('weather', () => fetchRealWeather(+lat, +lon)),
    livePart('place', () => osmReverse(+lat, +lon, 16)),
    livePart('archive', () => fetchWeatherHistory(+lat, +lon, start, end)),
    livePart('scenes', () => searchSentinel({ lat: +lat, lon: +lon, days, limit: 5, maxCloud: 40 })),
    livePart('terrain', () => fetchTerrain(site)),
    livePart('context', () => osmFeatures(+lat, +lon, { radiusM, kinds: OSM_DEFAULT_KINDS, limit: 200 })),
    livePart('crosscheck', () => crossCheckWeather(site)),
  ]);
  const by = Object.fromEntries(parts.map((p) => [p.key, p]));
  const val = (k) => (by[k] && by[k].ok ? by[k].value : null);

  const osm = val('context');
  const features = osm?.geojson?.features || [];
  // Only genuinely named features: osmFeatureElement falls back to the kind's
  // own label, and listing "Roads and tracks" as a nearby place name would be
  // noise dressed up as context.
  const named = [];
  for (const f of features) {
    const label = f.properties?.tags?.name;
    if (label && named.length < 12) named.push({ kind: f.properties.kindLabel || f.properties.kind, label });
  }

  const archive = val('archive');
  const week = archive?.days || [];
  const scenes = val('scenes');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  return {
    lat: +(+lat).toFixed(7),
    lon: +(+lon).toFixed(7),
    coordinatesText: `${(+lat).toFixed(5)}, ${(+lon).toFixed(5)}`,
    weather: val('weather'),
    place: val('place')?.place || null,
    placeNote: val('place')?.note || null,
    archive: archive ? {
      window: archive.window,
      days: week.length,
      rainMm: +sum(week.map((d) => num(d.precipitationMm))).toFixed(1),
      et0Mm: +sum(week.map((d) => num(d.et0Mm))).toFixed(1),
      soilMoisturePct: [...week].reverse().find((d) => d.soilMoisturePct != null)?.soilMoisturePct ?? null,
      last: week[week.length - 1] || null,
      warnings: archive.warnings || [],
      provenance: archive.provenance || null,
    } : null,
    scenes: scenes ? {
      collection: scenes.collection,
      collectionLabel: scenes.collectionLabel,
      count: scenes.count,
      window: scenes.window,
      latest: scenes.scenes?.[0] || null,
      leastCloudy: scenes.leastCloudy,
      meanCloudPct: scenes.meanCloudPct,
      provenance: scenes.provenance,
    } : null,
    terrain: val('terrain'),
    context: osm ? {
      total: features.length,
      byKind: osm.counts || {},
      named,
      // Overpass is asked for a bounded page; when it fills, say so rather than
      // letting a 200-feature page read as a complete survey of the area.
      truncated: !!osm.truncated,
      skipped: osm.skipped ?? null,
      radiusM: osm.radiusM || radiusM,
      attribution: osm.attribution || null,
      licence: osm.licence || null,
      note: osm.note || null,
    } : null,
    crosscheck: val('crosscheck'),
    errors: parts.filter((p) => !p.ok).map((p) => ({ part: p.key, error: p.error })),
    partsOk: parts.filter((p) => p.ok).length,
    partsTotal: parts.length,
    fetchedAt: nowIso(),
  };
}

/** The stored fix, or 404 - never a default coordinate. */
app.get('/api/location', (_req, res) => {
  const loc = locationPublic();
  if (!loc) {
    return res.status(404).json({
      error: 'NoLocation',
      detail: 'No device location has been stored yet. Ask the browser for one (navigator.geolocation) and POST it to /api/location.',
    });
  }
  res.json({ ...loc, live: locationLiveCache || null });
});

/**
 * Store a fix from the device.
 *
 * Deliberately does NOT call a provider: it validates and persists what the
 * device reported, so the console knows where it is even with every upstream
 * down. Enrichment (the place name, the live numbers) happens in
 * GET /api/location/live.
 */
app.post('/api/location', limitHeavy('location', 120), (req, res) => {
  const { fix, error } = locationFix(req.body || {});
  if (error) return res.status(400).json({ error: 'BadRequest', detail: error });
  const { movedM, significant } = setDeviceLocation(fix);
  const loc = locationPublic();
  // Broadcasting even an unmoved fix is intentional: a second console should
  // learn that this device is still here, right now.
  sseSend('location-updated', { location: loc, movedM, stored: significant });
  res.json({ ok: true, stored: significant, movedM, location: loc });
});

/** Forget the fix (a moved laptop, a shared console, a wrong reading). */
app.delete('/api/location', (req, res) => {
  const had = clearDeviceLocation();
  if (had) sseSend('location-cleared', {});
  res.json({ ok: true, cleared: had });
});

/**
 * Every real provider, for the stored fix or for explicit coordinates.
 * The place name is written back onto the stored fix so the next client - and
 * every other console on the LAN - reads the same real location, not a bare
 * pair of numbers.
 */
app.get('/api/location/live', async (req, res) => {
  const target = resolveLocation(req);
  if (target.error) return res.status(target.status).json({ error: target.error, detail: target.detail });
  try {
    const bundle = await liveLocationBundle(target.lat, target.lon, {
      days: Math.max(1, Math.min(365, +req.query.days || 30)),
      radiusM: Math.max(50, Math.min(OSM.maxRadiusM, +req.query.radius_m || 1000)),
    });
    const out = { ...bundle, origin: target.origin, time: nowIso() };
    if (target.origin === 'stored') {
      locationLiveCache = out;
      if (deviceLocation && bundle.place && deviceLocation.place !== bundle.place) {
        deviceLocation.place = bundle.place;
        saveJSON(LOCATION_STORE, deviceLocation);
      }
    }
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

/* ---- Source registry ------------------------------------------------------- */
app.get('/api/sources', (_req, res) => {
  res.json({
    count: SOURCE_IDS.length,
    cachedEntries: sourceCache.size,
    sources: SOURCE_IDS.map((id) => ({ ...SOURCES[id], lastFetchedAt: sourceLastFetch[id] || null })),
    // Kept separate from `sources` on purpose: a source answers with numbers,
    // Windy answers with a map. Filing it under the data sources would imply
    // it can back a value, and it cannot - it publishes no archive at all.
    visualizations: [{
      id: 'windy',
      label: WINDY.attribution,
      kind: 'forecast-map',
      enabled: WINDY.enabled,
      endpoint: WINDY.embedUrl,
      attribution: WINDY.attribution,
      attributionUrl: WINDY.siteUrl,
      termsUrl: WINDY.termsUrl,
      overlays: WINDY.overlays,
      note: 'Windy draws live forecast layers only: it publishes no archive ("It is not possible to retrieve historical forecasts with past data"), its free testing key returns randomly shuffled data, and its paid tier carries neither solar radiation nor evapotranspiration nor soil moisture. Every number in this console therefore comes from the reanalysis archive, which reaches 1940.',
    }],
  });
});

/** The Windy forecast map for one field - live model layers, never an archive. */
app.get('/api/weather/windy', (req, res) => {
  const field = req.query.fieldId ? fields[String(req.query.fieldId)] : null;
  if (req.query.fieldId && !field) return res.status(404).json({ error: 'Field not found' });
  if (!WINDY.enabled) {
    return res.status(503).json({ error: 'The Windy forecast map is switched off (VIBES_WINDY_ENABLED=false).' });
  }
  // Priority: explicit coordinates, then the field, then the stored device fix -
  // so a console that has just read its own position frames the map over the
  // place it is actually standing in rather than over nothing.
  const lat = req.query.lat != null && req.query.lat !== '' ? Number(req.query.lat)
    : (field?.gps?.lat ?? deviceLocation?.lat);
  const lon = req.query.lon != null && req.query.lon !== '' ? Number(req.query.lon)
    : (field?.gps?.lon ?? deviceLocation?.lon);
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(409).json({ error: 'a georeferenced field is needed - ingest imagery with EXIF GPS, set a manual geotag, or store a device location first.' });
  }
  // Same bounds the geotag endpoint enforces: a map of latitude 999 is not a
  // legitimate request, it is a bug worth reporting rather than rendering.
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'lat and lon must be valid WGS84 coordinates.' });
  }
  const requested = String(req.query.overlay || WINDY.defaultOverlay);
  const overlay = WINDY.overlayKeys.includes(requested) ? requested : WINDY.defaultOverlay;
  const zoom = Math.max(3, Math.min(18, Number(req.query.zoom) || 12));
  res.json({
    fieldId: field ? field.fieldId : null,
    centre: { lat: +lat.toFixed(4), lon: +lon.toFixed(4) },
    overlay,
    // An unrecognised layer is reported rather than silently swapped.
    requestedOverlay: requested,
    overlays: WINDY.overlays,
    embedUrl: WINDY.embedUrl,
    url: windyEmbedUrl({ lat, lon, overlay, zoom }),
    coverage: {
      kind: 'forecast-map',
      liveOnly: true,
      archive: false,
      from: 'now',
      note: 'Windy renders live forecast layers only and holds no archive, so this map cannot show a past date. For any date back to 1940 use the weather history instead - that is where the numbers in this console come from.',
    },
    attribution: WINDY.attribution,
    attributionUrl: WINDY.siteUrl,
    termsUrl: WINDY.termsUrl,
    licenceNote: WINDY.licenceNote,
    references: { apiDocs: WINDY.apiDocsUrl, apiPricing: WINDY.apiPricingUrl },
    fetchedAt: nowIso(),
  });
});

app.get('/api/fields/:id/satellite', async (req, res) => {
  const f = fields[req.params.id];
  if (!f) return res.status(404).json({ error: 'Field not found' });
  const g = f.gps;
  if (!g || g.lat == null) return res.status(409).json({ error: 'Field has no GPS georeference - ingest imagery with EXIF GPS or set a manual geotag first.' });
  try {
    const out = await searchSentinel({
      lat: g.lat, lon: g.lon,
      collection: req.query.collection || 'sentinel-2-l2a',
      days: Math.max(1, Math.min(365, +req.query.days || 90)),
      maxCloud: Math.max(0, Math.min(100, +req.query.maxCloud ?? 60)),
      limit: Math.max(1, Math.min(20, +req.query.limit || 8)),
    });
    res.json({ fieldId: f.fieldId, ...out });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

/* ═══════════ AREA OF INTEREST: a drawn polygon → satellite, weather, advice ═══════════
 * The user marks points on the map; the polygon is validated here, then real
 * Sentinel-2 pixels inside it are read and summarised (see lib/aoi-satellite.js).
 * Advice comes from lib/agronomy-wheat.js using those indices, live weather and
 * any soil lab values the user enters. Lab values are never invented here. */
const AOI_DIR = path.join(DATA_DIR, 'aoi');
const AOI_TTL_MS = 6 * 60 * 60 * 1000;
const AOI_ID_RE = /^aoi-[a-f0-9]{12}$/;
const SOIL_KEYS = ['ph', 'organicCarbonPct', 'nitrogenKgHa', 'olsenPPm', 'exchangeableKPm', 'zincDtpaPpm'];

/** Keep only finite numeric soil lab values; anything else is dropped, not guessed. Pure. */
function sanitizeSoil(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const k of SOIL_KEYS) {
    const v = Number(input[k]);
    if (input[k] !== '' && input[k] != null && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  if (out.ph != null && out.ph > 14) delete out.ph;
  return Object.keys(out).length ? out : null;
}

/** Tomorrow-onwards forecast summary the advisor needs: 7-day rain and coldest night. */
async function fetchForecastSummary(lat, lon) {
  const key = `fcst:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cacheGet(key, 30 * 60 * 1000);
  if (hit) return hit;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&daily=precipitation_sum,temperature_2m_min&forecast_days=7&timezone=auto';
  const j = await fetchJson(url, { timeoutMs: 15000 });
  const d = j.daily || {};
  const rain = Array.isArray(d.precipitation_sum) ? d.precipitation_sum.filter(Number.isFinite) : [];
  const mins = Array.isArray(d.temperature_2m_min) ? d.temperature_2m_min.filter(Number.isFinite) : [];
  return cacheSet(key, {
    rainNext7dMm: rain.length ? +rain.reduce((a, b) => a + b, 0).toFixed(1) : null,
    tempMinC: mins.length ? Math.min(...mins) : null,
    source: 'open-meteo',
  });
}

/** Live + forecast weather at the area centre, each piece optional. */
async function weatherForArea(lat, lon) {
  const out = { live: null, forecast: null, errors: [] };
  try { out.live = await fetchRealWeather(lat, lon); } catch (e) { out.errors.push(`live weather: ${e.message}`); }
  try { out.forecast = await fetchForecastSummary(lat, lon); } catch (e) { out.errors.push(`forecast: ${e.message}`); }
  return out;
}

function readAoi(id) {
  if (!AOI_ID_RE.test(String(id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(AOI_DIR, `${id}.json`), 'utf8')); } catch { return null; }
}

/** Persist one analysis: meta JSON plus the two PNGs. */
function storeAoi(record, trueRgba, ndviRgba, W, H) {
  fs.mkdirSync(AOI_DIR, { recursive: true });
  fs.writeFileSync(path.join(AOI_DIR, `${record.id}-true.png`), encodePng(W, H, trueRgba));
  fs.writeFileSync(path.join(AOI_DIR, `${record.id}-ndvi.png`), encodePng(W, H, ndviRgba));
  const tmp = path.join(AOI_DIR, `${record.id}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, path.join(AOI_DIR, `${record.id}.json`));
}

app.post('/api/aoi/analyze', limitHeavy('aoi', 12), async (req, res) => {
  const v = aoiSat.validatePolygon(req.body?.points);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const soil = sanitizeSoil(req.body?.soil);
  const ringKey = crypto.createHash('sha1')
    .update(JSON.stringify(v.ring.map((p) => [p[0].toFixed(5), p[1].toFixed(5)])))
    .digest('hex');
  try {
    let record = cacheGet(`aoi:${ringKey}`, AOI_TTL_MS);
    let cached = true;
    if (!record || !fs.existsSync(path.join(AOI_DIR, `${record.id}-ndvi.png`))) {
      cached = false;
      const r = await aoiSat.analyseArea({ ring: v.ring, fetchJson });
      if (!r.ok) return res.status(422).json({ error: r.message, status: r.status });
      const cLat = v.ring.reduce((s, p) => s + p[0], 0) / v.ring.length;
      const cLon = v.ring.reduce((s, p) => s + p[1], 0) / v.ring.length;
      const { W, H } = r.grid;
      const rgba = aoiSat.renderRgba(r.renderGrid, W, H);
      const id = `aoi-${crypto.randomBytes(6).toString('hex')}`;
      record = {
        id,
        createdAt: nowIso(),
        centroid: { lat: +cLat.toFixed(6), lon: +cLon.toFixed(6) },
        ring: v.ring,
        areaM2: Math.round(v.areaM2),
        scene: r.scene,
        grid: r.grid,
        stats: r.stats,
        timing: r.timing,
        indices: indicesFromStats(r.stats),
        images: { trueColour: `/api/aoi/${id}/image/true`, ndvi: `/api/aoi/${id}/image/ndvi` },
      };
      storeAoi(record, rgba.trueColour, rgba.ndviMap, W, H);
      cacheSet(`aoi:${ringKey}`, record);
    }
    const weather = await weatherForArea(record.centroid.lat, record.centroid.lon);
    const advisorWeather = {
      windKmh: weather.live?.windKmh ?? null,
      rainNext7dMm: weather.forecast?.rainNext7dMm ?? null,
      tempMinC: weather.forecast?.tempMinC ?? null,
    };
    const advice = wheatAdvisor.adviseWheat({ indices: record.indices, weather: advisorWeather, soil });
    const full = { ...record, cached, soilProvided: !!soil, soil, weather, advice, lastAdvisedAt: nowIso() };
    // The stored record keeps the latest advice so chat can answer about it.
    writeAoiMeta(record.id, { ...record, advice, soil, weatherSnapshot: advisorWeather });
    res.json(full);
  } catch (e) {
    res.status(e.status || 502).json({ error: `satellite analysis failed: ${e.message}` });
  }
});

/** Shape the Sentinel class shares into the advisor's index names. Pure. */
function indicesFromStats(stats) {
  return {
    healthyPct: stats.sharePct.healthy,
    stressedPct: stats.sharePct.stressed,
    barePct: stats.sharePct.bare,
    waterPct: stats.sharePct.water,
    ndviMean: stats.ndvi?.mean ?? null,
    ndviMin: stats.ndvi?.min ?? null,
    bsiMean: stats.bsiMean,
  };
}

function writeAoiMeta(id, record) {
  const tmp = path.join(AOI_DIR, `${id}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, path.join(AOI_DIR, `${id}.json`));
}

app.get('/api/aoi/:id', (req, res) => {
  const rec = readAoi(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Area not found' });
  res.json(rec);
});

app.get('/api/aoi/:id/image/:kind', (req, res) => {
  if (!AOI_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad area id' });
  const kind = req.params.kind === 'true' ? 'true' : req.params.kind === 'ndvi' ? 'ndvi' : null;
  if (!kind) return res.status(404).json({ error: 'unknown image' });
  const p = path.join(AOI_DIR, `${req.params.id}-${kind === 'true' ? 'true' : 'ndvi'}.png`);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'image not found' });
  res.set('Cache-Control', 'private, max-age=3600');
  res.type('png');
  res.sendFile(p);
});

/* ----------------------------- Chat assistant -----------------------------
 * With a chat model configured (CHAT_API_URL / aiConfig.chat), questions go to
 * it with the analysed area as context. Without one, the answer is built from
 * the same analysis by rules, and says so. Either way it never invents a soil
 * value: lab numbers only appear if the user entered them. ----------------- */
const CHAT_SYSTEM = `You are the Crop AI agronomy assistant for wheat. Answer ONLY from the analysis JSON you are given.
- Quote numbers exactly as they appear in the JSON. If a value is missing, say it was not measured.
- Satellite pixels cannot measure zinc or other soil chemistry; say so when asked, and recommend a soil test.
- Give fertilizer guidance as a starting point for a local agronomist to confirm, with rates.
- Keep answers short and practical.`;

function chatSettings() {
  const c = aiConfig?.chat || {};
  return {
    baseUrl: (process.env.CHAT_API_URL || c.baseUrl || '').trim(),
    apiKey: process.env.CHAT_API_KEY || c.apiKey || '',
    model: process.env.CHAT_MODEL || c.model || 'gpt-4o-mini',
  };
}

async function askChatModel(settings, message, context) {
  const url = /\/chat\/completions$/.test(settings.baseUrl) ? settings.baseUrl : `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const body = {
    model: settings.model,
    temperature: 0.2,
    max_tokens: 500,
    messages: [
      { role: 'system', content: CHAT_SYSTEM },
      { role: 'user', content: `Analysis context (JSON):\n${JSON.stringify(context)}\n\nQuestion: ${message}` },
    ],
  };
  const j = await fetchJson(url, { method: 'POST', body, headers, timeoutMs: 30000 });
  const text = j?.choices?.[0]?.message?.content;
  if (!text) throw new Error('chat model returned no answer');
  return String(text).trim();
}

/** Plain-text answer from the stored analysis, no model needed. Pure. */
function answerFromRules(message, rec) {
  if (!rec) {
    return 'Draw an area on the map and analyse it first. Then ask me about its crop health, fertilizer, zinc, or the weather.';
  }
  const q = message.toLowerCase();
  const ix = rec.indices || {};
  const head = `Area of ${rec.areaM2} m² · Sentinel-2 scene ${rec.scene?.datetime?.slice(0, 10) || 'unknown date'} (${rec.scene?.cloudCover ?? '?'}% cloud).`;
  const findings = rec.advice?.findings || [];
  const unknowns = rec.advice?.unknowns || [];
  const lines = (arr) => arr.map((f) => `• ${f.title}${f.action ? ` — ${f.action}` : ''}`).join('\n');
  if (/zinc|\bzn\b/.test(q)) {
    const z = findings.filter((f) => /zinc/.test(f.id));
    const zu = unknowns.filter((u) => /zinc/i.test(u));
    return z.length ? lines(z) : (zu[0] || 'No zinc finding for this area.');
  }
  if (/weather|rain|wind|frost|spray|temperature|forecast/.test(q)) {
    const w = findings.filter((f) => f.source === 'weather');
    return w.length ? lines(w) : 'No weather constraints were raised. Live weather may be unavailable for this location.';
  }
  if (/fertili|apply|product|what should|what do|rate|dose|nitrogen|phosph|potass|\bnpk\b/.test(q)) {
    const a = findings.filter((f) => f.action && f.source !== 'weather');
    return a.length ? `${lines(a)}\n\nConfirm rates with a local soil test and agronomist.` : 'No fertilizer action is indicated by the satellite data. A soil test would still tell you whether nutrients are short.';
  }
  if (/ndvi|health|stress|bare|crop|plant|vigou?r|canopy|gap/.test(q)) {
    const c = findings.filter((f) => f.source !== 'lab' && f.source !== 'weather');
    const summary = `Healthy ${ix.healthyPct}% · stressed ${ix.stressedPct}% · bare ${ix.barePct}% · mean NDVI ${ix.ndviMean?.toFixed?.(2) ?? '—'}.`;
    return `${head}\n${summary}\n${c.length ? lines(c) : 'Canopy looks uniform; no crop-condition issue was raised.'}`;
  }
  const top = findings.slice(0, 3);
  return `${head}\nHealthy ${ix.healthyPct}% · stressed ${ix.stressedPct}% · bare ${ix.barePct}%.\n${top.length ? lines(top) : 'No issues were raised.'}\n\nAsk about zinc, fertilizer, the weather, or crop health.`;
}

app.post('/api/chat', limitHeavy('chat', 30), async (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'message is required' });
  const rec = readAoi(req.body?.aoiId);
  const context = rec ? {
    area: { areaM2: rec.areaM2, centroid: rec.centroid },
    scene: { id: rec.scene?.id, datetime: rec.scene?.datetime, cloudCover: rec.scene?.cloudCover },
    indices: rec.indices,
    soilLabEntered: rec.soil || null,
    findings: (rec.advice?.findings || []).map(({ title, evidence, action, severity, source }) => ({ title, evidence, action, severity, source })),
    unknowns: rec.advice?.unknowns || [],
    weather: rec.weatherSnapshot || null,
  } : null;
  const settings = chatSettings();
  if (settings.baseUrl) {
    try {
      const reply = await askChatModel(settings, message, context || { note: 'no area analysed yet' });
      return res.json({ mode: 'llm', model: settings.model, reply });
    } catch (e) {
      return res.json({ mode: 'rules', llmError: e.message, reply: answerFromRules(message, rec) });
    }
  }
  res.json({ mode: 'rules', reply: answerFromRules(message, rec) });
});

app.get('/api/fields/:id/terrain', async (req, res) => {
  const f = fields[req.params.id];
  if (!f) return res.status(404).json({ error: 'Field not found' });
  try { res.json({ fieldId: f.fieldId, ...(await fetchTerrain(f)) }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get('/api/fields/:id/weather-crosscheck', async (req, res) => {
  const f = fields[req.params.id];
  if (!f) return res.status(404).json({ error: 'Field not found' });
  try { res.json({ fieldId: f.fieldId, ...(await crossCheckWeather(f)) }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

/** Daily weather for any window back to 1940 - the date-addressable source. */
app.get('/api/fields/:id/weather/history', async (req, res) => {
  const f = fields[req.params.id];
  if (!f) return res.status(404).json({ error: 'Field not found' });
  const g = f.gps;
  if (!g || g.lat == null) return res.status(409).json({ error: 'Field has no GPS georeference - ingest imagery with EXIF GPS or set a manual geotag first.' });
  const end = req.query.end ? parseIsoDay(req.query.end) : todayIso();
  const start = req.query.start ? parseIsoDay(req.query.start) : addDays(end || todayIso(), -89);
  // Validated before any provider call, so a bad window costs nothing.
  const problem = weatherWindowProblem(start, end);
  if (problem) return res.status(400).json({ error: problem });
  try {
    res.json({ fieldId: f.fieldId, ...(await fetchWeatherHistory(g.lat, g.lon, start, end)) });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

/**
 * Weather on each acquisition's own date.
 *
 * With no body the field's Sentinel-2 scenes are searched and used, so the
 * console can answer "what was the weather when this image was taken" without
 * the caller having to know the scene dates first.
 */
app.post('/api/fields/:id/weather/for-dates', async (req, res) => {
  const f = fields[req.params.id];
  if (!f) return res.status(404).json({ error: 'Field not found' });
  const g = f.gps;
  if (!g || g.lat == null) return res.status(409).json({ error: 'Field has no GPS georeference - ingest imagery with EXIF GPS or set a manual geotag first.' });
  const body = req.body || {};
  const given = Array.isArray(body.dates) ? body.dates : null;
  try {
    if (given) {
      if (!given.length) return res.status(400).json({ error: 'at least one date is required (YYYY-MM-DD).' });
      if (given.length > 400) return res.status(400).json({ error: 'at most 400 dates can be requested at once.' });
      const bad = given.filter((d) => !parseIsoDay(d));
      if (bad.length) return res.status(400).json({ error: `not ISO dates (YYYY-MM-DD): ${bad.slice(0, 3).join(', ')}` });
      const days = given.map((d) => parseIsoDay(d)).sort();
      const history = await fetchWeatherHistory(g.lat, g.lon, days[0], days[days.length - 1]);
      const { matched, missing } = matchWeatherToDates(history.days, days);
      return res.json({
        fieldId: f.fieldId,
        requested: given, dates: matched.map((d) => d.date), days: matched, missing,
        window: history.window, warnings: history.warnings,
        note: 'Each requested date is matched to its own daily record; a date no provider reports is listed in missing rather than interpolated.',
        provenance: history.provenance, fetchedAt: nowIso(),
      });
    }
    const days = Math.max(1, Math.min(365, +body.days || 90));
    const found = await searchSentinel({
      lat: g.lat, lon: g.lon, collection: body.collection || 'sentinel-2-l2a',
      days, maxCloud: Math.max(0, Math.min(100, +body.maxCloud ?? 60)), limit: Math.max(1, Math.min(20, +body.limit || 8)),
    });
    res.json({ fieldId: f.fieldId, ...(await weatherForSceneDates(g.lat, g.lon, found.scenes || [])) });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

/* ═══════════════════════ CP10 · WORKFLOW DAG ENGINE ════════════════════════
 * Workflows are directed acyclic graphs of nodes (fetch -> prepare -> infer).
 * Each node declares its dependencies, so the runner walks them in topological
 * order. Every result is cached under a hash of its inputs - the field
 * geometry, its parameters and the hashes of the nodes it depends on - so a new
 * satellite pass, a re-geotagged field or a fresh sensor reading re-runs only
 * the nodes that actually depend on that change.
 * ══════════════════════════════════════════════════════════════════════════ */

const workflowStore = loadJSON('workflows.json', { runs: [] });
if (!Array.isArray(workflowStore.runs)) workflowStore.runs = [];
const WF_RUNS_CAP = 40;

function hashCode(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}

/** The geospatial state of a field: changes when it is re-geotagged or analysed. */
function fieldFingerprint(field) {
  return {
    fieldId: field.fieldId,
    gps: field.gps || null,
    grid: field.grid || null,
    size: [field.width || null, field.height || null],
    groundWidthM: field.groundWidthM || null,
    analyzedAt: field.analyzedAt || null,
    modelId: field.modelId || null,
  };
}

/** Live state that must invalidate agronomy nodes when it moves. */
function sensorFingerprint(field) {
  const rec = getSensor(field.fieldId);
  const dev = mergedDeviceReading(rec);
  return {
    deviceAt: dev ? dev.t : null,
    soilMoisture: dev && dev.soilMoisture != null ? dev.soilMoisture : null,
    weatherAt: rec.weather?.observedAt || null,
    weatherFetchedAt: rec.weather?.fetchedAt || null,
  };
}

/* Nodes that read live sensor or weather state re-run when that state moves. */
const SENSOR_SENSITIVE = ['irrigation', 'soil-quality', 'report'];

const WF_NODES = {
  'field-geo': {
    label: 'Field geometry',
    kind: 'prepare',
    deps: [],
    run: ({ field }) => {
      const geo = fieldGeometry(field);
      const tiles = (field.grid?.rows || 0) * (field.grid?.cols || 0);
      return {
        geo,
        gps: field.gps || null,
        tiles,
        footprint: field.gps?.lat != null ? footprintRing(field.gps.lat, field.gps.lon, geo.widthM, geo.heightM) : null,
        areaHa: +(geo.fieldAreaM2 / 10000).toFixed(3),
      };
    },
  },
  weather: {
    label: 'Open-Meteo forecast + soil',
    kind: 'fetch',
    deps: ['field-geo'],
    run: async ({ field }) => fetchRealWeather(field.gps.lat, field.gps.lon),
  },
  'weather-crosscheck': {
    label: 'Weather cross-check (NASA POWER)',
    kind: 'fetch',
    deps: ['field-geo'],
    run: async ({ field }) => crossCheckWeather(field),
  },
  'weather-history': {
    label: 'ERA5 reanalysis history (any date)',
    kind: 'fetch',
    deps: ['field-geo'],
    run: async ({ field, params }) => fetchWeatherHistory(
      field.gps.lat, field.gps.lon,
      addDays(todayIso(), -(params.historyDays || 90)),
      todayIso(),
    ),
  },
  'scene-weather': {
    label: 'Weather on each acquisition date',
    kind: 'infer',
    deps: ['satellite-optical'],
    run: async ({ field, outputs }) => weatherForSceneDates(
      field.gps.lat, field.gps.lon, outputs['satellite-optical']?.scenes || [],
    ),
  },
  terrain: {
    label: 'Elevation + slope (Copernicus DEM)',
    kind: 'fetch',
    deps: ['field-geo'],
    run: async ({ field }) => fetchTerrain(field),
  },
  'satellite-optical': {
    label: 'Sentinel-2 optical scenes',
    kind: 'fetch',
    deps: ['field-geo'],
    run: async ({ field, params }) => searchSentinel({
      lat: field.gps.lat, lon: field.gps.lon, collection: 'sentinel-2-l2a',
      days: params.days || 90, maxCloud: params.maxCloud ?? 60, limit: params.limit || 8,
    }),
  },
  'satellite-sar': {
    label: 'Sentinel-1 SAR scenes',
    kind: 'fetch',
    deps: ['field-geo'],
    run: async ({ field, params }) => searchSentinel({
      lat: field.gps.lat, lon: field.gps.lon, collection: 'sentinel-1-grd',
      days: params.days || 90, limit: params.limit || 6,
    }),
  },
  classify: {
    label: 'Local kNN classification',
    kind: 'infer',
    deps: ['field-geo'],
    run: ({ field }) => {
      const f = fieldSummary(field);
      return {
        counts: localClassCounts(field),
        stats: f.stats,
        statsPct: f.statsPct,
        modelId: f.modelId,
        classifiedTiles: f.grid ? (f.grid.rows || 0) * (f.grid.cols || 0) : 0,
        status: f.status,
      };
    },
  },
  irrigation: {
    label: 'Irrigation advisory',
    kind: 'infer',
    deps: ['field-geo'],
    run: ({ field }) => recommendIrrigation(field),
  },
  'soil-quality': {
    label: 'Soil quality index',
    kind: 'infer',
    deps: ['irrigation'],
    run: ({ field }) => assessSoilQuality(field),
  },
  context: {
    label: 'Field context merge',
    kind: 'prepare',
    deps: ['weather', 'terrain', 'satellite-optical', 'satellite-sar', 'weather-history', 'scene-weather'],
    run: ({ outputs }) => {
      const w = outputs.weather, t = outputs.terrain;
      const o = outputs['satellite-optical'], s = outputs['satellite-sar'];
      const h = outputs['weather-history'], sw = outputs['scene-weather'];
      return {
        weather: w ? {
          airTempC: w.airTempC, humidityPct: w.humidityPct, precipitationMm: w.precipitationMm,
          et0MmDay: w.et0MmDay, soilMoisturePct: w.soilMoisturePct, windKmh: w.windKmh, observedAt: w.observedAt,
        } : null,
        terrain: t ? { elevationM: t.elevationM, slopePct: t.slopePct, aspectDeg: t.aspectDeg, drainage: t.drainage } : null,
        optical: o ? {
          scenes: o.count, leastCloudyAt: o.leastCloudy?.datetime || null,
          leastCloudPct: o.leastCloudy?.cloudCover ?? null, meanCloudPct: o.meanCloudPct,
        } : null,
        sar: s ? { scenes: s.count, latestAt: s.scenes?.[0]?.datetime || null } : null,
        // The season behind the field, and the weather on each acquisition's
        // own day: a single scene says nothing about drought or waterlogging
        // until it is set against what the weather was doing.
        season: h ? { window: h.window, summary: h.summary } : null,
        sceneWeather: sw ? sw.scenes.map((x) => ({
          datetime: x.datetime, cloudCover: x.cloudCover,
          rainMm: x.weather?.precipitationMm ?? null, tMaxC: x.weather?.tMaxC ?? null,
          et0Mm: x.weather?.et0Mm ?? null, windMaxKmh: x.weather?.windMaxKmh ?? null,
        })) : null,
        sourcesUsed: [w, t, o, s, h, sw].filter(Boolean).length,
      };
    },
  },
  'acquisition-window': {
    label: 'Best acquisition pick',
    kind: 'infer',
    deps: ['satellite-optical'],
    run: ({ outputs }) => {
      const o = outputs['satellite-optical'];
      const scenes = o?.scenes || [];
      const clouds = scenes.map((s) => s.cloudCover).filter((v) => v != null);
      return {
        window: o?.window || null,
        scenes: scenes.length,
        meanCloudPct: clouds.length ? +avg(clouds).toFixed(1) : null,
        clearest: o?.leastCloudy || null,
        cloudFreeCandidates: scenes
          .filter((s) => (s.cloudCover ?? 100) < 10)
          .map((s) => ({ id: s.id, datetime: s.datetime, cloudCover: s.cloudCover, thumbnail: s.thumbnail })),
      };
    },
  },
  report: {
    label: 'Field report',
    kind: 'infer',
    deps: ['classify', 'irrigation', 'soil-quality'],
    run: ({ field }) => buildFieldReport(field, {
      ai: field.ai?.normalized || null,
      source: field.ai?.source || (field.stats ? 'local-model' : 'unclassified'),
      mode: 'workflow',
    }),
  },
};

const WORKFLOWS = {
  'local-agronomy': {
    id: 'local-agronomy',
    label: 'Local agronomy refresh',
    description: 'Recompute tile classification, the irrigation advisory, the soil quality index and the field report from local imagery and live sensor state. No network access required.',
    nodes: ['field-geo', 'classify', 'irrigation', 'soil-quality', 'report'],
    requiresGps: false,
  },
  'field-refresh': {
    id: 'field-refresh',
    label: 'Full field context refresh',
    description: 'Fetch real Sentinel-2 and Sentinel-1 scenes, live weather, a NASA POWER cross-check, 90 days of ERA5 reanalysis and Copernicus DEM terrain, pair every acquisition with the weather of its own day, merge them into one context object, then re-run the agronomy nodes on top of it.',
    nodes: ['field-geo', 'weather', 'weather-crosscheck', 'weather-history', 'terrain', 'satellite-optical', 'satellite-sar', 'scene-weather', 'context', 'classify', 'irrigation', 'soil-quality', 'report'],
    requiresGps: true,
  },
  'imagery-window': {
    id: 'imagery-window',
    label: 'Imagery acquisition window',
    description: 'Scan the Sentinel-2 archive for this field and pick the least-cloudy acquisition - the input that cloud-free compositing needs.',
    nodes: ['field-geo', 'satellite-optical', 'acquisition-window'],
    requiresGps: true,
  },
};

/** Kahn topological sort; throws when the graph has a cycle. */
function topoOrder(ids) {
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const id of ids) for (const dep of WF_NODES[id].deps) if (indeg.has(dep)) indeg.set(id, indeg.get(id) + 1);
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const other of ids) {
      if (!WF_NODES[other].deps.includes(id)) continue;
      indeg.set(other, indeg.get(other) - 1);
      if (indeg.get(other) === 0) queue.push(other);
    }
  }
  if (order.length !== ids.length) throw new Error('workflow graph contains a cycle');
  return order;
}

function workflowDefinition(id) {
  const wf = WORKFLOWS[id];
  if (!wf) return null;
  return {
    ...wf,
    nodeCount: wf.nodes.length,
    graph: wf.nodes.map((n) => ({
      id: n,
      label: WF_NODES[n].label,
      kind: WF_NODES[n].kind,
      deps: WF_NODES[n].deps.filter((d) => wf.nodes.includes(d)),
    })),
    edges: wf.nodes.flatMap((n) => WF_NODES[n].deps.filter((d) => wf.nodes.includes(d)).map((d) => `${d} -> ${n}`)),
  };
}

const stripNodeOutput = (n) => ({ ...n, output: null });
const slimRun = (run) => ({ ...run, nodes: run.nodes.map(stripNodeOutput) });

function lastRunFor(workflowId, fieldId) {
  return workflowStore.runs.find((r) => r.workflowId === workflowId && r.fieldId === fieldId) || null;
}

/** Execute one workflow for one field, reusing any node whose inputs did not change. */
async function runWorkflow(workflowId, { fieldId, force = false, params = {} } = {}) {
  const wf = WORKFLOWS[workflowId];
  if (!wf) throw Object.assign(new Error(`Unknown workflow ${workflowId}`), { status: 404 });
  const field = fields[fieldId];
  if (!field) throw Object.assign(new Error(`Field ${fieldId} not found`), { status: 404 });
  if (wf.requiresGps && !(field.gps && field.gps.lat != null)) {
    throw Object.assign(new Error('This workflow needs a georeferenced field (EXIF GPS or a manual geotag)'), { status: 409 });
  }

  const previous = lastRunFor(workflowId, fieldId);
  const prevNodes = new Map((previous?.nodes || []).map((n) => [n.nodeId, n]));
  const run = {
    runId: `run-${crypto.randomBytes(4).toString('hex')}`,
    workflowId,
    workflowLabel: wf.label,
    fieldId,
    startedAt: nowIso(),
    finishedAt: null,
    status: 'running',
    forced: !!force,
    params,
    executed: 0,
    reused: 0,
    durationMs: 0,
    nodes: [],
  };

  const outputs = {}, hashes = {};
  for (const nodeId of topoOrder(wf.nodes)) {
    const node = WF_NODES[nodeId];
    const input = {
      node: nodeId,
      field: nodeId === 'field-geo' || node.deps.includes('field-geo') ? fieldFingerprint(field) : null,
      params,
      upstream: node.deps.map((d) => hashes[d] || null),
      sensors: SENSOR_SENSITIVE.includes(nodeId) ? sensorFingerprint(field) : null,
    };
    const hash = hashCode(input);
    const prev = prevNodes.get(nodeId);
    if (!force && prev && prev.hash === hash && prev.status === 'ok' && prev.output) {
      outputs[nodeId] = prev.output;
      hashes[nodeId] = hash;
      run.nodes.push({ ...prev, cached: true, durationMs: 0, fresh: false });
      run.reused += 1;
      sseSend('workflow-node', { runId: run.runId, workflowId, fieldId, nodeId, label: node.label, status: 'cached' });
      continue;
    }
    const t0 = Date.now();
    try {
      const output = await node.run({ field, fieldId, outputs, hashes, params });
      const durationMs = Date.now() - t0;
      outputs[nodeId] = output;
      hashes[nodeId] = hash;
      run.nodes.push({ nodeId, label: node.label, kind: node.kind, status: 'ok', hash, cached: false, fresh: true, durationMs, output });
      run.executed += 1;
      sseSend('workflow-node', { runId: run.runId, workflowId, fieldId, nodeId, label: node.label, status: 'ok', durationMs });
    } catch (e) {
      const durationMs = Date.now() - t0;
      run.nodes.push({ nodeId, label: node.label, kind: node.kind, status: 'failed', hash, cached: false, fresh: true, durationMs, error: e.message, output: null });
      run.status = 'failed';
      run.error = `${node.label}: ${e.message}`;
      sseSend('workflow-node', { runId: run.runId, workflowId, fieldId, nodeId, label: node.label, status: 'failed', error: e.message });
      break;
    }
  }

  if (run.status === 'running') run.status = 'ok';
  run.finishedAt = nowIso();
  run.durationMs = run.nodes.reduce((a, n) => a + (n.durationMs || 0), 0);
  workflowStore.runs.unshift(run);
  // Keep outputs only for the newest run of each workflow + field pair: history
  // stays small while the newest derived product stays fully inspectable.
  workflowStore.runs = workflowStore.runs.map((r) => (
    r.runId !== run.runId && r.workflowId === workflowId && r.fieldId === fieldId ? slimRun(r) : r
  ));
  if (workflowStore.runs.length > WF_RUNS_CAP) workflowStore.runs.length = WF_RUNS_CAP;
  try { saveJSON('workflows.json', workflowStore); } catch {}
  sseSend('workflow-run', {
    runId: run.runId, workflowId, workflowLabel: wf.label, fieldId,
    status: run.status, executed: run.executed, reused: run.reused,
    durationMs: run.durationMs, error: run.error || null,
  });
  return run;
}

/* ---- Workflow REST surface -------------------------------------------------- */
app.get('/api/workflows', (_req, res) => {
  res.json({
    count: Object.keys(WORKFLOWS).length,
    workflows: Object.keys(WORKFLOWS).map(workflowDefinition),
    runs: workflowStore.runs.length,
  });
});

app.get('/api/workflows/:id', (req, res) => {
  const def = workflowDefinition(req.params.id);
  if (!def) return res.status(404).json({ error: 'Unknown workflow' });
  res.json(def);
});

app.get('/api/workflows/:id/runs', (req, res) => {
  if (!WORKFLOWS[req.params.id]) return res.status(404).json({ error: 'Unknown workflow' });
  const limit = Math.max(1, Math.min(WF_RUNS_CAP, +req.query.limit || 10));
  const items = workflowStore.runs
    .filter((r) => r.workflowId === req.params.id)
    .filter((r) => !req.query.fieldId || r.fieldId === req.query.fieldId)
    .slice(0, limit)
    .map((r) => ({
      runId: r.runId, workflowId: r.workflowId, fieldId: r.fieldId, status: r.status,
      startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs,
      executed: r.executed, reused: r.reused, error: r.error || null,
      nodes: r.nodes.map((n) => ({
        nodeId: n.nodeId, label: n.label, kind: n.kind, status: n.status,
        cached: !!n.cached, durationMs: n.durationMs, error: n.error || null,
      })),
    }));
  res.json({ workflowId: req.params.id, total: items.length, items });
});

app.post('/api/workflows/:id/run', async (req, res) => {
  try {
    const b = req.body || {};
    const run = await runWorkflow(req.params.id, {
      fieldId: b.fieldId || Object.keys(fields)[0],
      force: !!b.force,
      params: b.params && typeof b.params === 'object' ? b.params : {},
    });
    res.json(run);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/workflow-runs/:runId', (req, res) => {
  const run = workflowStore.runs.find((r) => r.runId === req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

app.post('/api/workflow-runs/clear', (req, res) => {
  const fieldId = (req.body || {}).fieldId;
  workflowStore.runs = fieldId ? workflowStore.runs.filter((r) => r.fieldId !== fieldId) : [];
  try { saveJSON('workflows.json', workflowStore); } catch {}
  res.json({ ok: true, remaining: workflowStore.runs.length });
});

/* ---- (removed: demo simulator endpoints) ---- */

/* ---- Reset ------------------------------------------------------------------------- */
app.post('/api/reset', (_req, res) => {
  fields = {}; models = {}; sensors = {};
  try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(SAMPLE_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(DATA_DIR, 'dataset.json'), { force: true }); } catch {}
  ensureDirs();
  persistAll();
  sseSend('reset', {});
  res.json({ ok: true });
});

/* --------------------------------- Boot ------------------------------------- */
ensureDirs();
hydrateFields();
sanitizeTrainingStore();
persistAll();
refreshWeatherAll().catch((e) => console.warn('[weather] initial refresh failed:', e.message));
// No background timer on Vercel: serverless instances freeze between
// requests. Route handlers already refresh when data is stale (600 s cache).
if (!process.env.VERCEL) {
  setInterval(() => refreshWeatherAll().catch(() => {}), CONFIG.weatherCacheSeconds * 1000);
}

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

if (process.env.VERCEL) {
  // Serverless: Vercel invokes the exported app directly - never listen().
  console.log('  Vibes Lite / Crop AI - running as a Vercel Function (no listen)');
} else http.createServer(app).listen(PORT, () => {
  const ai = aiSettings();
  console.log(`\n  Vibes Lite / Crop AI (production edition)`);
  console.log(`  Open  http://localhost:${PORT}`);
  console.log(`  CV    ${CV_MODE} · weather: Open-Meteo · geo: EXIF + device location + manual geotag`);
  console.log(`  AI    ${aiConfigured() ? `${ai.provider} -> ${ai.baseUrl}${ai.model ? ` (${ai.model})` : ''}` : 'not configured - local kNN model in use'}`);
  console.log(`  IoT   POST /api/fields/{id}/ingest with X-Sensor-Token\n`);
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

// Vercel: api/index.js re-exports this app as the single serverless function.
// The app also exposes its pure helpers and the workflow engine so the Node
// test suite (crop-ai/server.test.js) can exercise them directly instead of
// re-implementing the logic it is meant to protect.
app.internals = {
  /* security surface — exported so the suite can assert the controls are
     actually wired in and not merely documented */
  CSP, CSP_BASE, cspFor, servedOverTls, safeId, tokenEquals, SSE_CLIENT_CAP, RATE_LIMIT_BUDGETS, ID_RE,
  CONFIG, CLASSES, CLASS_KEYS, SOURCES, sourceCache, STAC_COLLECTIONS,
  OSM, OSM_BASEMAPS, OSM_FEATURE_KINDS, OSM_DEFAULT_KINDS, OSM_ATTRIBUTION,
  osmStatus, osmMatches, osmFeatureElement, osmOverpassQuery,
  soilMoisturePct, mergedDeviceReading, latestDeviceReading, deviceSummary,
  fieldGeometry, tileGeo, fieldFingerprint, sensorFingerprint, hashCode,
  localClassCounts, normalizeIdentifyResult, normalizeAIResult,
  recommendIrrigation, assessSoilQuality, buildFieldReport,
  WF_NODES, WORKFLOWS, topoOrder, workflowDefinition,
  ARCHIVE_DAILY_VARS, ARCHIVE_START_DAY, PROVISIONAL_DAYS, WEATHER_MAX_DAYS,
  parseIsoDay, weatherWindowProblem, normalizeWeatherDays, weatherSeasonSummary,
  matchWeatherToDates, fetchWeatherHistory, weatherForSceneDates,
  WINDY, windyEmbedUrl, CSP_FRAME_SRC,
  /* device location — exported so the suite can walk the validation boundaries
     and the store lifecycle without a browser or the network */
  LOCATION_STORE, LOCATION_MOVE_EPSILON_M, LOCATION_MAX_ACCURACY_M,
  LOCATION_STALE_AFTER_S, haversineM, locationFix, locationPublic,
  nearestFieldTo, resolveLocation, liveLocationBundle,
  setDeviceLocation, clearDeviceLocation,
  getDeviceLocation: () => deviceLocation,
};
app.engine = {
  runWorkflow,
  lastRunFor,
  listRuns: () => workflowStore.runs,
};
module.exports = app;
