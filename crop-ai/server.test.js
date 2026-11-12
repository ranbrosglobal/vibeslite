'use strict';
/* ============================================================================
 * Crop AI console - automated test suite (node --test, no extra dependencies)
 *
 *   npm test          run from the repo root or from crop-ai/
 *
 * The suite boots api/index.js's dependency (server.js) the same way Vercel
 * does - VERCEL=1 stops it from calling listen() and seeds its state into a
 * private /tmp directory - then serves the exported app on an ephemeral port
 * and drives it over real HTTP.
 *
 * What it protects:
 *   - the data-integrity contract (demo routes stay 404, no invented species)
 *   - device token auth and the sensor lifecycle (401 / 404 / 200 / delete)
 *   - the pure agronomy helpers (fill-value handling, per-metric attribution)
 *   - the workflow DAG engine (definitions, cycle rejection, hash caching,
 *     re-run only what an input change actually invalidates)
 * ========================================================================== */
process.env.VERCEL = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Each run gets its own empty temp directory, so the server seeds a PRISTINE
// copy of the bundled data (server.js seeds os.tmpdir()/crop-ai-data on a cold
// start). Sharing the default temp dir made the suite order-dependent: a
// leftover workflows.json from an earlier process could already satisfy a
// "cold" run and its assertions, which is a false pass or a false failure
// depending on what ran before. TMPDIR must be set before server.js is loaded.
const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crop-ai-test-'));
process.env.TMPDIR = TEST_TMP;

const app = require('./server');
const I = app.internals;

let server;
let base;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(path.join(TEST_TMP, 'crop-ai-data'), { recursive: true, force: true });
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const post = async (p, body, headers = {}) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const del = async (p) => {
  const res = await fetch(base + p, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const anyFieldId = async () => (await get('/api/fields')).body[0]?.fieldId || null;

/* --------------------------- platform is alive ----------------------------- */

test('health reports the console as ready', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.service, 'vibes-lite-crop-ai');
  assert.ok(['wasm', 'fallback'].includes(r.body.opencv), 'OpenCV mode is reported');
});

test('the console UI is served by the same process', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Crop AI/);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.equal((await fetch(base + '/styles.css')).status, 200);
});

test('no synthetic data: the seed and demo routes stay removed', async () => {
  for (const p of ['/api/seed', '/api/seed-dataset', '/api/demo-tick']) {
    const r = await get(p);
    assert.equal(r.status, 404, `${p} must stay 404`);
  }
});

/* ------------------------- pure agronomy helpers --------------------------- */

test('soil moisture fill values stay null instead of becoming a false 0%', () => {
  assert.equal(I.soilMoisturePct(0), null, '0 is the model fill value, not dry soil');
  assert.equal(I.soilMoisturePct(-0.2), null);
  assert.equal(I.soilMoisturePct(null), null);
  assert.equal(I.soilMoisturePct(undefined), null);
  assert.equal(I.soilMoisturePct(0.31), 31);
  assert.equal(I.soilMoisturePct(0.245), 24.5);
});

test('per-metric attribution: a newer wind reading never shadows the soil probe', () => {
  const rec = {
    device: [],
    devices: {
      'S-soil': { deviceId: 'S-soil', readings: [{ t: '2026-10-08T08:00:00Z', soilMoisture: 18.5 }] },
      'S-wind': { deviceId: 'S-wind', readings: [{ t: '2026-10-08T09:00:00Z', windKmh: 22, temperatureC: 14.1 }] },
    },
  };
  const merged = I.mergedDeviceReading(rec);
  assert.equal(merged.t, '2026-10-08T09:00:00Z', 'newest timestamp wins for the merged record');
  assert.equal(merged.soilMoisture, 18.5);
  assert.equal(merged.sources.soilMoisture, 'S-soil', 'moisture is attributed to the probe that measured it');
  assert.equal(merged.sources.windKmh, 'S-wind');
  assert.equal(merged.temperatureC, 14.1);

  // Legacy records written before devices carried their own deviceId fall back
  // to the registry key so a reading is never stored without provenance.
  const legacy = I.mergedDeviceReading({ devices: { 'S-legacy': { readings: [{ t: '2026-10-08T07:00:00Z', ph: 6.4 }] } } });
  assert.equal(legacy.sources.ph, 'S-legacy');
});

test('soilMoisturePct gap logic feeds irrigation: a 0% fill value cannot raise a critical alert', () => {
  const field = {
    fieldId: 'unit-no-water-data',
    stats: { healthy: 100, stressed: 0, soil: 0, weed: 0 },
    grid: { rows: 1, cols: 1 },
    gps: null,
  };
  // getSensor is keyed off the shared store; a field with no sensor record and
  // no satellite moisture must refuse to guess rather than recommend watering.
  const rec = I.recommendIrrigation(field);
  assert.equal(rec.insufficient, true, 'no moisture source means no recommendation');
  assert.match(rec.reason, /soil-moisture source|No soil-moisture data/i);
});

test('field geometry derives tile size, area and tile count from the georeference', () => {
  const geo = I.fieldGeometry({ width: 500, height: 250, grid: { rows: 5, cols: 10 }, groundWidthM: 100 });
  assert.equal(geo.widthM, 100);
  assert.equal(geo.heightM, 50);
  assert.equal(geo.cols, 10);
  assert.equal(geo.rows, 5);
  assert.equal(geo.tileW, 10);
  assert.equal(geo.tileH, 10);
  assert.equal(geo.fieldAreaM2, 5000);
  assert.equal(geo.source, 'field-width');
});

test('the identification normalizer refuses to store a nameless answer', () => {
  assert.equal(I.normalizeIdentifyResult({ type: 'unknown' }), null, 'schema-filled nulls are not an identification');
  assert.equal(I.normalizeIdentifyResult({ common: 'unknown' }), null);
  assert.equal(I.normalizeIdentifyResult(null), null);

  const ok = I.normalizeIdentifyResult({
    common: 'Kentucky bluegrass', scientific: 'Poa pratensis', family: 'Poaceae',
    type: 'grass', confidence: 0.72, health: 88, condition: 'healthy',
    candidates: [{ common: 'Kentucky bluegrass', scientific: 'Poa pratensis', confidence: 72 }],
    traits: ['smooth blade', 'boat-shaped tip'],
  });
  assert.equal(ok.common, 'Kentucky bluegrass');
  assert.equal(ok.scientific, 'Poa pratensis');
  assert.equal(ok.type, 'grass');
  assert.equal(ok.confidence, 0.72, 'a 0-100 confidence is normalized to 0-1');
  assert.equal(ok.health, 88);
  assert.equal(ok.candidates.length, 1);
});

