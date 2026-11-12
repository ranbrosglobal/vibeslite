'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sat = require('./aoi-satellite');
const wheat = require('./agronomy-wheat');

/* ----------------------------- AOI geometry ------------------------------- */

test('a polygon needs at least three distinct points', () => {
  assert.equal(sat.validatePolygon([[52.6, 5.6], [52.6, 5.61]]).ok, false);
});

test('coordinates outside the valid range are refused', () => {
  const r = sat.validatePolygon([[95, 5.6], [52.6, 5.61], [52.61, 5.62]]);
  assert.equal(r.ok, false);
  assert.match(r.error, /latitude/);
});

test('(0,0) is refused as a no-fix sentinel', () => {
  assert.equal(sat.validatePolygon([[0, 0], [1, 1], [2, 0]]).ok, false);
});

test('an area below 400 m² and above 500 ha is refused', () => {
  // ~3 m square: far too small for 10 m satellite pixels.
  const tiny = sat.validatePolygon([[52.6, 5.6], [52.60003, 5.6], [52.60003, 5.60004], [52.6, 5.60004]]);
  assert.equal(tiny.ok, false);
  assert.match(tiny.error, /too small/);
  // ~1.1 km square: 120 ha, fine. ~8 km square: 6400 ha, refused.
  const big = sat.validatePolygon([[52.6, 5.6], [52.6, 5.7], [52.67, 5.7], [52.67, 5.6]]);
  assert.equal(big.ok, false);
  assert.match(big.error, /500 ha/);
});

test('a closed ring is accepted and its duplicate closing vertex dropped', () => {
  const r = sat.validatePolygon([[52.6, 5.6], [52.6, 5.6015], [52.6015, 5.6015], [52.6015, 5.6], [52.6, 5.6]]);
  assert.equal(r.ok, true);
  assert.equal(r.ring.length, 4);
});

test('polygon area of a 100 m × 100 m square is about 10,000 m²', () => {
  // 100 m north-south = 100/110574 deg; 100 m east-west at lat 52.6 = 100/(111320*cos(52.6)).
  const dLat = 100 / 110574, dLon = 100 / (111320 * Math.cos((52.6 * Math.PI) / 180));
  const ring = [[52.6, 5.6], [52.6, 5.6 + dLon], [52.6 + dLat, 5.6 + dLon], [52.6 + dLat, 5.6]];
  const area = sat.polygonAreaM2(ring);
  assert.ok(Math.abs(area - 10000) < 50, `area was ${area}`);
});

test('point-in-polygon separates inside from outside', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(sat.pointInRing(5, 5, sq), true);
  assert.equal(sat.pointInRing(15, 5, sq), false);
  assert.equal(sat.pointInRing(-1, -1, sq), false);
});

test('the UTM zone for the Netherlands (5.6°E, 52.6°N) is EPSG:32631', () => {
  assert.equal(sat.utmEpsg(52.6, 5.6), 32631);
  assert.equal(sat.utmEpsg(-33.9, 18.4), 32734); // Cape Town, southern hemisphere
});

/* ------------------------- Pixel classes and indices ---------------------- */

test('NDVI and NDWI follow their definitions', () => {
  assert.ok(Math.abs(sat.ndvi(0.5, 0.1) - (0.4 / 0.6)) < 1e-9);
  assert.equal(sat.ndvi(0, 0), 0, 'a zero-sum pixel is 0, not NaN');
  assert.ok(sat.ndwi(0.3, 0.1) > 0.3);
});

test('pixels are classified by NDVI, with high NDWI as water', () => {
  const base = { blue: 0.03, green: 0.05, red: 0.04, nir: 0.4, swir: 0.15 };
  assert.equal(sat.classifyPixel(base), 'healthy');
  assert.equal(sat.classifyPixel({ ...base, nir: 0.12, red: 0.1 }), 'bare');
  assert.equal(sat.classifyPixel({ ...base, nir: 0.1, red: 0.07, green: 0.2 }), 'water');
});

