'use strict';
/* ============================================================================
 * Local simulation of a Vercel cold start for the Crop AI console.
 *
 * What it proves (without a Vercel account):
 *   1. VERCEL=1 + require('api/index.js') exports the Express app.
 *   2. The module does NOT call listen()/createServer() on load.
 *   3. State seeds into the writable /tmp dir (read-only FS on Vercel) with
 *      the .seeded marker written.
 *   4. The exported app actually serves: API JSON, static console files,
 *      map/upload static dirs, and demo routes stay 404.
 *
 * Run:  node tools/vercel_harness.js   (from the repo root)
 * Exits non-zero on the first failed assertion.
 * ========================================================================== */
process.env.VERCEL = '1';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP_DATA = path.join(os.tmpdir(), 'crop-ai-data');
const PORT = +(process.env.HARNESS_PORT || 5178);

// Start from a clean cold start: no seeded marker, no tmp state.
fs.rmSync(TMP_DATA, { recursive: true, force: true });

// Detect any accidental listen()/createServer() during module load.
const realCreateServer = http.createServer;
const realListen = http.Server.prototype.listen;
let createServerCalls = 0;
let listenCalls = 0;
http.createServer = function (...args) {
  createServerCalls += 1;
  return realCreateServer.apply(this, args);
};
http.Server.prototype.listen = function (...args) {
  listenCalls += 1;
  return realListen.apply(this, args);
};

const app = require(path.join(ROOT, 'api', 'index.js'));

http.createServer = realCreateServer;
http.Server.prototype.listen = realListen;

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', `${name} -- ${e.message}`]); }
};

check('export is an Express app (function with .use/.handle)', () => {
  assert.strictEqual(typeof app, 'function');
  assert.strictEqual(typeof app.use, 'function');
  assert.strictEqual(typeof app.handle, 'function');
});

check('module load created no HTTP server (no auto-listen)', () => {
  assert.strictEqual(createServerCalls, 0, `createServer called ${createServerCalls}x`);
});

check('module load never called listen()', () => {
  assert.strictEqual(listenCalls, 0, `listen called ${listenCalls}x`);
});

check('/tmp state seeded with .seeded marker', () => {
  assert.ok(fs.existsSync(TMP_DATA), 'tmp data dir missing');
  assert.ok(fs.existsSync(path.join(TMP_DATA, '.seeded')), 'marker missing');
  assert.ok(fs.existsSync(path.join(TMP_DATA, 'fields.json')), 'fields.json not copied');
  assert.ok(fs.existsSync(path.join(TMP_DATA, 'ai-config.json')), 'ai-config.json not copied');
});

check('uploads/samples dirs created under /tmp', () => {
  assert.ok(fs.statSync(path.join(TMP_DATA, 'uploads')).isDirectory());
  assert.ok(fs.statSync(path.join(TMP_DATA, 'samples')).isDirectory());
});

/* ---- serve the exported app exactly like the Vercel runtime would ---- */
const server = realCreateServer(app);

const get = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
  });
  req.on('error', reject);
  req.end();
});

const expect = (name, got, wantStatus, opts = {}) => {
  const ok = got.status === wantStatus && (!opts.includes || got.body.includes(opts.includes));
  results.push([ok ? 'PASS' : 'FAIL',
    `${name} -- status ${got.status} (want ${wantStatus})${opts.includes ? `, body ${ok ? 'contains' : 'missing'} ${JSON.stringify(opts.includes)}` : ''}`]);
};

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const sweeps = [
    ['/api/health', 200, { includes: '"ok"' }],
    ['/api/fields', 200, null],
    ['/api/identify', 200, null],
    ['/api/ai/status', 200, null],
    ['/', 200, { includes: 'Crop AI' }],
    ['/app.js', 200, null],
    ['/styles.css', 200, null],
    ['/api/seed', 404, null],
    ['/api/seed-dataset', 404, null],
    ['/api/demo-tick', 404, null],
  ];
  for (const [p, want, opts] of sweeps) {
    try { expect(`GET ${p}`, await get(p), want, opts || {}); }
    catch (e) { results.push(['FAIL', `GET ${p} -- ${e.message}`]); }
  }

  server.close();

  let failed = 0;
  for (const [status, name] of results) {
    console.log(`${status}  ${name}`);
    if (status === 'FAIL') failed += 1;
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR:', e);
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
  process.exit(1);
});