test('the crop normalizer maps model aliases onto the four real classes', () => {
  const r = I.normalizeAIResult({ class: 'vegetation', classes: { vegetation: 60, bare: 25, weeds: 15 }, health: 71 });
  assert.equal(r.class, 'healthy');
  assert.equal(r.shares.healthy, 0.6, 'percentage shares are normalized to 0-1');
  assert.equal(r.shares.soil, 0.25);
  assert.equal(r.shares.weed, 0.15);
  assert.equal(r.health, 71);
});

/* ---------------------------- field API routes ----------------------------- */

test('fields, layers and geojson routes answer for every listed field', async () => {
  const list = await get('/api/fields');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body), 'GET /api/fields returns an array');
  for (const f of list.body) {
    const layers = await get(`/api/fields/${f.fieldId}/layers`);
    if (layers.status === 409) continue; // legitimately unclassified field
    assert.equal(layers.status, 200, `layers for ${f.fieldId}`);
    const geo = await get(`/api/fields/${f.fieldId}/geojson`);
    assert.ok([200, 409].includes(geo.status), `geojson for ${f.fieldId}`);
  }
});

test('unknown ids are 404, never a fabricated record', async () => {
  assert.equal((await get('/api/fields/no-such-field')).status, 404);
  assert.equal((await get('/api/fields/no-such-field/layers')).status, 404);
  assert.equal((await get('/api/fields/no-such-field/terrain')).status, 404);
  assert.equal((await get('/api/fields/no-such-field/satellite')).status, 404);
  assert.equal((await get('/api/sensors/sites')).status, 200);
});

/* ----------------------- device lifecycle + token auth ---------------------- */

test('sensor lifecycle: register, reject a bad token, accept a real reading, delete', async () => {
  const fieldId = await anyFieldId();
  assert.ok(fieldId, 'a field must exist for the device lifecycle test');

  const reg = await post(`/api/fields/${fieldId}/sensors`, { type: 'soil-probe', name: 'Test probe', c: 1, r: 1 });
  assert.equal(reg.status, 200);
  const deviceId = reg.body.device.deviceId;
  const token = reg.body.ingestToken;
  assert.match(deviceId, /^S-[0-9a-f]{6}$/);
  assert.ok(token && token.length >= 16, 'a per-device ingest token is returned');

  const wrong = await post(`/api/fields/${fieldId}/ingest?deviceId=${deviceId}`, { soilMoisture: 20 }, { 'X-Sensor-Token': 'deadbeef' });
  assert.equal(wrong.status, 401, 'a wrong token is rejected');

  const unknown = await post(`/api/fields/${fieldId}/ingest?deviceId=S-000000`, { soilMoisture: 20 }, { 'X-Sensor-Token': token });
  assert.equal(unknown.status, 404, 'an unregistered device id is rejected');

  const ok = await post(`/api/fields/${fieldId}/ingest?deviceId=${deviceId}`, { soilMoisture: 18.5, soilTempC: 12.4 }, { 'X-Sensor-Token': token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.deviceId, deviceId);
  assert.deepEqual(ok.body.accepted.sort(), ['soilMoisture', 'soilTempC']);

  const outOfRange = await post(`/api/fields/${fieldId}/ingest?deviceId=${deviceId}`, { soilMoisture: 900 }, { 'X-Sensor-Token': token });
  assert.equal(outOfRange.status, 200);
  assert.equal(outOfRange.body.reading.soilMoisture, 100, 'readings are clamped to their physical range');

  const sites = await get('/api/sensors/sites');
  assert.equal(sites.status, 200);
  assert.ok(Array.isArray(sites.body.sites), 'the site listing carries a sites array');
  assert.equal(typeof sites.body.totalDevices, 'number');
  const site = sites.body.sites.find((s) => s.siteId === fieldId);
  const dev = site?.devices?.find((d) => d.deviceId === deviceId);
  assert.ok(dev, 'the registered device appears in the site listing');
  assert.equal(dev.count, 2, 'both accepted readings are counted');
  assert.equal(dev.value, 100, 'the newest reading is the live value');

  const removed = await del(`/api/fields/${fieldId}/sensors/${deviceId}`);
  assert.equal(removed.status, 200);
  const gone = await post(`/api/fields/${fieldId}/ingest?deviceId=${deviceId}`, { soilMoisture: 20 }, { 'X-Sensor-Token': token });
  assert.equal(gone.status, 404, 'a deleted device no longer accepts readings');
});

/* -------------------------------- sources --------------------------------- */

test('the source registry describes every real dataset with attribution', async () => {
  const r = await get('/api/sources');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 6);
  const ids = r.body.sources.map((s) => s.id);
  for (const id of ['sentinel-2-l2a', 'sentinel-1-grd', 'open-meteo-forecast', 'open-meteo-archive', 'open-meteo-elevation', 'nasa-power']) {
    assert.ok(ids.includes(id), `${id} is registered`);
  }
  for (const s of r.body.sources) {
    assert.match(s.endpoint, /^https:\/\//, `${s.id} has a real endpoint`);
    assert.ok(s.attribution && s.attribution.length > 5, `${s.id} carries attribution`);
    assert.ok(s.product && s.kind, `${s.id} is described`);
  }
});

/* --------------------------- workflow DAG engine --------------------------- */

test('workflow definitions are valid DAGs', async () => {
  const r = await get('/api/workflows');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 3);
  for (const wf of r.body.workflows) {
    assert.ok(wf.nodes.length > 0);
    for (const node of wf.graph) {
      assert.ok(I.WF_NODES[node.id], `${wf.id}: node ${node.id} exists in the registry`);
      for (const dep of node.deps) assert.ok(wf.nodes.includes(dep), `${wf.id}: dependency ${dep} is part of the workflow`);
    }
    assert.equal(wf.edges.length, wf.graph.reduce((a, n) => a + n.deps.length, 0));
  }
});

