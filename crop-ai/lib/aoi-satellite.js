'use strict';
/**
 * Satellite analysis for a user-drawn area of interest (AOI).
 *
 *   Scene      Sentinel-2 L2A from the Earth Search STAC catalogue (keyless).
 *   Pixels     Band COGs on AWS, read with HTTP range requests (geotiff.js)
 *              and resampled onto a 10 m grid covering the polygon.
 *   Indices    NDVI (canopy green), NDWI (water), BSI (bare soil).
 *   Output     Class shares inside the polygon, a true-colour PNG and an NDVI PNG.
 *
 * Everything that can be pure is pure (geometry, indices, stats, rendering), so
 * it is unit-tested without the network. Only fetchScene and readBands touch
 * the network.
 */

const { createRequire } = require('module');

// geotiff and proj4 are installed in crop-ai/node_modules; load them relative to
// this package so the module works no matter where node is started from.
const requireHere = createRequire(__filename);
let _geotiff = null;
let _proj4 = null;
const geotiff = () => (_geotiff = _geotiff || requireHere('geotiff'));
const proj4 = () => (_proj4 = _proj4 || requireHere('proj4'));

const STAC_SEARCH = 'https://earth-search.aws.element84.com/v1/search';
const PIXEL_M = 10;            // target grid resolution (m)
const MAX_SIDE_PX = 360;       // cap so one request stays bounded
const MAX_AREA_M2 = 5_000_000; // 500 ha: beyond this a drawn area is probably a mis-click
const MIN_AREA_M2 = 400;       // 20 m x 20 m: smaller than a few pixels is noise

/* ------------------------------ Geometry (pure) ---------------------------- */

/**
 * Validate a list of [lat, lon] vertices drawn on the map.
 * Returns { ok: true, ring: [[lat, lon]...] } (open ring, no duplicate closing point)
 * or { ok: false, error }.
 */
function validatePolygon(points) {
  if (!Array.isArray(points)) return { ok: false, error: 'points must be an array of [lat, lon]' };
  const clean = [];
  for (const p of points) {
    const lat = Number(Array.isArray(p) ? p[0] : p?.lat);
    const lon = Number(Array.isArray(p) ? p[1] : p?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, error: 'every point needs a numeric lat and lon' };
    if (lat < -90 || lat > 90) return { ok: false, error: `latitude ${lat} is out of range` };
    if (lon < -180 || lon > 180) return { ok: false, error: `longitude ${lon} is out of range` };
    // (0, 0) is what a GPS stack reports with no fix; it is never a real field.
    if (lat === 0 && lon === 0) return { ok: false, error: '(0, 0) is a no-fix sentinel, not a field location' };
    clean.push([+lat.toFixed(7), +lon.toFixed(7)]);
  }
  // Drop a duplicated closing vertex if the client sent the ring closed.
  if (clean.length > 1 && clean[0][0] === clean[clean.length - 1][0] && clean[0][1] === clean[clean.length - 1][1]) clean.pop();
  if (clean.length < 3) return { ok: false, error: 'an area needs at least 3 points' };
  const area = polygonAreaM2(clean);
  if (area < MIN_AREA_M2) return { ok: false, error: `the area is ${Math.round(area)} m² — too small to analyse from 10 m satellite pixels` };
  if (area > MAX_AREA_M2) return { ok: false, error: `the area is ${(area / 10000).toFixed(0)} ha — the analysis is limited to 500 ha per request` };
  return { ok: true, ring: clean, areaM2: area };
}

