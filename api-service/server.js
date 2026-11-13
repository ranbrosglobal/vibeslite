'use strict';
// ============================================================================
//  Vibes Lite API — Express service on Vercel
//
//  The analysis itself runs in the Python backend (rasterio, geopandas,
//  OpenCV, matplotlib), which is far larger than a Vercel Function can hold.
//  This service therefore answers the read-only endpoints from the analysis
//  the backend already produced, shipped in ./snapshot:
//
//    GET /api/health           service + capability description
//    GET /api/project          project identity
//    GET /api/config           analysis configuration
//    GET /api/dashboard        totals for the demo field
//    GET /api/results          stored analyses (optional ?kind=&limit=)
//    GET /api/results/:id      one analysis with assets, stats and payload
//    GET /api/datasets         bundled datasets
//    GET /api/aoi              bundled areas of interest
//    GET /api/security         security posture
//    GET /api/agronomy/models  agronomy model catalogue
//    GET /api/geo/status       map provider status
//
//  Writes (uploads, analysis runs, geocoding) need the Python backend and
//  answer 501 with a message saying so.
//
//  The maps are static files under frontend/public/outputs, copied there at
//  build time, so /outputs/... is served by the web service.
// ============================================================================

const express = require('express');

const health = require('./snapshot/health.json');
const project = require('./snapshot/project.json');
const config = require('./snapshot/config.json');
const dashboard = require('./snapshot/dashboard.json');
const datasets = require('./snapshot/datasets.json');
const aoi = require('./snapshot/aoi.json');
const security = require('./snapshot/security.json');
const agronomyModels = require('./snapshot/agronomy-models.json');
const geoStatus = require('./snapshot/geo-status.json');
const results = require('./snapshot/results.json');
const resultDetails = require('./snapshot/result-details.json');

const LIVE_ONLY =
  'This deployment serves a precomputed demo analysis. Uploads, live raster processing and agronomy runs need the Python backend, which does not fit on Vercel — run `npm run dev` locally for those.';

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('cache-control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400');
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ...health, runtime: 'vercel-express', mode: 'demo-snapshot', storage: 'bundled' });
});

// `/api` on its own is a liveness probe.
app.get('/api', (req, res) => res.json({ status: 'ok', mode: 'demo-snapshot' }));

app.get('/api/project', (req, res) => res.json(project));
app.get('/api/config', (req, res) => res.json(config));
app.get('/api/dashboard', (req, res) => res.json(dashboard));
app.get('/api/datasets', (req, res) => res.json(datasets));
app.get('/api/aoi', (req, res) => res.json(aoi));
app.get('/api/security', (req, res) => res.json(security));
app.get('/api/agronomy/models', (req, res) => res.json(agronomyModels));
app.get('/api/geo/status', (req, res) => res.json(geoStatus));

app.get('/api/results', (req, res) => {
  const kind = typeof req.query.kind === 'string' ? req.query.kind : '';
  const limit = Number(req.query.limit) || 50;
  const rows = (results.results || []).filter((row) => !kind || row.kind === kind);
  res.json({ ...results, count: rows.length, results: rows.slice(0, limit) });
});

app.get('/api/results/:id', (req, res) => {
  const detail = resultDetails[req.params.id];
  if (!detail) return res.status(404).json({ detail: `No result named ${req.params.id}` });
  return res.json(detail);
});

app.get('/api/datasets/:name', (req, res) => {
  res.status(404).json({ detail: `Dataset ${req.params.name} is not part of the demo snapshot.` });
});

app.get('/api/geo/*', (req, res) => {
  res.status(503).json({
    detail: 'Live geocoding and Overpass lookups are not part of this deployment.',
    live: false,
  });
});

app.use((req, res) => {
  res.status(501).json({ detail: LIVE_ONLY, live: false, demo: true });
});

module.exports = app;

// Local smoke test only; Vercel's express framework imports the app.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 8010;
  app.listen(port, '127.0.0.1', () => {
    console.log(`Vibes Lite API (demo snapshot) on http://127.0.0.1:${port}`);
  });
}
