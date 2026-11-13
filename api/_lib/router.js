'use strict';
// ============================================================================
//  Vibes Lite API — Vercel Functions build
//
//  The full Python backend (rasterio, geopandas, OpenCV, matplotlib) is far
//  larger than a Vercel Function can hold, so this deployment ships the
//  analysis the backend already produced as a bundled snapshot: one survey
//  result, its maps and its metrics. Read-only endpoints answer from that
//  snapshot; anything that would need live raster processing says so instead
//  of failing silently.
//
//  Regenerate the snapshot with `npm run snapshot` (see scripts/snapshot-api.sh)
//  or by pointing VIBES_OUTPUTS_DIR at demo/outputs and curling the endpoints.
// ============================================================================

const health = require('./data/health.json');
const project = require('./data/project.json');
const config = require('./data/config.json');
const dashboard = require('./data/dashboard.json');
const datasets = require('./data/datasets.json');
const aoi = require('./data/aoi.json');
const security = require('./data/security.json');
const agronomyModels = require('./data/agronomy-models.json');
const geoStatus = require('./data/geo-status.json');
const resultsIndex = require('./data/results.json');
const resultDetails = require('./data/result-details.json');

const LIVE_ONLY =
  'This deployment serves a precomputed demo analysis. Live raster processing, uploads and agronomy runs need the Python backend, which does not fit in a Vercel Function — run `npm run dev` locally for those.';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve(null);
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function filterResults(url) {
  const kind = url.searchParams.get('kind');
  const limit = Number(url.searchParams.get('limit')) || 50;
  const rows = (resultsIndex.results || []).filter((row) => !kind || row.kind === kind);
  return { ...resultsIndex, count: rows.length, results: rows.slice(0, limit) };
}

const snapshot = {
  health: {
    ...health,
    runtime: 'vercel-functions',
    mode: 'demo-snapshot',
    storage: 'bundled',
  },
  '/project': project,
  '/config': config,
  '/dashboard': dashboard,
  '/datasets': datasets,
  '/aoi': aoi,
  '/security': security,
  '/agronomy/models': agronomyModels,
  '/geo/status': geoStatus,
};

module.exports = async function handler(req, res) {
  const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
  // Rewrites and catch-all functions can leave the prefix in place or strip it.
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('allow', 'GET, POST, OPTIONS');
    res.end();
    return;
  }

  if (method === 'GET' || method === 'HEAD') {
    if (path === '/health' || path === '/') return send(res, 200, snapshot.health);
    if (snapshot[path]) return send(res, 200, snapshot[path]);

    if (path === '/results') return send(res, 200, filterResults(url));

    const resultMatch = path.match(/^\/results\/([^/]+)$/);
    if (resultMatch) {
      const id = decodeURIComponent(resultMatch[1]);
      const detail = resultDetails[id];
      if (!detail) return send(res, 404, { detail: `No result named ${id}` });
      return send(res, 200, detail);
    }

    if (path.startsWith('/geo/')) {
      return send(res, 503, {
        detail: 'Live geocoding needs outbound OSM calls from the Python backend, which is not part of this deployment.',
        live: false,
      });
    }

    if (path.startsWith('/datasets/') || path.startsWith('/aoi/')) {
      return send(res, 404, { detail: 'Not in the demo snapshot.' });
    }
  }

  if (method === 'POST') {
    await readBody(req);
    return send(res, 501, { detail: LIVE_ONLY, live: false, demo: true });
  }

  return send(res, 501, { detail: LIVE_ONLY, live: false, demo: true });
};

module.exports._send = send;
module.exports._snapshot = snapshot;
