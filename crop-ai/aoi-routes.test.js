'use strict';
// Same isolation as server.test.js: VERCEL=1 stops server.js calling listen(),
// and a private TMPDIR keeps its seeded state away from other test files.
process.env.VERCEL = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crop-ai-aoi-'));
process.env.TMPDIR = TEST_TMP;

const app = require('./server');

let server;
let base;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/* ------------------------- analyse: refusals only -------------------------- */

test('analyse refuses fewer than three corners before touching the network', async () => {
  const r = await post('/api/aoi/analyze', { points: [[52.6, 5.6], [52.6, 5.61]] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least 3/);
});

test('analyse refuses the (0,0) no-fix sentinel', async () => {
  const r = await post('/api/aoi/analyze', { points: [[0, 0], [1, 1], [2, 0]] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no-fix/);
});

test('analyse refuses an area above 500 ha', async () => {
  const r = await post('/api/aoi/analyze', { points: [[52.6, 5.6], [52.6, 5.7], [52.67, 5.7], [52.67, 5.6]] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /500 ha/);
});

test('analyse refuses a body with no points at all', async () => {
  const r = await post('/api/aoi/analyze', {});
  assert.equal(r.status, 400);
});

/* ------------------------- stored areas and images ------------------------- */

test('an unknown or malformed area id is a clean 404, never a path read', async () => {
  assert.equal((await get('/api/aoi/aoi-000000000000')).status, 404);
  assert.equal((await get('/api/aoi/..%2F..%2Fetc%2Fpasswd')).status, 404);
  assert.equal((await get('/api/aoi/not-an-id')).status, 404);
});

test('an image request for an unknown area or kind is a 404', async () => {
  assert.equal((await get('/api/aoi/aoi-000000000000/image/ndvi')).status, 404);
  assert.equal((await get('/api/aoi/aoi-000000000000/image/bogus')).status, 404);
});

/* ------------------------------ chat fallback ------------------------------ */

test('chat with no message is refused', async () => {
  const r = await post('/api/chat', { message: '   ' });
  assert.equal(r.status, 400);
});

test('chat without an analysed area answers by rule and asks for one to be drawn', async () => {
  const r = await post('/api/chat', { message: 'What about zinc?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'rules');
  assert.match(r.body.reply, /Draw an area/);
});

test('chat with an unknown area id falls back the same way, not an error', async () => {
  const r = await post('/api/chat', { message: 'What fertilizer?', aoiId: 'aoi-000000000000' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'rules');
});