/** Area of a [lat, lon] ring in m² using a local equirectangular projection. */
function polygonAreaM2(ring) {
  const lat0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  const xy = ring.map(([la, lo]) => [lo * kx, la * ky]);
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Ray-casting point-in-polygon for [x, y] ring and point. Pure. */
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Bounding box [minX, minY, maxX, maxY] of an [x, y] ring. */
function ringBbox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** UTM EPSG code for a WGS84 lat/lon (northern and southern hemispheres). Pure. */
function utmEpsg(lat, lon) {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return (lat >= 0 ? 32600 : 32700) + zone;
}

/** Project a [lat, lon] ring into UTM metres for the given EPSG. */
function ringToUtm(ring, epsg) {
  return ring.map(([la, lo]) => proj4()('EPSG:4326', `EPSG:${epsg}`, [lo, la]));
}

/* ------------------------------ Spectral indices (pure) -------------------- */

const eps = 1e-9;
const ndvi = (nir, red) => (nir + red > eps ? (nir - red) / (nir + red) : 0);
const ndwi = (green, nir) => (green + nir > eps ? (green - nir) / (green + nir) : 0);
const bsi = (blue, red, nir, swir) => {
  const a = swir + red, b = nir + blue;
  return a + b > eps ? (a - b) / (a + b) : 0;
};

/**
 * Classify one valid pixel from its reflectances. Thresholds follow common
 * agronomic practice for cereals: NDVI < 0.15 is bare or water-logged ground,
 * 0.15–0.35 is sparse or stressed canopy, above 0.35 is a closed healthy canopy.
 */
function classifyPixel({ blue, green, red, nir, swir }) {
  const w = ndwi(green, nir);
  if (w > 0.3) return 'water';
  const v = ndvi(nir, red);
  if (v >= 0.35) return 'healthy';
  if (v >= 0.15) return 'stressed';
  // Below 0.15 NDVI the ground is bare; BSI is kept for the summary, not the class.
  return 'bare';
}

/**
 * Summarise classified pixels. `pixels` is an array of { cls, ndvi, bsi }
 * for pixels inside the polygon with valid data. Pure.
 */
function summarizeClasses(pixels) {
  const n = pixels.length;
  const counts = { healthy: 0, stressed: 0, bare: 0, water: 0 };
  let ndviSum = 0, ndviMin = Infinity, ndviMax = -Infinity, bsiSum = 0;
  for (const p of pixels) {
    counts[p.cls] = (counts[p.cls] || 0) + 1;
    ndviSum += p.ndvi; bsiSum += p.bsi;
    if (p.ndvi < ndviMin) ndviMin = p.ndvi;
    if (p.ndvi > ndviMax) ndviMax = p.ndvi;
  }
  const pct = (k) => (n ? +((counts[k] / n) * 100).toFixed(1) : null);
  return {
    validPixels: n,
    areaHa: +((n * PIXEL_M * PIXEL_M) / 10000).toFixed(3),
    sharePct: { healthy: pct('healthy'), stressed: pct('stressed'), bare: pct('bare'), water: pct('water') },
    ndvi: n ? { mean: +(ndviSum / n).toFixed(3), min: +ndviMin.toFixed(3), max: +ndviMax.toFixed(3) } : null,
    bsiMean: n ? +(bsiSum / n).toFixed(3) : null,
  };
}

/* ------------------------------ Rendering (pure) --------------------------- */

const NDVI_STOPS = [
  [-0.2, [166, 97, 26]],  // water / bare-wet
  [0.0, [215, 190, 120]], // bare soil
  [0.2, [230, 230, 110]], // sparse
  [0.4, [120, 190, 60]],  // moderate canopy
  [0.7, [30, 130, 40]],   // dense canopy
  [0.9, [0, 80, 20]],     // very dense
];
function ndviColour(v) {
  if (v <= NDVI_STOPS[0][0]) return NDVI_STOPS[0][1];
  for (let i = 1; i < NDVI_STOPS.length; i++) {
    const [v1, c1] = NDVI_STOPS[i];
    if (v <= v1) {
      const [v0, c0] = NDVI_STOPS[i - 1];
      const t = (v - v0) / (v1 - v0);
      return c0.map((c, k) => Math.round(c + (c1[k] - c) * t));
    }
  }
  return NDVI_STOPS[NDVI_STOPS.length - 1][1];
}

/**
 * Build RGBA buffers for the two PNGs. `grid` holds per-pixel arrays of length
 * W*H: red/green/blue reflectance, ndvi, and `inside` (1 inside polygon with valid data).
 * Pure: returns Uint8Array RGBA buffers, encoding happens in the caller.
 */
function renderRgba(grid, W, H) {
  const tc = new Uint8Array(W * H * 4);
  const nd = new Uint8Array(W * H * 4);
  const stretch = (v) => Math.round(255 * Math.min(1, Math.max(0, v) / 0.28) ** (1 / 1.25));
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (!grid.inside[i]) { tc[o + 3] = 0; nd[o + 3] = 0; continue; }
    tc[o] = stretch(grid.red[i]);
    tc[o + 1] = stretch(grid.green[i]);
    tc[o + 2] = stretch(grid.blue[i]);
    tc[o + 3] = 255;
    const [r, g, b] = ndviColour(grid.ndvi[i]);
    nd[o] = r; nd[o + 1] = g; nd[o + 2] = b; nd[o + 3] = 255;
  }
  return { trueColour: tc, ndviMap: nd };
}

