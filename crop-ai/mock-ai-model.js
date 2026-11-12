#!/usr/bin/env node
/**
 * ============================================================================
 *  MOCK CROP-VISION MODEL - reference implementation of the external AI
 *  contract that Vibes Lite / Crop AI speaks.
 *
 *  Why this exists
 *  ---------------
 *  The console treats the crop model as a REMOTE HTTP service. Before your real
 *  model is deployed you need something to point at, and you need to see exactly
 *  what the console sends and expects back. This file is that reference: it
 *  performs genuine image analysis on the decoded pixels (excess-green / hue /
 *  texture statistics) and returns the contract JSON. It is NOT the product -
 *  it is a test harness and a copy-paste starting point for your real service.
 *
 *  Run:   node crop-ai/mock-ai-model.js            # listens on :5199
 *  Point: AI_PROVIDER=generic AI_API_URL=http://localhost:5199/predict
 *
 *  Endpoints
 *    POST /predict               generic contract  {model, task, classes, image, grid}
 *    POST /v1/chat/completions   OpenAI-compatible vision shape (returns the same JSON
 *                                inside choices[0].message.content)
 *    GET  /health                readiness + call counter
 *
 *  Auth: set MOCK_AI_TOKEN=<secret> to require `Authorization: Bearer <secret>`.
 * ============================================================================
 */

'use strict';

const http = require('http');
const pngjs = require('pngjs').PNG;
const jpegjs = require('jpeg-js');

const PORT = Number(process.env.MOCK_AI_PORT || 5199);
const TOKEN = process.env.MOCK_AI_TOKEN || '';
const CLASSES = ['healthy', 'stressed', 'soil', 'weed'];

let calls = 0;

/* --------------------------------- decoding -------------------------------- */
function decodeImage(dataUrl) {
  const m = /^data:image\/([a-z+]+);base64,(.*)$/i.exec(dataUrl || '');
  if (!m) throw new Error('expected an image data URL');
  const buf = Buffer.from(m[2], 'base64');
  if (m[1].toLowerCase() === 'png') {
    const p = pngjs.sync.read(buf);
    return { width: p.width, height: p.height, rgba: p.data };
  }
  const d = jpegjs.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, rgba: d.data };
}

/* --------------------------------- colour ---------------------------------- */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Statistics for one rectangular region of the image.
 * Every number below is derived from real pixels.
 */