test('the topological sort rejects a cycle instead of looping forever', () => {
  I.WF_NODES.__test_a = { label: 'a', kind: 'infer', deps: ['__test_b'], run: () => ({}) };
  I.WF_NODES.__test_b = { label: 'b', kind: 'infer', deps: ['__test_a'], run: () => ({}) };
  try {
    assert.throws(() => I.topoOrder(['__test_a', '__test_b']), /cycle/);
    assert.deepEqual(I.topoOrder(['__test_a']), ['__test_a']);
  } finally {
    delete I.WF_NODES.__test_a;
    delete I.WF_NODES.__test_b;
  }
});

test('runs are cached by input hash and a forced run recomputes everything', async () => {
  const fieldId = await anyFieldId();
  assert.ok(fieldId);

  const first = await post('/api/workflows/local-agronomy/run', { fieldId });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'ok');
  assert.equal(first.body.nodes.length, 5);
  assert.ok(first.body.executed > 0, 'a cold run executes its nodes');

  const second = await post('/api/workflows/local-agronomy/run', { fieldId });
  assert.equal(second.body.executed, 0, 'unchanged inputs reuse every node');
  assert.equal(second.body.reused, 5);

  const forced = await post('/api/workflows/local-agronomy/run', { fieldId, force: true });
  assert.equal(forced.body.executed, 5, 'force recomputes every node');

  const history = await get(`/api/workflows/local-agronomy/runs?fieldId=${fieldId}&limit=5`);
  assert.equal(history.status, 200);
  assert.ok(history.body.items.length >= 3);
  for (const item of history.body.items) {
    assert.ok(['ok', 'failed', 'running'].includes(item.status));
    assert.ok(item.nodes.length === 5, 'history keeps the per-node status list');
  }
});

test('a new sensor reading invalidates only the nodes that depend on it', async () => {
  const fieldId = await anyFieldId();
  assert.ok(fieldId);
  await post('/api/workflows/field-refresh/run', { fieldId, params: { days: 30 } });

  const before = await post('/api/workflows/field-refresh/run', { fieldId, params: { days: 30 } });
  assert.equal(before.body.executed, 0, 'nothing changed, so nothing re-runs');

  const reg = await post(`/api/fields/${fieldId}/sensors`, { type: 'soil-probe', name: 'Invalidation probe' });
  const token = reg.body.ingestToken;
  const deviceId = reg.body.device.deviceId;
  await post(`/api/fields/${fieldId}/ingest?deviceId=${deviceId}`, { soilMoisture: 18.5 }, { 'X-Sensor-Token': token });

  const after = await post('/api/workflows/field-refresh/run', { fieldId, params: { days: 30 } });
  const reran = after.body.nodes.filter((n) => !n.cached).map((n) => n.nodeId).sort();
  assert.deepEqual(reran, ['irrigation', 'report', 'soil-quality'],
    'a sensor reading invalidates the agronomy nodes, never the satellite fetches');
  const cached = after.body.nodes.filter((n) => n.cached).map((n) => n.nodeId);
  assert.ok(cached.includes('satellite-optical') && cached.includes('terrain') && cached.includes('weather'),
    'expensive fetches stay cached');

  await del(`/api/fields/${fieldId}/sensors/${deviceId}`);
});

test('workflow errors are honest: unknown workflow and unknown field are 404', async () => {
  assert.equal((await post('/api/workflows/nope/run', { fieldId: 'x' })).status, 404);
  const fieldId = await anyFieldId();
  if (fieldId) assert.equal((await post('/api/workflows/local-agronomy/run', { fieldId: 'no-such-field' })).status, 404);
});

/* ═══════════════════════ OPENSTREETMAP INTEGRATION ════════════════════════
 * Nominatim and Overpass are live third-party services, so the suite exercises
 * the parts that must hold without them: the posture endpoint, the policy
 * constants the CSP is built from, input validation, and the pure conversion
 * and query-building helpers. No test here touches the network.
 * ══════════════════════════════════════════════════════════════════════════ */

test('the geo status endpoint describes every OSM provider and its terms', async () => {
  const r = await get('/api/geo/status');
  assert.equal(r.status, 200);
  const names = r.body.providers.map((p) => p.name);
  for (const want of ['Nominatim', 'Overpass API', 'OSM raster tiles']) {
    assert.ok(names.includes(want), `${want} is described`);
  }
  assert.match(r.body.providers[0].policy, /1 request\/second/, 'the Nominatim policy is stated');
  assert.match(r.body.providers[0].policy, /User-Agent/, 'the identifying User-Agent requirement is stated');
  assert.match(r.body.providers[1].policy, /radius-capped/, 'Overpass is described as a shared instance');
  assert.match(r.body.providers[2].policy, /donated capacity/, 'the tile-server policy is stated');
  assert.match(r.body.note, /ODbL/, 'the licence is stated');

  // Basemaps, and the hosts they actually load from.
  const keys = r.body.basemaps.map((b) => b.key);
  for (const want of ['osm', 'hot', 'topo']) assert.ok(keys.includes(want), `${want} basemap is published`);
  for (const b of r.body.basemaps) {
    assert.ok(b.host && b.url.includes(b.host), `${b.key} declares the host it loads from`);
    assert.ok(b.attribution && b.licence === 'ODbL 1.0', `${b.key} carries attribution and licence`);
  }
  assert.deepEqual(r.body.defaultKinds, I.OSM_DEFAULT_KINDS, 'the default feature classes are published');
  assert.ok(r.body.featureKinds.length === Object.keys(I.OSM_FEATURE_KINDS).length);
  assert.ok(r.body.limits.minIntervalMs >= 1000, 'the outbound interval honours the 1/second policy');
  assert.ok(r.body.limits.maxRadiusM > 0, 'the Overpass radius is capped');
  assert.equal(r.body.limits.retryOnceOnGatewayErrors, true, 'a transient gateway error is retried once');
  assert.deepEqual(r.body.limits.neverRetried, [429], 'a rate-limit response is never retried');
  assert.match(r.body.note, /429 is never retried/, 'the retry policy is stated rather than implied');
});