/* ------------------------------ Network: scene search ---------------------- */

/**
 * Newest low-cloud Sentinel-2 L2A scene covering the AOI centre within `days`.
 * Returns the STAC feature (with asset hrefs) or null.
 */
async function findScene({ lat, lon, days = 60, maxCloud = 40, fetchJson }) {
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const body = {
    collections: ['sentinel-2-l2a'],
    intersects: { type: 'Point', coordinates: [lon, lat] },
    datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
    limit: 12,
    query: { 'eo:cloud_cover': { lt: maxCloud } },
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  };
  const raw = await fetchJson(STAC_SEARCH, { method: 'POST', body });
  // Earth Search names assets by common band name (red, nir, swir16, ...).
  const feats = (raw.features || []).filter((f) => f.assets && f.assets.red && f.assets.nir && f.assets.swir16);
  if (!feats.length) return null;
  // Prefer the least cloudy of the most recent scenes: cloud cover first, then recency.
  feats.sort((a, b) => (a.properties['eo:cloud_cover'] ?? 100) - (b.properties['eo:cloud_cover'] ?? 100));
  const f = feats[0];
  return {
    id: f.id,
    datetime: f.properties.datetime,
    cloudCover: f.properties['eo:cloud_cover'] ?? null,
    epsg: f.properties['proj:epsg'] ?? null,
    assets: {
      B02: f.assets.blue?.href || null,
      B03: f.assets.green?.href || null,
      B04: f.assets.red?.href || null,
      B08: f.assets.nir?.href || null,
      B11: f.assets.swir16?.href || null,
    },
  };
}

/* ------------------------------ Network: windowed band reads --------------- */

/**
 * Read one band over the UTM bbox, resampled to the target grid (W x H).
 * Returns Float32Array reflectance (0..1) with NaN where the scene has no data.
 */
async function readBand(url, bbox, W, H) {
  const tiff = await geotiff().fromUrl(url);
  const img = await tiff.getImage();
  const [ix0, iy0, ix1, iy1] = img.getBoundingBox();
  const [rx, ry] = img.getResolution();
  const absRy = Math.abs(ry);
  const [minX, minY, maxX, maxY] = bbox;
  const c0 = Math.max(0, Math.floor((minX - ix0) / rx));
  const c1 = Math.min(img.getWidth(), Math.ceil((maxX - ix0) / rx));
  const r0 = Math.max(0, Math.floor((iy1 - maxY) / absRy));
  const r1 = Math.min(img.getHeight(), Math.ceil((iy1 - minY) / absRy));
  if (c1 <= c0 || r1 <= r0) throw new Error(`AOI lies outside scene ${url.split('/').slice(-2, -1)[0]}`);
  // interleave:true with one sample returns the band itself (not a per-band array).
  const raster = await img.readRasters({
    window: [c0, r0, c1, r1],
    width: W,
    height: H,
    samples: [0],
    interleave: true,
    resampleMethod: 'nearest',
  });
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) {
    const dn = raster[i];
    out[i] = dn > 0 && dn < 65535 ? dn / 10000 : NaN;
  }
  return out;
}