function analyseRegion(rgba, W, x0, y0, rw, rh) {
  let n = 0;
  let vegPixels = 0;
  let exGreenSum = 0;      // 2G-R-B : the NDVI proxy
  let hueX = 0, hueY = 0;  // circular mean of vegetation hue
  let lumSum = 0;
  let lumsq = 0;
  let brownSum = 0;
  let yellowSum = 0;

  const stride = Math.max(1, Math.floor(Math.min(rw, rh) / 24));
  for (let y = y0; y < y0 + rh; y += stride) {
    for (let x = x0; x < x0 + rw; x += stride) {
      const o = (y * W + x) * 4;
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      n++;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      lumSum += lum;
      lumsq += lum * lum;
      const exG = 2 * g - r - b;
      if (exG > 12) {
        vegPixels++;
        exGreenSum += exG;
        // circular mean of hue, weighted by greenness. NOTE the (g - b) term:
        // with (b - g) every hue is mirrored and all crops read as weed.
        let h = (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI;
        if (h < 0) h += 360;
        const rad = (h * Math.PI) / 180;
        hueX += Math.cos(rad) * (exG / 255);
        hueY += Math.sin(rad) * (exG / 255);
      } else if (exG <= 0 && r > b && r > 45 && r < 215) {
        brownSum++;
      } else if (r > g - 20 && b < g - 45 && lum > 70) {
        yellowSum++;
      }
    }
  }
  if (!n) return null;

  const meanLum = lumSum / n;
  const variance = Math.max(0, lumsq / n - meanLum * meanLum);
  const vegFrac = vegPixels / n;
  const brownFrac = brownSum / n;
  const yellowFrac = yellowSum / n;
  const exGreen = vegPixels ? exGreenSum / vegPixels : 0;
  let hue = (Math.atan2(hueY, hueX) * 180) / Math.PI;
  if (hue < 0) hue += 360;

  // NDVI proxy from the excess-green index. Real vegetation lands around
  // exGreen 40-160, so scale over that band to avoid saturating at 1.
  const ndvi = clamp(exGreen / 160, 0, 1);

  // Four-way decision on vegetation fraction, hue and chlorosis.
  let scores = { healthy: 0, stressed: 0, soil: 0, weed: 0 };
  if (vegFrac < 0.06) {
    // essentially bare ground
    scores.soil = brownFrac + vegFrac * 2;
    scores.stressed = yellowFrac * 0.8;
  } else {
    // crops sit in the 95-165 deg hue band; anything else is competing vegetation
    const cropHue = hue >= 85 && hue <= 168;
    const vigour = clamp((exGreen - 12) / 90, 0, 1);
    if (cropHue) {
      scores.healthy = vegFrac * (0.55 + 0.45 * vigour);
      scores.stressed = vegFrac * yellowFrac * 2.6 + vegFrac * (1 - vigour) * 0.75;
      scores.weed = vegFrac * 0.1;
    } else {
      scores.weed = vegFrac * (0.5 + 0.5 * clamp((170 - hue + 85 - hue) / 90, 0, 1));
      scores.healthy = vegFrac * 0.18;
      scores.stressed = vegFrac * yellowFrac;
    }
    scores.soil = brownFrac + (1 - vegFrac) * 0.55;
  }
  scores.soil += 0.001; // never tie-break soil to zero
  const total = scores.healthy + scores.stressed + scores.soil + scores.weed || 1;
  const shares = {};
  for (const k of CLASSES) shares[k] = scores[k] / total;

  const ranked = CLASSES.slice().sort((a, b) => shares[b] - shares[a]);
  return {
    shares,
    class: ranked[0],
    // margin between the winner and the runner-up -> honest confidence
    confidence: clamp(0.45 + (shares[ranked[0]] - shares[ranked[1]]) * 2.2, 0.35, 0.99),
    vegFrac,
    exGreen,
    hue,
    ndvi,
    meanLum,
    variance,
  };
}

/** Whole-image analysis, optionally split into a rows x cols tile grid. */
function classify(img, grid) {
  const { width: W, height: H, rgba } = img;
  let cells = null;
  let summary = null;

  if (grid && grid.rows > 0 && grid.cols > 0) {
    cells = [];
    const cw = Math.floor(W / grid.cols);
    const ch = Math.floor(H / grid.rows);
    for (let r = 0; r < grid.rows; r++) {
      const row = [];
      for (let c = 0; c < grid.cols; c++) {
        const stat = analyseRegion(rgba, W, c * cw, r * ch, cw, ch);
        row.push(stat ? stat.class : 'soil');
      }
      cells.push(row);
    }
  }
  summary = analyseRegion(rgba, W, 0, 0, W, H);
  if (!summary) throw new Error('image too small to analyse');

  // Field-level shares: prefer the grid, it is per-tile ground truth.
  const shares = { healthy: 0, stressed: 0, soil: 0, weed: 0 };
  if (cells) {
    const flat = cells.flat();
    for (const c of flat) shares[c] = (shares[c] || 0) + 1;
    for (const k of CLASSES) shares[k] /= flat.length || 1;
  } else {
    Object.assign(shares, summary.shares);
  }

  const ranked = CLASSES.slice().sort((a, b) => shares[b] - shares[a]);
  const dominant = ranked[0];
  // Confidence is the margin over the runner-up: how decisively the field (or
  // grid) is one class rather than a blend.
  const margin = Math.max(0, (shares[dominant] || 0) - (shares[ranked[1]] || 0));
  const confidence = clamp(0.45 + margin * 1.8, 0.35, 0.99);

  // Plant health: share of healthy biomass, discounted for chlorosis and weeds.
  const health = clamp(
    100 * (shares.healthy + shares.stressed * 0.45 - shares.weed * 0.5) * (0.72 + 0.28 * summary.ndvi),
    1, 100
  );
  // Weed pressure: share plus the vigour of that competing vegetation.
  const weed = clamp(shares.weed * 100 * (0.8 + 0.4 * summary.exGreen / 120), 0, 100);
  // Soil: penalise bare exposure, reward even low-variance tilth; darker soil
  // reads as higher organic matter. Explicitly a vision-only estimate.
  const tilth = clamp(summary.variance / 900, 0, 1);
  const organic = clamp((150 - summary.meanLum) / 110, 0, 1);
  const soil = clamp(100 * (0.45 * organic + 0.3 * tilth + 0.25 * (1 - (shares.soil + shares.weed))), 1, 100);

  const answer = {
    class: dominant,
    confidence: +confidence.toFixed(3),
    classes: Object.fromEntries(CLASSES.map((k) => [k, +shares[k].toFixed(4)])),
    health: +health.toFixed(1),
    weed: +weed.toFixed(1),
    soil: +soil.toFixed(1),
    ndvi: +summary.ndvi.toFixed(3),
    model: 'mock-crop-vision/1.0',
    computed_from: { width: W, height: H, cells: cells ? cells.length * cells[0].length : 0 },
  };
  if (cells) answer.grid = cells;
  return answer;
}

/* --------------------------------- server ---------------------------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024 * 1024) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function pullImage(body) {
  // generic provider
  if (body.image) return body.image;
  // OpenAI-compatible provider: image_url parts on the last user message
  const msg = [...(body.messages || [])].reverse().find((m) => Array.isArray(m.content));
  if (!msg) return null;
  const part = msg.content.find((p) => p.type === 'image_url');
  return part?.image_url?.url || null;
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/health') {
    return json(200, { ok: true, model: 'mock-crop-vision/1.0', calls, auth: !!TOKEN });
  }
  if (req.method !== 'POST' || (req.url !== '/predict' && req.url !== '/v1/chat/completions')) {
    return json(404, { error: 'POST /predict or POST /v1/chat/completions' });
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return json(401, { error: { message: 'Missing or invalid bearer token' } });
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { return json(400, { error: { message: e.message } }); }

  const dataUrl = pullImage(body);
  if (!dataUrl) return json(400, { error: { message: 'No image supplied (expected "image" data URL)' } });

  let answer;
  try { answer = classify(decodeImage(dataUrl), body.grid); }
  catch (e) { return json(400, { error: { message: `image analysis failed: ${e.message}` } }); }

  calls++;
  const isOpenAi = req.url === '/v1/chat/completions';
  console.log(
    `[mock-ai] #${calls} ${isOpenAi ? 'openai' : 'generic'} model=${body.model || '-'} grid=${body.grid ? `${body.grid.rows}x${body.grid.cols}` : 'none'} ` +
    `-> ${answer.class} ${(answer.confidence * 100).toFixed(0)}% health=${answer.health} weed=${answer.weed} soil=${answer.soil}`
  );
  json(200, isOpenAi ? { choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }] } : answer);
});

server.listen(PORT, () => {
  console.log(`Mock crop-vision model listening on http://localhost:${PORT}`);
  console.log(`  POST /predict              generic contract`);
  console.log(`  POST /v1/chat/completions  OpenAI-compatible vision`);
  console.log(`  auth: ${TOKEN ? 'bearer token required' : 'none'}\n`);
});