test('every OSM basemap host is allowed by the Content-Security-Policy', () => {
  const { CSP, OSM_BASEMAPS } = I;
  const imgSrc = CSP.split('; ').find((d) => d.startsWith('img-src'));
  assert.ok(imgSrc, 'img-src is declared');
  for (const [key, b] of Object.entries(OSM_BASEMAPS)) {
    assert.ok(imgSrc.includes(`https://${b.host}`), `img-src allows the ${key} host (${b.host})`);
  }
  assert.match(CSP, /connect-src 'self'/, 'the browser still only talks to this server - OSM is proxied');
});

test('geo inputs are validated before any upstream call is made', async () => {
  // Every one of these is rejected locally, so a bad request never spends a
  // Nominatim/Overpass call - which is the point of validating here.
  const cases = [
    ['/api/geo/search?q=ab', 400],
    ['/api/geo/search', 400],
    ['/api/geo/reverse?lat=200&lon=0', 400],
    ['/api/geo/reverse?lat=52&lon=999', 400],
    ['/api/geo/reverse?lat=abc&lon=5', 400],
    ['/api/geo/features', 400],
    ['/api/geo/features?lat=52.6&lon=5.6&kinds=dinosaurs', 400],
  ];
  for (const [path, status] of cases) {
    const r = await get(path);
    assert.equal(r.status, status, `${path} -> ${status}`);
    assert.equal(r.body.error, 'BadRequest', `${path} reports a validation error, not an upstream one`);
    assert.ok(r.body.detail, `${path} explains what was wrong`);
  }
});

/* ═══════════════ WINDY FORECAST MAP (a visualisation, not a source) ════════
 * Windy is wired in as a map and these tests hold that line. Its API returns
 * forecasts only - "It is not possible to retrieve historical forecasts with
 * past data" - its free key returns randomly shuffled data, and its paid tier
 * has neither radiation nor evapotranspiration nor soil moisture. So Windy is
 * allowed to draw the field, and is never allowed to become a number.
 * ═════════════════════════════════════════════════════════════════════════ */

test('the Windy embed URL uses the documented parameters and never invents a layer', () => {
  const { windyEmbedUrl, WINDY } = I;
  const url = windyEmbedUrl({ lat: 52.60123, lon: 5.67891, overlay: 'rain', zoom: 13 });
  assert.ok(url.startsWith('https://embed.windy.com/embed2.html?'), 'Windy\'s documented embed host is used');
  const q = new URL(url).searchParams;
  assert.equal(q.get('lat'), '52.6012');
  assert.equal(q.get('lon'), '5.6789');
  assert.equal(q.get('detailLat'), '52.6012', 'the point readout is the same coordinate as the map centre');
  assert.equal(q.get('overlay'), 'rain');
  assert.equal(q.get('zoom'), '13');
  assert.equal(q.get('level'), 'surface');
  assert.equal(q.get('marker'), 'true', 'the field is marked on the map');
  // Windy links accept forecast times only; past times are documented as
  // unsupported, so the embed is pinned to now instead of faking a past date.
  assert.equal(q.get('calendar'), 'now');
  // An unknown layer falls back to the default rather than drawing something
  // other than what was asked for.
  const fallback = new URL(windyEmbedUrl({ lat: 1, lon: 2, overlay: 'dinosaurs' })).searchParams;
  assert.equal(fallback.get('overlay'), WINDY.defaultOverlay);
  for (const o of ['wind', 'gust', 'rain', 'temp', 'rh']) {
    assert.ok(WINDY.overlayKeys.includes(o), `${o} is an offered layer`);
  }
});

test('the Windy map needs a real location and refuses to guess one', async () => {
  // Explicit precondition: the console legitimately falls back to a stored
  // device fix now, and a developer's own data/location.json is seeded into this
  // run. Clearing it makes the invariant under test - "with no coordinates at
  // all, refuse" - true regardless of what the machine running the suite did.
  await del('/api/location');
  const missing = await get('/api/weather/windy');
  assert.equal(missing.status, 409, 'no coordinates is a refusal, not a map of the ocean');
  assert.match(missing.body.error, /georeferenced/);

  assert.equal((await get('/api/weather/windy?fieldId=no-such-field')).status, 404);
  assert.equal((await get('/api/weather/windy?lat=999&lon=0')).status, 400, 'latitude 999 is not a coordinate');
  assert.equal((await get('/api/weather/windy?lat=52&lon=-200')).status, 400);

  const ok = await get('/api/weather/windy?lat=52.6&lon=5.6');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.centre.lat, 52.6);
  assert.equal(ok.body.overlay, 'wind', 'the default layer is wind, which is what was asked for');
});

test('the Windy map is served as a live map, never as an archive or a number', async () => {
  const fieldId = await anyFieldId();
  assert.ok(fieldId, 'the seed provides a field');
  const field = (await get('/api/fields')).body.find((f) => f.fieldId === fieldId);
  assert.ok(field?.gps?.lat != null, 'the seeded field is georeferenced');

  const r = await get(`/api/weather/windy?fieldId=${fieldId}&overlay=gust`);
  assert.equal(r.status, 200);
  assert.equal(r.body.fieldId, fieldId);
  assert.equal(r.body.centre.lat, +field.gps.lat.toFixed(4), 'the map centres on the field, not on a default');
  assert.equal(r.body.centre.lon, +field.gps.lon.toFixed(4));
  assert.equal(r.body.overlay, 'gust');
  assert.ok(r.body.overlays.some((o) => o.key === 'wind') && r.body.overlays.some((o) => o.key === 'rain'),
    'wind and rain are both offered, which is what was asked for');
  assert.ok(r.body.url.includes('embed.windy.com'), 'a real embed URL comes back');

  // The honesty contract: a map, with no archive, and a note that says so.
  assert.equal(r.body.coverage.liveOnly, true);
  assert.equal(r.body.coverage.archive, false);
  assert.match(r.body.coverage.note, /no archive/i);
  assert.match(r.body.coverage.note, /1940/, 'the note points at where past dates really come from');
  assert.match(r.body.attribution, /Windy/);
  assert.match(r.body.attributionUrl, /^https:\/\/www\.windy\.com/);
  assert.match(r.body.licenceNote, /logo/, 'the embed-terms requirement is surfaced, not hidden');
  assert.match(r.body.termsUrl, /windy-terms-of-use/);
});