/* ------------------------------ Orchestration ------------------------------ */

/**
 * Full AOI analysis: find a scene, read B02/B03/B04/B08/B11 clipped to the
 * polygon, compute indices, summarise and render. `ring` is validated [lat,lon].
 */
async function analyseArea({ ring, fetchJson, days = 60, maxCloud = 40 }) {
  const cLat = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cLon = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const epsg = utmEpsg(cLat, cLon);
  const scene = await findScene({ lat: cLat, lon: cLon, days, maxCloud, fetchJson });
  if (!scene) {
    return { ok: false, status: 'no-scene', message: `No Sentinel-2 scene with under ${maxCloud}% cloud in the last ${days} days covers this area.` };
  }
  const sceneEpsg = scene.epsg || epsg;
  const utm = ringToUtm(ring, sceneEpsg);
  const [minX, minY, maxX, maxY] = ringBbox(utm);
  const W = Math.min(MAX_SIDE_PX, Math.max(2, Math.ceil((maxX - minX) / PIXEL_M)));
  const H = Math.min(MAX_SIDE_PX, Math.max(2, Math.ceil((maxY - minY) / PIXEL_M)));
  const bbox = [minX, minY, maxX, maxY];

  const bands = {};
  const readStarted = Date.now();
  await Promise.all(['B02', 'B03', 'B04', 'B08', 'B11'].map(async (k) => {
    bands[k] = await readBand(scene.assets[k], bbox, W, H);
  }));

  const n = W * H;
  const grid = {
    inside: new Uint8Array(n), red: new Float32Array(n), green: new Float32Array(n),
    blue: new Float32Array(n), ndvi: new Float32Array(n),
  };
  const pixels = [];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      // Pixel centre in UTM (row 0 is the northern edge).
      const x = minX + (c + 0.5) * ((maxX - minX) / W);
      const y = maxY - (r + 0.5) * ((maxY - minY) / H);
      if (!pointInRing(x, y, utm)) continue;
      const v = { blue: bands.B02[i], green: bands.B03[i], red: bands.B04[i], nir: bands.B08[i], swir: bands.B11[i] };
      if ([v.blue, v.green, v.red, v.nir, v.swir].some((q) => !Number.isFinite(q))) continue;
      const nd = ndvi(v.nir, v.red);
      grid.inside[i] = 1;
      grid.red[i] = v.red; grid.green[i] = v.green; grid.blue[i] = v.blue; grid.ndvi[i] = nd;
      pixels.push({ cls: classifyPixel(v), ndvi: nd, bsi: bsi(v.blue, v.red, v.nir, v.swir) });
    }
  }
  if (!pixels.length) {
    return { ok: false, status: 'no-valid-pixels', message: 'The scene has no valid (cloud-free, in-coverage) pixels under this area.', scene };
  }
  return {
    ok: true,
    scene,
    grid: { W, H, pixelM: PIXEL_M, bbox, epsg: sceneEpsg },
    stats: summarizeClasses(pixels),
    renderGrid: { ...grid, W, H },
    timing: { readMs: Date.now() - readStarted },
  };
}

module.exports = {
  // pure
  validatePolygon, polygonAreaM2, pointInRing, ringBbox, utmEpsg, ringToUtm,
  ndvi, ndwi, bsi, classifyPixel, summarizeClasses, ndviColour, renderRgba,
  // network
  findScene, readBand, analyseArea,
  PIXEL_M, MAX_SIDE_PX, MAX_AREA_M2, MIN_AREA_M2,
};