test('summarizeClasses reports shares, NDVI range and area', () => {
  const s = sat.summarizeClasses([
    { cls: 'healthy', ndvi: 0.6, bsi: -0.2 },
    { cls: 'healthy', ndvi: 0.5, bsi: -0.2 },
    { cls: 'bare', ndvi: 0.1, bsi: 0.1 },
    { cls: 'stressed', ndvi: 0.25, bsi: -0.1 },
  ]);
  assert.equal(s.validPixels, 4);
  assert.equal(s.sharePct.healthy, 50);
  assert.equal(s.sharePct.bare, 25);
  assert.equal(s.ndvi.min, 0.1);
  assert.equal(s.ndvi.max, 0.6);
  assert.equal(s.areaHa, 0.04); // 4 pixels × 100 m² = 400 m²
});

test('the NDVI colour ramp runs brown at bare ground to deep green at dense canopy', () => {
  assert.deepEqual(sat.ndviColour(-1), [166, 97, 26]);
  const dense = sat.ndviColour(0.9);
  assert.ok(dense[1] > dense[0] && dense[1] > dense[2], 'dense canopy is green');
});

test('renderRgba leaves pixels outside the polygon transparent', () => {
  const grid = {
    inside: new Uint8Array([1, 0]),
    red: new Float32Array([0.1, 0.1]), green: new Float32Array([0.1, 0.1]),
    blue: new Float32Array([0.1, 0.1]), ndvi: new Float32Array([0.5, 0.5]),
  };
  const { trueColour, ndviMap } = sat.renderRgba(grid, 2, 1);
  assert.equal(trueColour[3], 255);
  assert.equal(trueColour[7], 0);
  assert.equal(ndviMap[7], 0);
});

/* ----------------------------- Wheat advisory ----------------------------- */

const healthyIx = { healthyPct: 90, stressedPct: 5, barePct: 3, waterPct: 0, ndviMean: 0.7, ndviMin: 0.2, bsiMean: -0.2 };

test('low zinc from a lab test is a high-severity finding with a product and rate', () => {
  const a = wheat.adviseWheat({ indices: healthyIx, soil: { zincDtpaPpm: 0.4 } });
  const f = a.findings.find((x) => x.id === 'zinc-deficient');
  assert.ok(f, 'zinc finding present');
  assert.equal(f.severity, 'high');
  assert.equal(f.source, 'lab');
  assert.match(f.action, /zinc sulphate/i);
});

test('zinc is reported as unknown when no lab test is supplied, never guessed', () => {
  const a = wheat.adviseWheat({ indices: healthyIx, soil: null });
  assert.ok(a.unknowns.some((u) => /Zinc|zinc/.test(u)));
  assert.equal(a.findings.some((f) => /zinc/.test(f.id)), false);
});

test('low canopy vigour produces a nitrogen top-dressing finding', () => {
  const a = wheat.adviseWheat({ indices: { ...healthyIx, ndviMean: 0.3 } });
  const n = a.findings.find((f) => f.id === 'nitrogen-topdress');
  assert.ok(n);
  assert.equal(n.severity, 'high');
  assert.match(n.action, /kg N\/ha/);
});

test('a healthy canopy produces no nitrogen finding', () => {
  const a = wheat.adviseWheat({ indices: healthyIx });
  assert.equal(a.findings.some((f) => f.id === 'nitrogen-topdress'), false);
});

test('frost and wind are flagged from weather, and only when weather is supplied', () => {
  const cold = wheat.adviseWheat({ indices: healthyIx, weather: { tempMinC: 0, windKmh: 25, rainNext7dMm: 30 } });
  const ids = cold.findings.map((f) => f.id);
  assert.ok(ids.includes('frost-risk'));
  assert.ok(ids.includes('spray-wind'));
  assert.ok(ids.includes('rain-expected'));
  const none = wheat.adviseWheat({ indices: healthyIx, weather: null });
  assert.equal(none.findings.some((f) => f.source === 'weather'), false);
});

test('findings are ordered most severe first', () => {
  const a = wheat.adviseWheat({ indices: { ...healthyIx, ndviMean: 0.3 }, soil: { zincDtpaPpm: 0.2, ph: 4.9 }, weather: { windKmh: 20 } });
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  for (let i = 1; i < a.findings.length; i++) {
    assert.ok(order[a.findings[i - 1].severity] <= order[a.findings[i].severity]);
  }
});

test('the advice always states that satellite cannot measure soil chemistry', () => {
  const a = wheat.adviseWheat({ indices: healthyIx });
  assert.ok(a.unknowns.some((u) => /cannot see soil chemistry/.test(u)));
  assert.equal(a.confidence, 'low');
});