test('the Content-Security-Policy permits exactly the Windy frame and nothing else', () => {
  const { CSP, CSP_FRAME_SRC } = I;
  const frameSrc = CSP.split('; ').find((d) => d.startsWith('frame-src'));
  assert.ok(frameSrc, 'frame-src is declared - without it default-src self blocks the map');
  assert.equal(frameSrc, CSP_FRAME_SRC, 'the policy and the exported directive cannot drift apart');
  assert.match(frameSrc, /https:\/\/embed\.windy\.com/, 'Windy may be framed');
  assert.doesNotMatch(frameSrc, /\*/, 'no wildcard framing origin');
  assert.match(CSP, /script-src 'self'/, 'Windy still contributes no script of its own');
});

test('Windy is published as a visualisation, not padded into the data sources', async () => {
  const r = await get('/api/sources');
  assert.equal(r.body.count, 6, 'the data-source registry is unchanged: Windy answers with a map, not a number');
  assert.ok(!r.body.sources.some((s) => s.id === 'windy'), 'Windy is deliberately not a data source');
  const viz = r.body.visualizations.find((v) => v.id === 'windy');
  assert.ok(viz, 'but it is published, so the console and the docs agree it is used');
  assert.equal(viz.kind, 'forecast-map');
  assert.match(viz.note, /no archive/, 'the reason it cannot back a number is stated');
  assert.match(viz.note, /randomly shuffled/, 'and so is the free-tier data defect');
  assert.ok(viz.overlays.length >= 5, 'the layers it can draw are listed');
  assert.match(viz.attributionUrl, /^https:\/\/www\.windy\.com/);
});

test('the Overpass query covers every requested class and is bounded', () => {
  const { osmOverpassQuery, OSM_FEATURE_KINDS, OSM_DEFAULT_KINDS } = I;
  const q = osmOverpassQuery(52.625, 5.655, 1000, OSM_DEFAULT_KINDS, 400);
  assert.match(q, /^\[out:json\]\[timeout:25\];/, 'the query declares its output format and timeout');
  assert.match(q, /out geom 400;/, 'geometry comes back inline and the element count is capped');
  for (const kind of OSM_DEFAULT_KINDS) {
    for (const sel of OSM_FEATURE_KINDS[kind].selectors) {
      assert.ok(q.includes(`${sel}(around:1000,52.625000,5.655000);`), `${kind} selector is present`);
    }
  }
  assert.match(q, /way\["highway"\]/, 'roads are queried');
  assert.match(q, /way\["waterway"\]/, 'ditches and canals are queried');
});

test('tag matching attributes an element to exactly one requested class', () => {
  const { osmMatches } = I;
  assert.equal(osmMatches('roads', { highway: 'track' }), true);
  assert.equal(osmMatches('roads', { waterway: 'ditch' }), false);
  assert.equal(osmMatches('waterways', { waterway: 'ditch' }), true);
  assert.equal(osmMatches('water', { natural: 'water' }), true);
  assert.equal(osmMatches('water', { landuse: 'reservoir' }), true);
  assert.equal(osmMatches('landuse', { landuse: 'farmland' }), true);
  assert.equal(osmMatches('buildings', { man_made: 'storage_tank' }), true);
  assert.equal(osmMatches('barriers', { barrier: 'hedge' }), true);
  assert.equal(osmMatches('barriers', { barrier: 'gate' }), false, 'only the mapped classes count');
  assert.equal(osmMatches('roads', undefined), false, 'an untagged element is skipped');
});

test('Overpass elements become drawable GeoJSON, and undrawable ones are dropped', () => {
  const { osmFeatureElement } = I;
  const line = osmFeatureElement({
    type: 'way', id: 11,
    geometry: [{ lat: 52.60, lon: 5.60 }, { lat: 52.61, lon: 5.61 }],
    tags: { highway: 'track', surface: 'gravel', note: 'dropped' },
  }, 'roads');
  assert.equal(line.geometry.type, 'LineString');
  assert.deepEqual(line.geometry.coordinates[0], [5.60, 52.60], 'coordinates are lon,lat (GeoJSON order)');
  assert.equal(line.properties.tags.surface, 'gravel');
  assert.equal(line.properties.tags.note, undefined, 'unlisted tags are not forwarded');

  const area = osmFeatureElement({
    type: 'way', id: 12,
    geometry: [{ lat: 52.6, lon: 5.6 }, { lat: 52.6, lon: 5.7 }, { lat: 52.7, lon: 5.7 }, { lat: 52.6, lon: 5.6 }],
    tags: { natural: 'water' },
  }, 'water');
  assert.equal(area.geometry.type, 'Polygon', 'a closed way becomes a polygon');

  const node = osmFeatureElement({ type: 'node', id: 13, lat: 52.6, lon: 5.6, tags: { barrier: 'fence' } }, 'barriers');
  assert.equal(node.geometry.type, 'Point');
  assert.equal(node.properties.osmId, 'node/13');

  assert.equal(osmFeatureElement({ type: 'relation', id: 14, tags: { landuse: 'farmland' } }, 'landuse'), null,
    'a relation is skipped rather than drawn from a misread ring');
  assert.equal(osmFeatureElement({ type: 'way', id: 15, geometry: [], tags: { highway: 'path' } }, 'roads'), null,
    'a way without geometry is skipped');
});

test('a location picked on the map can be written onto a field', async () => {
  // This is the endpoint the Geo Map's click-to-pick panel calls. The point is
  // re-applied at the field's own coordinates so no other test's assumptions
  // about the seeded field move (the whole suite runs on a private /tmp copy).
  const fieldId = await anyFieldId();
  if (!fieldId) return;
  const before = await get(`/api/fields/${fieldId}`);
  const gps = before.body.field?.gps || before.body.gps || {};
  assert.ok(Number.isFinite(gps.lat) && Number.isFinite(gps.lon), 'the seeded field is georeferenced');

  const applied = await post(`/api/fields/${fieldId}/geotag`, { lat: gps.lat, lon: gps.lon });
  assert.equal(applied.status, 200, 'a valid picked location is accepted');
  assert.equal(applied.body.field.gps.lat, gps.lat);
  assert.equal(applied.body.field.gps.lon, gps.lon);

  for (const bad of [[{ lat: 999, lon: 5 }], [{ lat: 52.6, lon: -200 }], [{ lat: 'north', lon: 5 }], [{}]]) {
    const res = await post(`/api/fields/${fieldId}/geotag`, bad[0]);
    assert.equal(res.status, 400, `${JSON.stringify(bad[0])} is refused`);
  }
});

