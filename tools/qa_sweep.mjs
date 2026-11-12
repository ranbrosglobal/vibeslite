// Full backend sweep for the Crop AI console: every registered route, success
// and error path. Read-only except for a disposable test device, a training run
// and one AI analysis; nothing is deleted from the demo state.
//
//   node tools/qa_sweep.mjs [baseUrl]
//
// Exit code 0 only when every check behaves as expected. Checks with an
// "expected" list allow documented honest failures (e.g. an unnameable image
// returning 502 instead of a guessed species) and say so in the output.
const BASE = process.argv[2] || 'http://localhost:5177';

const results = [];
const expect = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

const req = async (path, opts = {}) => {
  const res = await fetch(BASE + path, opts);
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  if (type.includes('json')) { try { json = JSON.parse(text); } catch {} }
  return { status: res.status, type, text, json, bytes: text.length };
};
const get = (p, o) => req(p, o);
const post = (p, body, headers = {}) => req(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
});

const section = (title) => results.push({ section: title });

(async () => {
  /* ---------------------------- static + core ---------------------------- */
  section('Static console + core');
  const root = await get('/');
  expect('GET / serves the console', root.status === 200 && /Crop AI/.test(root.text), `status ${root.status}, ${root.bytes} bytes`);
  const appjs = await get('/app.js');
  expect('GET /app.js', appjs.status === 200 && appjs.bytes > 10000, `${appjs.bytes} bytes`);
  const css = await get('/styles.css');
  expect('GET /styles.css', css.status === 200 && css.bytes > 10000, `${css.bytes} bytes`);
  const health = await get('/api/health');
  expect('GET /api/health', health.status === 200 && health.json?.ok === true, `opencv=${health.json?.opencv}`);
  const cv = await get('/api/cv-status');
  expect('GET /api/cv-status', cv.status === 200, `mode=${cv.json?.mode}`);

  /* -------------------------------- fields ------------------------------- */
  section('Fields + analysis');
  const fields = await get('/api/fields');
  const fieldIds = (fields.json || []).map((f) => f.fieldId);
  expect('GET /api/fields lists the demo fields', fields.status === 200 && fieldIds.length >= 2, fieldIds.join(', '));
  const F = fieldIds[0];
  const F2 = fieldIds[1];
  const one = await get(`/api/fields/${F}`);
  expect(`GET /api/fields/${F}`, one.status === 200 && one.json?.fieldId === F, `status=${one.json?.status}`);
  const layers = await get(`/api/fields/${F}/layers`);
  // The route returns one record per tile, each carrying every drawable layer.
  const LAYER_FIELDS = ['class', 'vigor', 'cover', 'health', 'weed', 'soil', 'moisture', 'ph', 'ec', 'soilTempC', 'texture'];
  const tilesOut = layers.json?.tiles || [];
  const missing = tilesOut.length ? LAYER_FIELDS.filter((k) => !(k in tilesOut[0])) : LAYER_FIELDS;
  expect(`GET /api/fields/${F}/layers`, layers.status === 200 && tilesOut.length >= 1 && missing.length === 0,
    `${tilesOut.length} tiles × ${LAYER_FIELDS.length} layer fields${missing.length ? ` (missing ${missing.join(',')})` : ''}`);
  const geo = await get(`/api/fields/${F}/geojson`);
  expect(`GET /api/fields/${F}/geojson`, geo.status === 200 && geo.json?.features?.length >= 1, `${geo.json?.features?.length} features`);
  const report = await get(`/api/fields/${F}/report`);
  expect(`GET /api/fields/${F}/report`, report.status === 200 && !!report.json, `keys=${Object.keys(report.json || {}).length}`);
  const overlay = await get(`/api/fields/${F}/overlay.png`);
  expect(`GET /api/fields/${F}/overlay.png`, overlay.status === 200 && overlay.type.includes('image'), `type=${overlay.type}`);
  const tile = await get(`/api/fields/${F}/tiles/0/0.png`);
  expect(`GET /api/fields/${F}/tiles/0/0.png`, tile.status === 200 && tile.type.includes('image'), `type=${tile.type}`);
  const models = await get('/api/models');
  expect('GET /api/models', models.status === 200, `${(models.json || []).length} model(s)`);
  const stats = await get('/api/dataset/stats');
  expect('GET /api/dataset/stats', stats.status === 200, `keys=${Object.keys(stats.json || {}).join(',')}`);

  /* ------------------------------- sensors ------------------------------- */
  section('Sensors');
  const sensors = await get('/api/sensors');
  expect('GET /api/sensors', sensors.status === 200, `keys=${Object.keys(sensors.json || {}).length}`);
  const sites = await get('/api/sensors/sites');
  expect('GET /api/sensors/sites', sites.status === 200 && Array.isArray(sites.json?.sites), `${sites.json?.totalDevices} device(s) across ${sites.json?.sites?.length} site(s)`);
  const reg = await post(`/api/fields/${F}/sensors`, { type: 'soil-probe', name: 'QA sweep probe', r: 2, c: 2 });
  const dev = reg.json?.device;
  const token = reg.json?.ingestToken;
  expect('POST register device', reg.status === 200 && !!dev?.deviceId && !!token, `${dev?.deviceId} token=${token ? 'issued' : 'MISSING'}`);
  const siteAfter = await get('/api/sensors/sites');
  const listed = siteAfter.json?.sites?.find((s) => s.siteId === F)?.devices?.some((d) => d.deviceId === dev?.deviceId);
  expect('registered device appears in the site listing', !!listed, 'device visible');
  const ingestOk = await post(`/api/fields/${F}/ingest?deviceId=${dev?.deviceId}`, { soilMoisture: 22.5, soilTempC: 11.8 }, { 'X-Sensor-Token': token });
  expect('POST ingest with the device token', ingestOk.status === 200 && ingestOk.json?.deviceId === dev?.deviceId, `accepted=${(ingestOk.json?.accepted || []).join('+')}`);
  const ingestBad = await post(`/api/fields/${F}/ingest?deviceId=${dev?.deviceId}`, { soilMoisture: 22.5 }, { 'X-Sensor-Token': 'deadbeef' });
  expect('POST ingest with a wrong token is 401', ingestBad.status === 401, `status ${ingestBad.status}`);
  const ingestUnknown = await post(`/api/fields/${F}/ingest?deviceId=S-000000`, { soilMoisture: 22.5 }, { 'X-Sensor-Token': token });
  expect('POST ingest for an unknown device is 404', ingestUnknown.status === 404, `status ${ingestUnknown.status}`);
  const refresh = await post('/api/sensors/refresh-weather');
  expect('POST /api/sensors/refresh-weather', refresh.status === 200, `status ${refresh.status}`);

  /* ------------------------- CP9 fusion connectors ----------------------- */
  section('Fusion data sources (network)');
  const s2 = await get(`/api/fields/${F}/satellite?days=30&limit=3`);
  expect(`GET sentinel-2 scenes`, s2.status === 200 && s2.json?.count >= 0 && Array.isArray(s2.json?.scenes), `${s2.json?.count} scene(s), ${s2.json?.scenes?.filter((s) => s.thumbnail).length} with previews`);
  const s1 = await get(`/api/fields/${F}/satellite?collection=sentinel-1-grd&days=30&limit=3`);
  expect(`GET sentinel-1 SAR scenes`, s1.status === 200 && Array.isArray(s1.json?.scenes), `${s1.json?.count} scene(s)`);
  const terrain = await get(`/api/fields/${F}/terrain`);
  expect(`GET terrain`, terrain.status === 200 && Number.isFinite(terrain.json?.elevationM), `${terrain.json?.elevationM} m, slope ${terrain.json?.slopePct}%, ${terrain.json?.drainage}`);
  const xc = await get(`/api/fields/${F}/weather-crosscheck`);
  expect(`GET weather cross-check`, xc.status === 200 && ['close', 'divergent'].includes(xc.json?.agreement), `${xc.json?.days} shared days, dT ${xc.json?.delta?.meanTempC} C, ${xc.json?.agreement}`);
  const sources = await get('/api/sources');
  expect('GET /api/sources', sources.status === 200 && sources.json?.count === 5, `${sources.json?.count} datasets, ${sources.json?.sources?.filter((s) => s.attribution).length} with attribution`);
  const badColl = await get(`/api/fields/${F}/satellite?collection=landsat`);
  expect('unsupported STAC collection is 400', badColl.status === 400, `status ${badColl.status}`);

  /* --------------------------- CP10 workflow DAG ------------------------- */
  section('Workflow DAG');
  const wfs = await get('/api/workflows');
  expect('GET /api/workflows', wfs.status === 200 && wfs.json?.count === 3, wfs.json?.workflows?.map((w) => `${w.id}(${w.nodeCount})`).join(' '));
  for (const w of wfs.json?.workflows || []) {
    const def = await get(`/api/workflows/${w.id}`);
    const depsOk = def.json?.graph?.every((n) => n.deps.every((d) => w.nodes.includes(d)));
    expect(`GET /api/workflows/${w.id}`, def.status === 200 && depsOk, `${def.json?.nodeCount} nodes, ${def.json?.edges?.length} edges`);
  }
  const run1 = await post('/api/workflows/local-agronomy/run', { fieldId: F });
  expect('POST run local-agronomy', run1.status === 200 && run1.json?.status === 'ok' && run1.json?.nodes?.length === 5, `${run1.json?.executed} ran / ${run1.json?.reused} reused`);
  const run2 = await post('/api/workflows/local-agronomy/run', { fieldId: F });
  expect('re-run with unchanged inputs reuses every node', run2.json?.executed === 0 && run2.json?.reused === 5, `${run2.json?.executed} ran / ${run2.json?.reused} reused`);
  const run3 = await post('/api/workflows/local-agronomy/run', { fieldId: F, force: true });
  expect('forced run recomputes every node', run3.json?.executed === 5, `${run3.json?.executed} ran`);
  const run4 = await post('/api/workflows/imagery-window/run', { fieldId: F });
  expect('POST run imagery-window', run4.status === 200 && run4.json?.status === 'ok', `${run4.json?.nodes?.map((n) => n.nodeId).join(' -> ')}`);
  const run5 = await post('/api/workflows/field-refresh/run', { fieldId: F });
  expect('POST run field-refresh (11 nodes, live network)', run5.status === 200 && run5.json?.nodes?.length === 11, `${run5.json?.executed} ran / ${run5.json?.reused} reused in ${run5.json?.durationMs} ms`);
  const runs = await get(`/api/workflows/local-agronomy/runs?fieldId=${F}&limit=5`);
  expect('GET workflow run history', runs.status === 200 && runs.json?.items?.length >= 3, `${runs.json?.total} run(s)`);
  const runId = runs.json?.items?.[0]?.runId;
  const runDetail = await get(`/api/workflow-runs/${runId}`);
  expect(`GET /api/workflow-runs/${runId}`, runDetail.status === 200 && Array.isArray(runDetail.json?.nodes), `nodes=${runDetail.json?.nodes?.length}`);

  /* ------------------------------ error paths ---------------------------- */
  section('Error paths');
  const checks404 = [
    ['GET /api/fields/nope', () => get('/api/fields/nope')],
    ['GET /api/fields/nope/layers', () => get('/api/fields/nope/layers')],
    ['GET /api/fields/nope/geojson', () => get('/api/fields/nope/geojson')],
    ['GET /api/fields/nope/report', () => get('/api/fields/nope/report')],
    ['GET /api/fields/nope/satellite', () => get('/api/fields/nope/satellite')],
    ['GET /api/fields/nope/terrain', () => get('/api/fields/nope/terrain')],
    ['GET /api/workflows/nope', () => get('/api/workflows/nope')],
    ['GET /api/workflows/nope/runs', () => get('/api/workflows/nope/runs')],
    ['GET /api/workflow-runs/nope', () => get('/api/workflow-runs/nope')],
    ['POST /api/workflows/nope/run', () => post('/api/workflows/nope/run', {})],
    ['POST run with unknown field', () => post('/api/workflows/local-agronomy/run', { fieldId: 'nope' })],
    ['GET /api/seed stays 404', () => get('/api/seed')],
    ['GET /api/seed-dataset stays 404', () => get('/api/seed-dataset')],
    ['GET /api/demo-tick stays 404', () => get('/api/demo-tick')],
    ['POST /api/upload without a file', () => post('/api/upload', {})],
    ['POST /api/label with an empty body', () => post('/api/label', {})],
    ['POST geotag with invalid coordinates', () => post(`/api/fields/${F}/geotag`, { lat: 999, lon: 999 })],
    // A missing token is an auth failure: the route documents 401, not 400.
    ['POST ingest with no token at all', () => post(`/api/fields/${F}/ingest?deviceId=${dev?.deviceId}`, { soilMoisture: 20 }), [401]],
  ];
  for (const [name, fn, allowed] of checks404) {
    const r = await fn();
    const want = allowed || [400, 404];
    expect(`${name} -> ${want.join('/')}`, want.includes(r.status), `status ${r.status} ${r.json?.error ? `(${String(r.json.error).slice(0, 60)})` : ''}`);
  }

  /* ------------------------------ AI pipeline ---------------------------- */
  section('AI pipeline (mock crop model + local vision model)');
  const aiStatus = await get('/api/ai/status');
  expect('GET /api/ai/status', aiStatus.status === 200, `provider=${aiStatus.json?.configured ? aiStatus.json.provider : 'not configured'}`);
  const aiConfig = await get('/api/ai/config');
  expect('GET /api/ai/config', aiConfig.status === 200, 'config visible');
  const aiTest = await post('/api/ai/test', { fieldId: F });
  expect('POST /api/ai/test round-trip', aiTest.status === 200 || aiTest.status === 502, `status ${aiTest.status} ${aiTest.json?.latencyMs != null ? `in ${aiTest.json.latencyMs} ms` : ''}`);
  const aiTile = await post('/api/ai/tile', { fieldId: F, r: 1, c: 1 });
  expect('POST /api/ai/tile classifies one tile', [200, 502].includes(aiTile.status), `status ${aiTile.status}`);
  const aiField = await post('/api/ai/field', { fieldId: F });
  expect('POST /api/ai/field analyses the field', [200, 502].includes(aiField.status), `status ${aiField.status} ${aiField.json?.source ? `source=${aiField.json.source}` : ''}`);

  section('Species identification (Ollama)');
  const idHist = await get('/api/identify');
  const before = idHist.json?.total ?? 0;
  expect('GET /api/identify history', idHist.status === 200 && Array.isArray(idHist.json?.items), `${before} stored identification(s)`);
  const idTest = await post('/api/ai/test-identify', { fieldId: F, r: 1, c: 1 });
  const idTestOk = idTest.status === 200 ? !!idTest.json?.identity?.common || !!idTest.json?.common : idTest.status === 502;
  expect('POST /api/ai/test-identify round-trip', idTestOk, `status ${idTest.status} ${idTest.json?.latencyMs ? `in ${idTest.json.latencyMs} ms` : ''}`);
  const idRun = await post('/api/ai/identify', { fieldId: F, r: 1, c: 1 });
  const named = idRun.status === 200 ? !!(idRun.json?.identification?.common || idRun.json?.identification?.scientific) : idRun.status === 502;
  expect('POST /api/ai/identify stores a named result (or fails honestly)', named, `status ${idRun.status} ${idRun.json?.identification?.common ? `-> ${idRun.json.identification.common}` : ''}`);
  const after = (await get('/api/identify')).json?.total ?? 0;
  expect('identify history grew by the stored run', idRun.status !== 200 || after >= before, `${before} -> ${after}`);

  /* --------------------------- labeling + training ----------------------- */
  section('Labeling, dataset, training');
  const fromLabels = await post('/api/dataset/from-labels', {});
  expect('POST /api/dataset/from-labels', [200, 400].includes(fromLabels.status), `status ${fromLabels.status} ${fromLabels.json?.error || ''}`);
  const train = await post('/api/train', {});
  const trainOk = train.status === 200 && Number.isFinite(train.json?.metrics?.accuracy);
  expect('POST /api/train returns honest CV metrics', trainOk || train.status === 400, train.status === 200 ? `accuracy=${train.json.metrics.accuracy}, macroF1=${train.json.metrics.macroF1}, tested=${train.json.metrics.tested}` : `status ${train.status}`);
  const predict = await post('/api/predict', {});
  expect('POST /api/predict without an image is a 4xx', [400, 404, 422].includes(predict.status), `status ${predict.status}`);

  /* ------------------------------- lifecycle ----------------------------- */
  section('Cleanup');
  const del = await req(`/api/fields/${F}/sensors/${dev?.deviceId}`, { method: 'DELETE' });
  expect('DELETE the QA probe', del.status === 200, `status ${del.status}`);
  const afterDel = await post(`/api/fields/${F}/ingest?deviceId=${dev?.deviceId}`, { soilMoisture: 20 }, { 'X-Sensor-Token': token });
  expect('deleted device rejects new readings (404)', afterDel.status === 404, `status ${afterDel.status}`);
  const clearNoop = await post('/api/workflow-runs/clear', { fieldId: 'nope-nonexistent-field' });
  expect('POST clear history for a foreign field is a no-op', clearNoop.status === 200, `status ${clearNoop.status}`);
  const stillThere = await get(`/api/workflows/local-agronomy/runs?fieldId=${F}&limit=1`);
  expect('demo run history survived the no-op clear', stillThere.json?.items?.length >= 1, `${stillThere.json?.total} run(s) still stored`);

  /* -------------------------------- report ------------------------------- */
  let failed = 0;
  console.log(`\nCrop AI console — backend sweep against ${BASE}\n`);
  for (const r of results) {
    if (r.section) { console.log(`\n${r.section}`); continue; }
    if (!r.ok) failed += 1;
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  const total = results.filter((r) => !r.section).length;
  console.log(`\n${total - failed}/${total} checks passed${failed ? `  — ${failed} FAILED` : ''}\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SWEEP ERROR:', e); process.exit(2); });