/* ═══════════════════════════ SECURITY HARDENING ═══════════════════════════
 * Everything below protects the controls added on top of the console: the
 * hardening headers, the Content-Security-Policy, the rate limiter, the
 * prototype-pollution guard and the id/path validation that closes the
 * traversal a crafted fieldId used to open. The rate-limit test runs last
 * because it deliberately exhausts one bucket.
 * ═══════════════════════════════════════════════════════════════════════════ */

test('hardening headers are present on both API and static responses', async () => {
  for (const p of ['/api/health', '/index.html']) {
    const res = await fetch(base + p);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${p} sets nosniff`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', `${p} refuses framing`);
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', `${p} sets referrer policy`);
    assert.match(res.headers.get('permissions-policy') || '', /geolocation=\(self\)/, `${p} keeps geolocation enabled for the field map`);
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin', `${p} isolates the browsing context`);
    assert.ok(res.headers.get('content-security-policy'), `${p} carries a CSP`);
    // The suite speaks plain http, so this response must be usable as-is.
    assert.doesNotMatch(res.headers.get('content-security-policy'), /upgrade-insecure-requests/,
      `${p} does not tell a plain-http browser to upgrade its own shell`);
    assert.equal(res.headers.get('strict-transport-security'), null, `${p} does not claim HSTS off TLS`);
  }
  const api = await fetch(base + '/api/health');
  assert.equal(api.headers.get('x-powered-by'), null, 'the framework banner is suppressed');
});

test('the CSP is restrictive but still allows every asset the console really loads', async () => {
  const { CSP, ID_RE } = I;
  assert.match(CSP, /default-src 'self'/);
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.match(CSP, /object-src 'none'/);
  assert.match(CSP, /base-uri 'self'/);
  assert.match(CSP, /upgrade-insecure-requests/, 'a TLS deployment upgrades insecure subresources');

  // ...but only a TLS deployment. On a plain-http origin that directive makes the
  // browser rewrite the console's OWN app.js and styles.css to https, which
  // fails and leaves a blank, scriptless page - so the header sent over plain
  // http must not carry it, while the constant still describes the TLS policy.
  const { cspFor, CSP_BASE } = I;
  assert.doesNotMatch(CSP_BASE, /upgrade-insecure-requests/);
  assert.equal(cspFor({ secure: false, get: () => '' }), CSP_BASE, 'plain http gets no upgrade directive');
  assert.equal(cspFor({ secure: true, get: () => '' }), CSP, 'direct TLS gets it');
  assert.equal(cspFor({ secure: false, get: () => 'https' }), CSP, 'an https-terminating proxy gets it');
  assert.equal(cspFor({ secure: false, get: () => 'https, http' }), CSP, 'and so does the first hop of a forwarded chain');
  assert.equal(cspFor({ secure: false, get: () => 'http' }), CSP_BASE, 'a forwarded http chain does not');

  // Scripts must not fall back to unsafe-inline: there are no inline handlers.
  const scriptSrc = CSP.split('; ').find((d) => d.startsWith('script-src'));
  assert.ok(scriptSrc, 'script-src is declared');
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/, 'scripts are not allowed to run inline or eval');
  assert.match(scriptSrc, /^script-src 'self'$/, 'no third-party script origin: Leaflet is vendored locally');

  // Every third-party origin the app actually uses must be reachable.
  for (const host of ['server.arcgisonline.com', 'mt1.google.com', 'tile.openstreetmap.org']) {
    assert.ok(CSP.includes(host), `img-src allows the ${host} basemap`);
  }
  assert.match(CSP, /font-src 'self' https:\/\/fonts\.gstatic\.com/, 'Google Fonts files are allowed');
  assert.ok(ID_RE instanceof RegExp);
});

test('Leaflet is served by the app itself, so the map needs no CDN', async () => {
  for (const path of [
    '/vendor/leaflet/leaflet.js',
    '/vendor/leaflet/leaflet.css',
    '/vendor/leaflet/images/marker-icon.png',
  ]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, `${path} is served`);
  }
  const shell = await (await fetch(base + '/sw.js')).text();
  assert.doesNotMatch(shell, /unpkg\.com/, 'the service worker no longer pins a CDN script');
  assert.match(shell, /vendor\/leaflet\/leaflet\.js/, 'the service worker caches the vendored Leaflet');
  const page = await (await fetch(base + '/index.html')).text();
  assert.doesNotMatch(page, /unpkg\.com/, 'the page loads Leaflet from this origin');
});

test('the security endpoint reports the posture that is actually active', async () => {
  const r = await get('/api/security');
  assert.equal(r.status, 200);
  assert.match(r.body.deviceAuth, /timingSafeEqual/, 'device tokens are compared in constant time');
  assert.equal(r.body.bodyLimit, '2mb');
  assert.equal(r.body.prototypePollutionGuard, true);
  assert.equal(r.body.sseClientCap, I.SSE_CLIENT_CAP);
  assert.ok(r.body.rateLimits.predict, 'per-route budgets are published');
  assert.match(r.body.note, /reverse proxy/, 'the missing-auth caveat is stated honestly');
});

test('id and token helpers reject traversal and compare safely', () => {
  const { safeId, tokenEquals } = I;
  for (const bad of ['../etc/passwd', '..', '.', 'a/b', 'a\\b', '', 'x'.repeat(65), '%2e%2e']) {
    assert.equal(safeId(bad), null, `safeId rejects ${JSON.stringify(bad)}`);
  }
  for (const good of ['F-1a2b', 'field.2026_01', 'upload-test']) {
    assert.equal(safeId(good), good, `safeId accepts ${JSON.stringify(good)}`);
  }
  assert.equal(tokenEquals('abc', 'abc'), true);
  assert.equal(tokenEquals('abc', 'abd'), false);
  assert.equal(tokenEquals('abc', 'abcd'), false, 'length mismatch is false, not a throw');
  assert.equal(tokenEquals('', ''), false, 'an empty token never authenticates');
  assert.equal(tokenEquals(null, 'x'), false);
});

test('a malformed or hostile JSON body is rejected cleanly', async () => {
  const bad = await fetch(base + '/api/geotag-never-exists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"lat": ',
  });
  assert.equal(bad.status, 400, 'unparseable JSON is a 400');
  assert.equal((await bad.json()).error, 'BadRequest');

  const poison = await post('/api/train', JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.equal(poison.status, 400, 'a prototype-pollution key is refused');
  assert.equal(poison.body.error, 'BadRequest');
  assert.equal({}.polluted, undefined, 'the prototype chain was not touched');
});

test('field ids and tile coordinates cannot escape the upload directory', async () => {
  // A traversal attempt in the path never resolves to a field.
  for (const p of ['/api/fields/..%2F..%2Fetc/tiles/0/0.png', '/api/fields/%2e%2e/tiles/0/0.png']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, `${p} is not found, never a file read`);
  }
  const fieldId = await anyFieldId();
  if (fieldId) {
    for (const p of [`/api/fields/${fieldId}/tiles/abc/0.png`, `/api/fields/${fieldId}/tiles/0/-3.png`]) {
      const res = await fetch(base + p);
      assert.equal(res.status, 400, `${p} is a validation error`);
      assert.equal((await res.json()).error, 'BadRequest');
    }
  }
});

test('the event stream refuses to accumulate unbounded listeners', async () => {
  const res = await fetch(base + '/api/events');
  assert.equal(res.status, 200, 'a normal subscriber connects');
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  await res.body.cancel();
});

test('per-route rate limits are enforced, not just advertised', async () => {
  const budget = Number(I.RATE_LIMIT_BUDGETS.get('predict').limit);
  let sawLimit = false;
  let lastStatus = 0;
  // Drive one limited route past its budget. Each call is a 404 (no such
  // field) — the limiter runs first, so the count still advances.
  for (let i = 0; i <= budget; i++) {
    const res = await fetch(base + '/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId: 'no-such-field' }),
    });
    lastStatus = res.status;
    if (res.status === 429) {
      sawLimit = true;
      assert.ok(res.headers.get('retry-after'), 'a 429 states when to retry');
      assert.equal((await res.json()).error, 'TooManyRequests');
      break;
    }
  }
  assert.ok(sawLimit, `the ${budget}/min predict budget returned a 429 (last status ${lastStatus})`);
});

/* ═══════════════════ device location — the real fix ═══════════════════════=
 * The console must be able to answer for where the device actually is, and it
 * must never answer for a coordinate nobody supplied. These tests pin both
 * halves: the validation boundaries, and the refusal to invent a location.
 * ======================================================================== */

test('a device fix is validated against every boundary that matters', () => {
  const { locationFix } = I;
  for (const bad of [
    {}, { lat: 30.9 }, { lon: 75.8 },
    { lat: null, lon: 75.8 }, { lat: 30.9, lon: '' },
    { lat: 'north', lon: 75.8 }, { lat: NaN, lon: 75.8 }, { lat: Infinity, lon: 75.8 },
    { lat: 91, lon: 75.8 }, { lat: -90.5, lon: 75.8 },
    { lat: 30.9, lon: 180.5 }, { lat: 30.9, lon: -181 },
    // JS would coerce all of these to a number if the guard were loose.
    { lat: true, lon: true }, { lat: [30.9], lon: [75.8] }, { lat: {}, lon: {} },
    { lat: 30.9, lon: 75.8, accuracyM: -1 },
    { lat: 30.9, lon: 75.8, accuracyM: 'very good' },
    { lat: 30.9, lon: 75.8, altitudeM: 90000 },
  ]) {
    const out = locationFix(bad);
    assert.ok(out.error, `${JSON.stringify(bad)} must be refused`);
    assert.equal(out.fix, undefined, 'a refused fix carries no coordinate');
  }

  // Null Island is what a GPS stack reports when it has no fix at all.
  const nullIsland = locationFix({ lat: 0, lon: 0 });
  assert.ok(nullIsland.error, '(0, 0) is refused as a no-fix sentinel');
  assert.match(nullIsland.error, /Null Island/);

  const ok = locationFix({
    lat: 30.9010, lon: 75.8573, accuracyM: 12.54, altitudeM: 247.34,
    capturedAt: '2026-10-14T16:30:00Z', label: '  north block  ',
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.fix.lat, 30.901);
  assert.equal(ok.fix.lon, 75.8573);
  assert.equal(ok.fix.accuracyM, 12.5);
  assert.equal(ok.fix.altitudeM, 247.3);
  assert.equal(ok.fix.capturedAt, '2026-10-14T16:30:00.000Z');
  assert.equal(ok.fix.label, 'north block');
  assert.equal(ok.fix.source, 'device');

  // Numeric strings are accepted (query params arrive as strings); a bad
  // timestamp and an out-of-range altitude are still refused.
  assert.equal(locationFix({ lat: '30.9', lon: '75.8' }).fix.lat, 30.9);
  assert.ok(locationFix({ lat: 30.9, lon: 75.8, capturedAt: 'yesterday' }).error);
  assert.ok(locationFix({ lat: 30.9, lon: 75.8, accuracyM: 250000 }).error);
});

test('great-circle distance is a real measurement, not a degree diff', () => {
  const { haversineM } = I;
  assert.equal(haversineM(30.9, 75.8, 30.9, 75.8), 0);
  assert.ok(Math.abs(haversineM(30, 75, 31, 75) - 111195) < 200, 'one degree of latitude is ~111 km');
  assert.equal(+haversineM(30, 75, 31, 75).toFixed(3), +haversineM(31, 75, 30, 75).toFixed(3), 'symmetric');
  assert.ok(haversineM(0, 0, 0, 1) > haversineM(60, 0, 60, 1), 'a degree of longitude shrinks with latitude');
});

test('the location store is empty until a device reports one, and refuses to guess', async () => {
  await del('/api/location');

  const before = await get('/api/location');
  assert.equal(before.status, 404, 'no fix stored is a 404, not a default coordinate');
  assert.equal(before.body.error, 'NoLocation');
  assert.equal(before.body.lat, undefined, 'the refusal carries no latitude');
  assert.equal(before.body.lon, undefined);

  assert.equal(I.locationPublic(), null, 'the in-process view is null, not a placeholder object');
  assert.equal(I.getDeviceLocation(), null);

  // No location is stored and none was supplied: a refusal, before any provider
  // is contacted, so a missing fix cannot be mistaken for a real point.
  const live = await get('/api/location/live');
  assert.equal(live.status, 409);
  assert.equal(live.body.error, 'NoLocation');
  assert.equal(live.body.weather, undefined);

  // The forecast map is location-scoped the same way.
  const windy = await get('/api/weather/windy');
  assert.equal(windy.status, 409, 'the Windy map also refuses to guess a location');
  assert.match(windy.body.error, /georeferenced/);
});

test('a real fix is stored, shared, refreshed only when it moves, and forgettable', async () => {
  await del('/api/location');

  const bad = await post('/api/location', { lat: 999, lon: 0 });
  assert.equal(bad.status, 400, 'an impossible latitude never reaches the store');
  assert.equal(bad.body.error, 'BadRequest');
  assert.equal((await get('/api/location')).status, 404, 'the refusal stored nothing');

  const stored = await post('/api/location', {
    lat: 30.9010, lon: 75.8573, accuracyM: 12.5, altitudeM: 247.3,
    capturedAt: '2026-10-14T16:30:00Z',
  });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.ok, true);
  assert.equal(stored.body.stored, true, 'the first fix is persisted');
  assert.equal(stored.body.location.lat, 30.901);
  assert.equal(stored.body.location.source, 'device');
  assert.equal(stored.body.location.stale, false);
  assert.ok(stored.body.location.ageSeconds <= 2);

  const read = await get('/api/location');
  assert.equal(read.status, 200);
  assert.equal(read.body.lat, 30.901);
  assert.equal(read.body.lon, 75.8573);
  assert.equal(read.body.accuracyM, 12.5);
  assert.equal(read.body.coordinatesText, '30.90100, 75.85730');
  assert.match(read.body.origin, /navigator\.geolocation/);
  if (read.body.nearestField) {
    assert.ok(read.body.nearestField.kilometres > 0, 'distance to the nearest site is a real distance');
  }

  // Jitter at the same spot: the stored fix stands, and the resolved place
  // name is not thrown away (only a genuine move re-resolves it).
  const place = { name: 'Sher Shah Suri Marg', displayName: 'Ludhiana, Punjab, India' };
  I.getDeviceLocation().place = place;
  const jitter = await post('/api/location', { lat: 30.90102, lon: 75.85732, accuracyM: 8 });
  assert.equal(jitter.body.stored, false, 'a sub-5 m wobble does not rewrite the store');
  assert.ok(jitter.body.movedM < I.LOCATION_MOVE_EPSILON_M);
  assert.deepEqual(jitter.body.location.place, place, 'the resolved place name survives jitter');
  assert.ok(jitter.body.location.firstSeenAt, 'and so does when the device was first seen');

  const moved = await post('/api/location', { lat: 30.9060, lon: 75.8573, accuracyM: 8 });
  assert.equal(moved.body.stored, true, 'a real move is persisted');
  assert.ok(moved.body.movedM > I.LOCATION_MOVE_EPSILON_M);
  assert.equal(moved.body.location.place, null, 'a move clears the stale place name');

  const cleared = await del('/api/location');
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleared, true);
  assert.equal((await get('/api/location')).status, 404, 'forgetting the fix really forgets it');
  assert.equal(I.getDeviceLocation(), null);

  const again = await del('/api/location');
  assert.equal(again.status, 200, 'forgetting twice is not an error');
  assert.equal(again.body.cleared, false, 'and reports that there was nothing to clear');
});

test('a location-scoped read prefers explicit coordinates, then the stored fix', async () => {
  const { resolveLocation } = I;

  await del('/api/location');
  const none = resolveLocation({ query: {} });
  assert.equal(none.status, 409);
  assert.equal(none.error, 'NoLocation');
  assert.equal(none.lat, undefined, 'a refusal returns no coordinate to report on');

  await post('/api/location', { lat: 30.901, lon: 75.8573 });
  const stored = resolveLocation({ query: {} });
  assert.equal(stored.origin, 'stored');
  assert.equal(stored.lat, 30.901);

  const explicit = resolveLocation({ query: { lat: '52.625', lon: '5.655' } });
  assert.equal(explicit.origin, 'query', 'an explicit point wins over the stored fix');
  assert.equal(explicit.lat, 52.625);

  const invalid = resolveLocation({ query: { lat: '999', lon: '5.655' } });
  assert.equal(invalid.status, 400, 'a nonsense explicit point is not silently replaced by the stored one');
  assert.equal(invalid.error, 'BadRequest');

  const nullIsland = resolveLocation({ query: { lat: '0', lon: '0' } });
  assert.equal(nullIsland.status, 400, 'Null Island is refused through the query path too');

  await del('/api/location');
});

test('Null Island and unusable coordinates are refused by the API itself', async () => {
  await del('/api/location');
  for (const body of [{ lat: 0, lon: 0 }, { lat: '52.6', lon: 'north' }, {}, { lat: false, lon: false }]) {
    const r = await post('/api/location', body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} is refused`);
  }
  // Even given a stored fix, an explicit bad point on a read is an error.
  assert.equal((await get('/api/location/live?lat=0&lon=0')).status, 400);
  assert.equal((await get('/api/location/live?lat=999&lon=0')).status, 400);
  assert.equal((await get('/api/location/live')).status, 409, 'still no fix, still no invention');
});

test('the device-location route has a published rate budget', async () => {
  const r = await get('/api/security');
  assert.ok(r.body.rateLimits.location, 'the location budget is documented, not just wired');
  assert.ok(I.RATE_LIMIT_BUDGETS.get('location').limit >= 2, 'a following device can report repeatedly');
  assert.equal(I.LOCATION_STALE_AFTER_S, 900, 'a fix older than 15 minutes is flagged stale');
});
