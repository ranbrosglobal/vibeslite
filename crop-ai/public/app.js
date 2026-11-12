/* ============================================================================
 * Vibes Lite · Crop AI — Scientific Field Analysis Console (production)
 * ===========================================================================*/
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* Canvas 2D and inline SVG cannot resolve `var(--token)`, so the handful of
 * palette values those layers need are read once from the stylesheet. Every
 * other colour in the UI comes from CSS, so a theme change is a one-file edit. */
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
const UI = {
  acid:   cssVar('--acid', '#cbff3c'),
  flare:  cssVar('--flare', '#ff5c3a'),
  signal: cssVar('--signal', '#ffb020'),
  ice:    cssVar('--ice', '#4fd8e8'),
  ink:    cssVar('--void', '#07080a'),
  bone:   cssVar('--bone', '#eaede6'),
  dim:    cssVar('--dim', '#6b7480'),
  line:   cssVar('--line-strong', '#343c48'),
  text:   cssVar('--text', '#eaede6'),
};

const CLASSES = {
  healthy:  { label: 'Healthy crop',  hex: '#4CAF50', rgb: [76, 175, 80] },
  stressed: { label: 'Stressed crop', hex: '#FFC107', rgb: [255, 193, 7] },
  soil:     { label: 'Bare soil',     hex: '#795548', rgb: [121, 85, 72] },
  weed:     { label: 'Weed area',     hex: '#2E9E5B', rgb: [46, 158, 91] },
};
const CLASS_KEYS = Object.keys(CLASSES);

const state = {
  fields: [], fieldId: null, field: null, tileImage: null,
  activeClass: 'healthy', selectedTile: null, models: [],
  map: null, mapLayers: null, basemap: 'osm', sensors: [],
  osmStatus: null, osmFeatures: null, osmLayerOn: false, osmKinds: null, picked: null,
  camStream: null, ai: null,
  // geo map: which layer is painted, per-field layer payloads, and the device's
  // own fix (loaded from the server, never held only in this tab's memory)
  geoLayer: 'class', geo: null, geoCache: {},
  // sensor network: sites grouped by field with their deployed sensors
  sites: null,
  // CP10 workflow DAG: definitions from the server, runs per field
  workflows: null,
};

/* ------------------------------- helpers ---------------------------------- */
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = 'toast'), 4200);
}

/* ---------------------- count-up animation (premium) ----------------------- */
function countUp(el, to, { dur = 700 } = {}) {
  const from = Number(el.dataset.v || 0);
  if (!Number.isFinite(+to)) { el.textContent = '—'; return; }
  if (from === to) { el.textContent = to; el.dataset.v = to; return; }
  const t0 = performance.now();
  cancelAnimationFrame(el._raf);
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * eased);
    if (p < 1) el._raf = requestAnimationFrame(step);
    else el.dataset.v = to;
  };
  el._raf = requestAnimationFrame(step);
}

/* --------------------------- live activity feed ---------------------------- */
const SVG = (d) => `<svg viewBox="0 0 24 24" width="17" height="17"><path d="${d}" fill="currentColor"/></svg>`;
const leaf  = SVG('M17 8C8 10 5.9 16.2 3.8 21.3l1.9.7.9-2.3c.5.2 1 .3 1.4.3C19 20.2 22 3 22 3c0 0-5 2-9 4C9 9 7 11 7 11s2 .5 2.5 1.5C8 13 6.5 15 6.5 15s1.5-.5 2.5-1c0 0 .5 1 1.5 1C14 15 17 8 17 8z');
const sprout = SVG('M12 2C8 6 6 9 6 13a6 6 0 0012 0c0-4-2-7-6-11zm0 17a1 1 0 001-1v-3h3a1 1 0 000-2h-3v-3a1 1 0 00-2 0v3H8a1 1 0 000 2h3v3a1 1 0 001 1z');
const bug   = SVG('M12 2a2 2 0 00-2 2v1H8a5 5 0 00-5 5v1H1v2h2v1c0 1.5.4 2.9 1.1 4.1L2.6 19.6l1.4 1.4 1.1-1.1A7 7 0 0012 22a7 7 0 006.9-2.1l1.1 1.1 1.4-1.4-1.5-1.5c.7-1.2 1.1-2.6 1.1-4.1v-1h2v-2h-2v-1a5 5 0 00-5-5h-2V4a2 2 0 00-2-2z');
const weed  = SVG('M6 13s-2 1.5-2 4c0 2.8 2.2 5 5 5 1.3 0 2.5-.5 3.4-1.3C13 21.5 14.2 22 15.5 22c2.8 0 5-2.2 5-5 0-2.5-2-4-2-4s1-1 1-2.5C19.5 8 17.5 6 15 6c-.3-2-1.6-4-4-4-1 2-1 4-1 4-2.5 0-4.5 2-4.5 4.5C5.5 12 6 13 6 13z');
const drop  = SVG('M12 2.7S6 10 6 14.5A6 6 0 0018 14.5C18 10 12 2.7 12 2.7z');
const sun   = SVG('M12 7a5 5 0 100 10 5 5 0 000-10zm0-5v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10l2.1 2.1M19.1 4.9l-2.1 2.1m-10 10l-2.1 2.1');
const herd  = SVG('M4 5h6l2-2 2 2h6l-1.5 4H5.5zM5 10h14v3a7 7 0 01-14 0zm4 3h2m2 0h2');
const flask = SVG('M9 3h6v5l4.5 9.1A2 2 0 0117.7 20H6.3a2 2 0 01-1.8-2.9L9 8zm1 2v3.3L7.1 14h9.8L14 8.3V5z');
const MAX_FEED = 30;
function pushFeed(text, { bold } = {}) {
  const feed = $('#activity-feed');
  if (!feed) return;
  feed.querySelector('.act-empty')?.remove();
  const row = document.createElement('div');
  row.className = 'act';
  const time = new Date().toISOString().slice(11, 19);
  row.innerHTML = `<span class="act-time">${time}</span><span class="act-text">${bold ? `<b>${esc(bold)}</b> ` : ''}${esc(text)}</span>`;
  feed.prepend(row);
  while (feed.children.length > MAX_FEED) feed.lastElementChild.remove();
}
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
const fmtPct = (v) => (v == null ? '—' : `${(+v).toFixed(1)}%`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kv = (k, v) => `<div class="kv"><b>${esc(k)}</b><span>${v ?? '—'}</span></div>`;
const ICON = {
  ok: '<svg viewBox="0 0 24 24" width="11" height="11"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" fill="currentColor"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="11" height="11"><path d="M1 21h22L12 2zm10-3h-2v-2h2zm0-4h-2v-4h2z" fill="currentColor"/></svg>',
  critical: '<svg viewBox="0 0 24 24" width="11" height="11"><path d="M12 2a10 10 0 1010 10A10 10 0 0012 2zm1 15h-2v-2h2zm0-4h-2V7h2z" fill="currentColor"/></svg>',
  warning: '<svg viewBox="0 0 24 24" width="11" height="11"><path d="M1 21h22L12 2zm10-3h-2v-2h2zm0-4h-2v-4h2z" fill="currentColor"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="11" height="11"><path d="M12 2a10 10 0 1010 10A10 10 0 0012 2zm1 15h-2v-2h2zm0-4h-2V7h2z" fill="currentColor"/></svg>',
};

/** Clipboard write with a fallback: navigator.clipboard needs document focus,
 *  which it does not always have (iframes, background tabs, headless runs). */
function copyText(text, done) {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
    done();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, fallback);
  } else fallback();
}

/* --------------------------------- tabs -----------------------------------
 * Tab switching is the app's primary navigation, so it gets a real morph: the
 * DOM swap runs inside document.startViewTransition() where supported, which
 * snapshots the old and new views and cross-fades them while the nav rail
 * marker is interpolated from its old position to its new one. Without support
 * (or with reduced motion) the same function just updates the DOM directly.
 */
const TAB_NAMES = $$('#tabs button').map((b) => b.dataset.tab);
const REDUCED = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Slide the acid rail marker onto the active nav button, and on the mobile
 * rail (where the tabs scroll horizontally) bring that button into view —
 * otherwise a deep link like #applications lands on an off-screen tab.
 */
function moveGlider() {
  const glider = document.querySelector('.nav-glider');
  const rail = document.getElementById('tabs');
  const active = rail && rail.querySelector('button.on');
  if (!rail || !active) return;
  if (glider) {
    glider.style.height = `${active.offsetHeight}px`;
    glider.style.transform = `translateY(${active.offsetTop}px)`;
  }
  if (rail.scrollWidth > rail.clientWidth + 4) {
    const target = active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2;
    rail.scrollTo({ left: Math.max(0, target), behavior: REDUCED() ? 'auto' : 'smooth' });
  }
}

function applyTab(name) {
  $$('#tabs button').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $$('.tab').forEach((s) => s.classList.toggle('on', s.id === `tab-${name}`));
  moveGlider();

  if (name === 'geo') {
    setTimeout(initMap, 60);
    // Opening the map is the moment the console's question "where are you?"
    // becomes useful, so that is when the browser is asked - once per page load,
    // and never again after a refusal (the card keeps the manual button).
    // Boot already read the stored fix; only the first visit to this tab asks.
    (state.locLoaded ? Promise.resolve() : loadLocation()).then(() => { if (!state.location) autoAskLocation(); });
  }
  if (name === 'sensors') loadSites().then(renderSensors);
  if (name === 'lab') renderModels();
  if (name === 'ai') renderAi();
  if (name === 'workflows') initWorkflows();
}

let lastTab = null;
function showTab(name, { silent = false } = {}) {
  if (!TAB_NAMES.includes(name)) name = TAB_NAMES[0];
  if (name === lastTab) return;
  lastTab = name;
  try { localStorage.setItem('vl-tab', name); } catch {}
  if (!silent) {
    const url = new URL(location.href);
    url.hash = name;
    history.replaceState(null, '', url);
  }

  if (typeof document.startViewTransition !== 'function' || REDUCED()) {
    applyTab(name);
    return;
  }
  // Suppress the marker's own CSS transition while the browser interpolates it.
  document.documentElement.classList.add('vt');
  const tx = document.startViewTransition(() => applyTab(name));
  tx.finished.finally(() => document.documentElement.classList.remove('vt'));
}

$$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* Roving keyboard navigation across the section rail (tablist pattern). */
$('#tabs').addEventListener('keydown', (e) => {
  const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const cur = TAB_NAMES.indexOf(document.querySelector('#tabs button.on')?.dataset.tab);
  let next = cur;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (cur + 1) % TAB_NAMES.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (cur - 1 + TAB_NAMES.length) % TAB_NAMES.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = TAB_NAMES.length - 1;
  $(`#tabs button[data-tab="${TAB_NAMES[next]}"]`).focus();
  showTab(TAB_NAMES[next]);
  e.preventDefault();
});

/* Deep links + back/forward: #geo opens the Geo Map directly, and a reload
 * restores the section you were last in. */
window.addEventListener('hashchange', () => {
  const h = location.hash.replace('#', '');
  if (h && h !== lastTab) showTab(h, { silent: true });
});
window.addEventListener('resize', moveGlider);

function bootTab() {
  let start = location.hash.replace('#', '');
  if (!start) { try { start = localStorage.getItem('vl-tab') || ''; } catch {} }
  if (!TAB_NAMES.includes(start)) start = TAB_NAMES[0];
  applyTab(start);
  lastTab = start;
}
requestAnimationFrame(() => {
  bootTab();
  document.documentElement.classList.add('booted');
});

/* ------------------------------ SSE live feed ------------------------------ */
function connectSSE() {
  const es = new EventSource('/api/events');
  const badge = $('#st-sse');
  es.onopen = () => { badge.classList.add('on'); badge.innerHTML = '<i class="pulse-dot"></i><span>LINK LIVE</span>'; };
  es.onerror = () => { badge.classList.remove('on'); const s = badge.querySelector('span'); if (s) s.textContent = 'LINK —'; };
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'device-reading': {
        const { fieldId, deviceId, reading } = msg.payload;
        const n = Object.keys(reading).length - 1;
        toast(`${deviceId || 'Site'} reported ${n} value${n === 1 ? '' : 's'} at ${fieldId}`);
        pushFeed(`${deviceId || 'Site reading'} ingested · ${n} values`, { bold: fieldId });
        delete state.geoCache[fieldId];
        loadSites().then(renderSensors);
        if (state.map && $('#tab-geo').classList.contains('on')) updateMap();
        break;
      }
      case 'device-added':
        pushFeed(`Sensor registered · ${msg.payload.device.deviceId}`, { bold: msg.payload.fieldId });
        delete state.geoCache[msg.payload.fieldId];
        loadSites().then(renderSensors);
        break;
      case 'device-removed':
        pushFeed(`Sensor removed · ${msg.payload.deviceId}`, { bold: msg.payload.fieldId });
        delete state.geoCache[msg.payload.fieldId];
        loadSites().then(renderSensors);
        if (state.map) updateMap();
        break;
      case 'field-analyzed':
        pushFeed('Field analyzed', { bold: msg.payload.fieldId });
        refreshFields().then(() => { if (msg.payload.fieldId === state.fieldId) renderAnalysis(msg.payload); });
        break;
      case 'trained':
        pushFeed('Model trained & cross-validated');
        refreshSystem().then(refreshModels);
        break;
      case 'field-deleted':
        pushFeed('Field deleted', { bold: msg.payload.fieldId });
        refreshFields();
        break;
      case 'location-updated': {
        // Another tab - or another operator on the LAN - moved the device. The
        // console follows the shared fix rather than its own stale memory.
        state.location = msg.payload.location;
        if (state.location?.live) state.locLive = state.location.live;
        renderLocation();
        if (state.map && $('#tab-geo').classList.contains('on')) updateMap();
        break;
      }
      case 'location-cleared':
        state.location = null;
        state.locLive = null;
        renderLocation();
        if (state.map) updateMap();
        break;
      case 'ai-analyzed':
        pushFeed('AI analysis complete', { bold: `${msg.payload.fieldId} (${msg.payload.source})` });
        if (state.ai) renderAiStatus();
        break;
      case 'plant-identified': {
        const p = msg.payload || {};
        const nm = p.common || p.scientific || 'unknown species';
        toast(`Identified: ${nm} (${Math.round((p.confidence || 0) * 100)}%)`);
        const srcLabel = p.source === 'camera' ? 'camera' : 'field view';
        pushFeed(`Species identified · ${nm}`, { bold: srcLabel });
        loadIdentifyHistory();
        if (state.ai) renderAiStatus();
        break;
      }
      case 'workflow-node': {
        const p = msg.payload || {};
        pushFeed(`Node ${p.nodeId || ''} ${p.status}${p.durationMs ? ` in ${p.durationMs} ms` : ''}`, { bold: p.workflowId });
        break;
      }
      case 'workflow-run': {
        const p = msg.payload || {};
        pushFeed(`Workflow ${p.workflowId} ${p.status}`, { bold: `${p.executed} ran / ${p.reused} cached` });
        if ($('#tab-workflows') && $('#tab-workflows').classList.contains('on')) loadRuns();
        break;
      }
      case 'reset': location.reload(); break;
      case 'sensors':
        state.sensors = Array.isArray(msg.payload) ? msg.payload : [];
        if ($('#tab-sensors').classList.contains('on')) renderSensors();
        break;
    }
  }
}

/* --------------------------- applications data ----------------------------- */
const APPLICATIONS = [
  { icon: leaf, title: 'Plant Health', body: 'Separate healthy canopy from stressed vegetation across the orthophoto, tile by tile.', tag: 'Healthy · Stressed' },
  { icon: sprout, title: 'Crop Growth', body: 'Track canopy presence and bare soil share over time to follow establishment and cover.', tag: 'Canopy · Soil' },
  { icon: bug, title: 'Leaf Disease', body: 'Stressed tiles flag where discoloration clusters — the first places to walk and inspect.', tag: 'Scouting' },
  { icon: weed, title: 'Weed Detection', body: 'The weed class maps infestation pressure so spot spraying can replace blanket spraying.', tag: 'Weed · Crop' },
  { icon: drop, title: 'Soil Condition', body: 'Bare-soil share plus live probe moisture and Open-Meteo ET0 drive the irrigation advisory.', tag: 'Moisture · ET0' },
  { icon: sun, title: 'Ripeness & Sorting', body: 'Label a new class set — ripeness stages or quality grades — and retrain for sorting lines.', tag: 'Relabel · Retrain' },
  { icon: herd, title: 'Herd Recognition', body: 'Any object taxonomy fits the same engine: label tiles or crops as classes and train.', tag: 'Custom classes' },
  { icon: flask, title: 'Field Trials', body: 'Confusion matrix and per-class F1 from 5-fold CV tell you if a model is honest before deployment.', tag: '5-fold CV' },
];

function renderApplications() {
  const grid = $('#apps-grid');
  if (!grid || grid.dataset.done) return;
  grid.dataset.done = '1';
  grid.innerHTML = APPLICATIONS.map((a) => `
    <article class="app-card">
      <div class="app-ico">${a.icon}</div>
      <h4>${a.title}</h4>
      <p>${a.body}</p>
      <span class="app-tag">${a.tag}</span>
    </article>`).join('');
}

/* ---------------------------- system status bar ---------------------------- */
async function refreshSystem() {
  try {
    const cv = await api('/api/cv-status');
    $('#st-opencv span').textContent = `CV ${cv.mode.toUpperCase()}`;
    $('#st-opencv').className = 'stat ' + (cv.opencv ? 'ok' : 'warn');
  } catch {}
  const geoN = state.fields.filter((f) => f.gps && f.gps.lat != null).length;
  $('#st-geo span').textContent = `GEO ${geoN}/${state.fields.length}`;
  $('#st-geo').className = 'stat ' + (geoN ? 'ok' : '');
  $('#sysline').textContent =
    `Fields ${state.fields.length} · analyzed ${state.fields.filter((f) => f.status === 'analyzed').length} · georef ${geoN} · ${new Date().toISOString().slice(11, 19)} UTC`;
  countUp($('#kpi-fields'), state.fields.length);
  countUp($('#kpi-samples'), state.datasetStats?.samples || 0);
  countUp($('#kpi-models'), state.models.length);
  countUp($('#kpi-geo'), geoN);
  renderPipeline();
}

function renderPipeline() {
  const ds = state.datasetStats || { samples: 0 };
  const analyzed = state.fields.filter((f) => f.status === 'analyzed').length;
  const geoN = state.fields.filter((f) => f.gps?.lat != null).length;
  $('#pipeline-klist').innerHTML =
    kv('imagery ingested', state.fields.length) +
    kv('georeferenced', geoN) +
    kv('analyzed', analyzed) +
    kv('dataset samples', ds.samples) +
    kv('models', state.models.length) +
    kv('weather feed', state.sensors.some((s) => s.weather) ? 'OPEN-METEO LIVE' : '—') +
    kv('device feed', state.sensors.some((s) => s.device?.length) ? 'ACTIVE' : '—');
}

/* ------------------------------ fields registry ---------------------------- */
async function refreshFields() {
  state.fields = await api('/api/fields');
  for (const sel of ['#field-select', '#analysis-field', '#sensor-field', '#ai-field', '#geo-field']) {
    const el = $(sel);
    const prev = el.value;
    el.innerHTML = state.fields.length
      ? state.fields.map((f) => `<option value="${esc(f.fieldId)}">${esc(f.fieldId)}${f.gps?.lat != null ? ' · georef' : ''}</option>`).join('')
      : '<option value="">— no fields —</option>';
    if (prev && state.fields.some((f) => f.fieldId === prev)) el.value = prev;
  }
  if (!state.fieldId || !state.fields.some((f) => f.fieldId === state.fieldId))
    state.fieldId = state.fields.at(-1)?.fieldId || null;
  if (state.fieldId) {
    $('#field-select').value = state.fieldId;
    $('#analysis-field').value = state.fieldId;
    $('#sensor-field').value = state.fieldId;
    $('#ai-field').value = state.fieldId;
    $('#geo-field').value = state.fieldId;
  }
  renderRegistry();
  renderLabelProgress();
  if (state.fieldId) await selectField(state.fieldId, { quiet: true });
  refreshSystem();
}

function renderRegistry() {
  const tb = $('#fields-table tbody');
  tb.innerHTML = state.fields.map((f) => `
    <tr>
      <td class="mono">${esc(f.fieldId)}</td>
      <td class="mono dim">${esc(f.imageName || '')}</td>
      <td>${f.gps?.lat != null ? `<span class="mono">${f.gps.lat.toFixed(5)}, ${f.gps.lon.toFixed(5)}</span> <span class="chip">${esc(f.gps.source)}</span>` : '<span class="dim">—</span>'}</td>
      <td class="mono">${f.grid.rows}×${f.grid.cols}</td>
      <td>${f.status === 'analyzed' ? '<span class="chip ok-chip">Analyzed</span>' : '<span class="chip">Ingested</span>'}</td>
      <td class="num">${f.status === 'analyzed' ? fmtPct(f.statsPct.healthy) : '—'}</td>
      <td class="num">${f.status === 'analyzed' ? fmtPct(f.statsPct.stressed) : '—'}</td>
      <td class="num">${f.status === 'analyzed' ? fmtPct(f.statsPct.soil) : '—'}</td>
      <td class="num">${f.status === 'analyzed' ? fmtPct(f.statsPct.weed) : '—'}</td>
      <td class="actions">
        <button class="btn sm" data-act="open" data-id="${esc(f.fieldId)}">Open</button>
        <button class="btn sm danger" data-act="del" data-id="${esc(f.fieldId)}">Del</button>
      </td>
    </tr>`).join('');
  $('#fields-empty').hidden = state.fields.length > 0;
  tb.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.act === 'open') { showTab('analysis'); $('#analysis-field').value = b.dataset.id; await selectField(b.dataset.id); }
    else if (confirm(`Delete field ${b.dataset.id}?`)) { await api(`/api/fields/${b.dataset.id}`, { method: 'DELETE' }); refreshFields(); }
  }));
}

async function selectField(fieldId, { quiet } = {}) {
  state.fieldId = fieldId;
  state.field = await api(`/api/fields/${fieldId}`);
  delete state.geoCache[fieldId];
  await loadImageForField();
  drawCanvas();
  renderAnalysis();
  if (!quiet) renderSensors();
  if (state.map) updateMap();
}

function loadImageForField() {
  return new Promise((resolve) => {
    if (!state.field) return resolve();
    const img = new Image();
    img.onload = () => { state.tileImage = img; resolve(); };
    img.onerror = () => { state.tileImage = null; resolve(); };
    img.src = state.field.imagePath;
  });
}

/* ------------------------------- ingest / upload ---------------------------- */
async function uploadBlob(blob, filename, latLon) {
  const fd = new FormData();
  fd.append('image', blob, filename);
  if (latLon) { fd.append('lat', latLon.lat); fd.append('lon', latLon.lon); }
  $('#upload-progress').hidden = false;
  $('#upload-bar').style.width = '40%';
  $('#upload-label').textContent = `UPLOADING ${filename}`;
  try {
    const r = await api('/api/upload', { method: 'POST', body: fd });
    $('#upload-bar').style.width = '100%';
    const g = r.field.gps;
    state.fieldId = r.field.fieldId;
    await refreshFields();
    showTab('analysis');
    toast(`${r.field.fieldId} ingested${g?.lat != null ? ` — GPS ${g.lat.toFixed(5)}, ${g.lon.toFixed(5)} [${g.source}]` : ' — no GPS; geotag in Analysis for map & weather'}`, !g?.lat);
  } catch (e) { toast(e.message, true); }
  setTimeout(() => { $('#upload-progress').hidden = true; }, 1500);
}

function wireUpload() {
  $('#file-input').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (f) uploadBlob(f, f.name);
    ev.target.value = '';
  });

  $('#btn-camera').addEventListener('click', async () => {
    $('#camera-modal').hidden = false;
    $('#identify-result').hidden = true;
    $('#identify-result').innerHTML = '';
    try {
      state.camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1920, height: 1080 }, audio: false });
      $('#cam-video').srcObject = state.camStream;
    } catch (e) { toast(`Camera unavailable: ${e.message}`, true); closeModal(); }
  });
  $('#btn-cam-close').addEventListener('click', closeModal);
  $('#btn-capture').addEventListener('click', async () => {
    const video = $('#cam-video');
    const btn = $('#btn-capture');
    if (!video.videoWidth || !video.videoHeight) { toast('Camera is still starting — try again in a moment.', true); return; }
    btn.disabled = true;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(async (blob) => {
      if (!blob) { btn.disabled = false; toast('Capture failed — could not encode the frame.', true); return; }
      closeModal();
      let latLon = null;
      if (navigator.geolocation) {
        latLon = await new Promise((res) => navigator.geolocation.getCurrentPosition(
          (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
          () => res(null), { timeout: 4000 }));
      }
      uploadBlob(blob, `capture-${Date.now()}.png`, latLon);
    }, 'image/png');
  });

  /* Identify plant: same frame, but sent to the SPECIES model instead of the
   * ingest pipeline. The modal stays open so the result is readable, and the
   * frame never becomes a field (no husk fields from identification). */
  $('#btn-identify').addEventListener('click', async () => {
    const video = $('#cam-video');
    const btn = $('#btn-identify');
    const out = $('#identify-result');
    if (!video.videoWidth || !video.videoHeight) { toast('Camera is still starting — try again in a moment.', true); return; }
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Identifying…';
    out.hidden = false;
    out.innerHTML = '<div class="idr-wait"><span class="pulse-dot"></span> Asking the vision model…</div>';
    try {
      const frame = grabFrame(video);
      let gps = null;
      if (navigator.geolocation) {
        gps = await new Promise((res) => navigator.geolocation.getCurrentPosition(
          (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }), () => res(null), { timeout: 4000 }));
      }
      const r = await api('/api/ai/identify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: frame.dataUrl, thumb: frame.thumb, source: 'camera', gps }),
      });
      out.innerHTML = identifyResultHTML(r.result, { model: r.model, latencyMs: r.latencyMs, source: 'camera' });
      loadIdentifyHistory();
      if (state.ai) renderAiStatus();
    } catch (e) {
      out.innerHTML = `<div class="idr-error">${esc(e.message)}</div>`;
    }
    btn.textContent = label;
    btn.disabled = false;
  });
  function closeModal() {
    $('#camera-modal').hidden = true;
    state.camStream?.getTracks().forEach((t) => t.stop());
    state.camStream = null;
  }
}

/* ------------------------------ labeling studio ----------------------------- */
function drawCanvas() {
  const canvas = $('#tile-canvas'), ctx = canvas.getContext('2d');
  const f = state.field;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!f) {
    ctx.fillStyle = UI.dim; ctx.font = '13px Inter, sans-serif';
    ctx.fillText('No field selected', 20, 32);
    return;
  }
  if (state.tileImage) ctx.drawImage(state.tileImage, 0, 0, canvas.width, canvas.height);
  const scale = canvas.width / f.width, T = f.tileSize * scale;
  for (const t of f.tiles || []) {
    const x = t.c * T, y = t.r * T;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1; ctx.strokeRect(x, y, T, T);
    const cls = t.manualClass || t.predictedClass;
    if (cls && CLASSES[cls]) {
      ctx.fillStyle = CLASSES[cls].hex + (t.manualClass ? 'cc' : '55');
      ctx.fillRect(x + 1, y + 1, T - 2, T - 2);
      if (t.manualClass) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, T - 2, T - 2); }
    }
    if (state.selectedTile?.r === t.r && state.selectedTile?.c === t.c) {
      ctx.strokeStyle = UI.acid; ctx.lineWidth = 3; ctx.strokeRect(x, y, T, T);
    }
  }
  renderLabelProgress();
}

function renderLabelProgress() {
  const f = state.field;
  const man = f ? (f.tiles || []).filter((t) => t.manualClass).length : 0;
  $('#label-progress').textContent = f ? `${man} tiles labeled · ${f.fieldId}` : '';
  api('/api/dataset/stats').then((s) => {
    state.datasetStats = s;
    $('#dataset-klist').innerHTML =
      kv('samples', s.samples) +
      CLASS_KEYS.map((k) => kv(CLASSES[k].label, s.perClass[k] ?? 0)).join('');
    renderPipeline();
  }).catch(() => {});
}

$('#tile-canvas').addEventListener('click', async (ev) => {
  const f = state.field;
  if (!f) return;
  const rect = ev.target.getBoundingClientRect();
  const scale = f.width / rect.width;
  const x = (ev.clientX - rect.left) * scale, y = (ev.clientY - rect.top) * scale;
  const c = Math.floor(x / f.tileSize), r = Math.floor(y / f.tileSize);
  if (!(f.tiles || []).some((t) => t.r === r && t.c === c)) return;
  state.selectedTile = { r, c };
  try {
    await api('/api/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fieldId: f.fieldId, r, c, class: state.activeClass }) });
    const t = f.tiles.find((t) => t.r === r && t.c === c);
    if (t) t.manualClass = state.activeClass;
    drawCanvas();
  } catch (e) { toast(e.message, true); }
});

$$('#class-list .cls').forEach((b) => b.addEventListener('click', () => {
  $$('#class-list .cls').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  state.activeClass = b.dataset.class;
}));

$('#btn-from-labels').addEventListener('click', async () => {
  try {
    const r = await api('/api/dataset/from-labels', { method: 'POST' });
    toast(`Dataset +${r.added} tiles (${r.samples} total)`);
    renderLabelProgress();
  } catch (e) { toast(e.message, true); }
});

/* --------------------------------- training -------------------------------- */
$('#btn-train').addEventListener('click', async () => {
  const b = $('#btn-train');
  b.disabled = true;
  try {
    const r = await api('/api/train', { method: 'POST' });
    toast(r.reused
      ? `Dataset unchanged — reusing ${r.modelId} (CV accuracy ${(r.metrics.accuracy * 100).toFixed(1)}%)`
      : `Model trained — CV accuracy ${(r.metrics.accuracy * 100).toFixed(1)}%`);
    $('#train-result').innerHTML =
      kv('cv accuracy', (r.metrics.accuracy * 100).toFixed(1) + '%') +
      kv('macro f1', r.metrics.macroF1) +
      kv('folds', r.metrics.folds) + kv('tested', r.metrics.tested);
    await refreshModels();
    showTab('lab');
  } catch (e) { toast(e.message, true); }
  b.disabled = false;
});

async function refreshModels() {
  state.models = await api('/api/models');
  if (state.models.length) {
    $('#st-model span').textContent = `MODEL ${state.models.at(-1).samples}S`;
    $('#st-model').className = 'stat ok';
  }
  renderModels();
  renderPipeline();
  countUp($('#kpi-models'), state.models.length);
}

function renderModels() {
  const el = $('#models-list');
  if (!state.models.length) { el.innerHTML = '<p class="note">No models trained yet. Label tiles in Labeling, then train.</p>'; return; }
  el.innerHTML = `<table class="data-table"><thead><tr><th>Model ID</th><th>Classes</th><th class="num">Samples</th><th class="num">CV acc</th><th class="num">Macro F1</th><th>Trained</th><th></th></tr></thead><tbody>` +
    state.models.map((m) => `
      <tr>
        <td class="mono">${esc(m.modelId)}</td>
        <td class="mono dim">${m.classes.map((c) => c).join(' / ')}</td>
        <td class="num">${m.samples}</td>
        <td class="num">${m.metrics ? (m.metrics.accuracy * 100).toFixed(1) + '%' : '—'}</td>
        <td class="num">${m.metrics?.macroF1 ?? '—'}</td>
        <td class="mono dim">${new Date(m.trainedAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
        <td><button class="btn sm" data-id="${esc(m.modelId)}">Metrics</button></td>
      </tr>`).join('') + '</tbody></table>';
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => showMetrics(b.dataset.id)));
  const last = state.models.at(-1);
  if (last) showMetrics(last.modelId);
}

function showMetrics(modelId) {
  const m = state.models.find((x) => x.modelId === modelId);
  if (!m || !m.metrics) return;
  $('#metrics-card').hidden = false;
  $('#metrics-model').textContent = m.modelId;
  const { accuracy, macroF1, folds, tested, perClass, confusion } = m.metrics;
  $('#metrics-overall').innerHTML = kv('cv accuracy', (accuracy * 100).toFixed(1) + '%') + kv('macro f1', macroF1) + kv('folds', folds) + kv('samples tested', tested);
  $('#metrics-table tbody').innerHTML = Object.entries(perClass).map(([k, v]) =>
    `<tr><td>${CLASSES[k].label}</td><td class="num">${v.precision ?? '—'}</td><td class="num">${v.recall ?? '—'}</td><td class="num">${v.f1 ?? '—'}</td><td class="num">${v.support}</td></tr>`).join('');
  const keys = Object.keys(confusion);
  $('#cm-table').innerHTML =
    `<thead><tr><th>Truth \\ Pred</th>${keys.map((k) => `<th class="mono">${k.slice(0, 4)}</th>`).join('')}</tr></thead><tbody>` +
    keys.map((t) => `<tr><td>${t}</td>${keys.map((p) => `<td class="num" style="${t === p ? 'color:var(--acid)' : confusion[t][p] ? 'color:var(--danger)' : 'color:rgba(234,237,230,0.16)'}">${confusion[t][p] || '·'}</td>`).join('')}</tr>`).join('') +
    '</tbody>';
}

/* ------------------------------ quick tile test ----------------------------- */
$('#tile-file').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append('image', f);
  try {
    const r = await api('/api/tile', { method: 'POST', body: fd });
    const p = r.prediction;
    $('#tile-result').innerHTML = p
      ? `→ <b style="color:${CLASSES[p.predictedClass].hex}">${p.predictedClass}</b> · conf ${p.confidence}`
      : 'Features extracted — no active model';
  } catch (e) { toast(e.message, true); }
  ev.target.value = '';
});

/* --------------------------------- analysis -------------------------------- */
async function renderAnalysis(f) {
  f = f || state.field;
  if (!f) return;
  if (!f.tiles) f = state.field = await api(`/api/fields/${f.fieldId}`);
  $('#img-original').classList.remove('loaded');
  $('#img-overlay').classList.remove('loaded');
  $('#img-original').src = f.imagePath;
  $('#img-overlay').src = f.overlayPath || '';
  $('#exif-info').innerHTML = f.gps?.lat != null
    ? kv('georef', `${f.gps.lat}, ${f.gps.lon} [${f.gps.source}]`) + kv('camera', f.gps.camera || '—') + kv('captured', f.gps.capturedAt || '—') + kv('footprint', `${f.groundWidthM || '—'} m`)
    : '<span class="dim">Not georeferenced — add coordinates for map + live weather</span>';

  $('#dist').innerHTML = CLASS_KEYS.map((k) => `
    <div class="d-row"><span class="mono">${k}</span>
      <div class="bar"><div class="fill" style="width:${f.statsPct?.[k] || 0}%;background:${CLASSES[k].hex}"></div></div>
      <span class="pct mono">${fmtPct(f.statsPct?.[k])}</span></div>`).join('');

  const irr = f.irrigation;
  $('#irrigation').innerHTML = !irr ? '<span class="dim">Analyze field to evaluate</span>'
    : irr.insufficient ? `<div class="irr na"><div class="rec">Insufficient data</div><ul><li>${esc(irr.reason)}</li></ul></div>`
    : `
    <div class="irr ${irr.urgency}">
      <div class="rec">${esc(irr.recommendation)}${irr.litersPerAcre ? ` — ${irr.litersPerAcre} L/acre` : ''}</div>
      <ul>${irr.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <div class="alerts">${(irr.alerts || []).map((a) => `<span class="alert ${a.level}">${esc(a.text)}</span>`).join('')}</div>
    </div>`;
}

for (const id of ['#img-original', '#img-overlay']) {
  const el = $(id);
  el.addEventListener('load', () => el.classList.add('loaded'));
}

$('#analysis-field').addEventListener('change', (ev) => selectField(ev.target.value));
$('#btn-predict').addEventListener('click', async () => {
  if (!state.fieldId) return toast('Select a field first', true);
  const b = $('#btn-predict'); b.disabled = true;
  try {
    const r = await api('/api/predict', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fieldId: state.fieldId }) });
    await selectField(state.fieldId, { quiet: true });
    renderAnalysis(r.field);
    toast(`${state.fieldId} analyzed — healthy ${fmtPct(r.field.statsPct.healthy)}`);
  } catch (e) { toast(e.message, true); }
  b.disabled = false;
});

$('#btn-geotag-show').addEventListener('click', () => {
  const box = $('#geotag-box');
  box.hidden = !box.hidden;
  if (!box.hidden && state.field?.gps) {
    $('#geo-lat').value = state.field.gps.lat ?? '';
    $('#geo-lon').value = state.field.gps.lon ?? '';
    $('#geo-width').value = state.field.groundWidthM ?? '';
  }
});
$('#btn-geo-gps').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('No geolocation available', true);
  navigator.geolocation.getCurrentPosition(
    (p) => { $('#geo-lat').value = p.coords.latitude.toFixed(6); $('#geo-lon').value = p.coords.longitude.toFixed(6); toast('Device GPS acquired'); },
    () => toast('GPS denied', true));
});
$('#btn-geotag').addEventListener('click', async () => {
  try {
    const r = await api(`/api/fields/${state.fieldId}/geotag`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: +$('#geo-lat').value, lon: +$('#geo-lon').value, groundWidthM: +$('#geo-width').value || undefined }),
    });
    state.field = r.field;
    renderAnalysis(r.field);
    refreshFields();
    toast('Field georeferenced');
  } catch (e) { toast(e.message, true); }
});
$('#btn-geojson').addEventListener('click', async () => {
  try {
    const gj = await api(`/api/fields/${state.fieldId}/geojson`);
    const blob = new Blob([JSON.stringify(gj, null, 2)], { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.fieldId}.geojson`;
    a.click();
    toast('GeoJSON exported — QGIS / Google Earth ready');
  } catch (e) { toast(e.message, true); }
});
$('#btn-delete').addEventListener('click', async () => {
  if (!confirm(`Delete ${state.fieldId}?`)) return;
  await api(`/api/fields/${state.fieldId}`, { method: 'DELETE' });
  state.fieldId = null; state.field = null;
  await refreshFields();
});

/* ---------------------------------- geo map --------------------------------- */
const BASEMAPS = {
  esri: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Esri, Maxar, Earthstar Geographics', maxZoom: 19 },
  google: { url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', attr: 'Google', maxZoom: 20 },
  hybrid: { url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', attr: 'Google', maxZoom: 20 },
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: 'OpenStreetMap', maxZoom: 19 },
};

function initMap() {
  if (state.map) { updateMap(); return; }
  state.map = L.map('map', { zoomControl: true });
  state.mapLayers = L.layerGroup().addTo(state.map);
  state.osmLayer = L.layerGroup().addTo(state.map);
  // Click anywhere to name the place (reverse geocoding) and offer it as the
  // focused field's location - the same coordinate the basemap shows.
  state.map.on('click', (ev) => {
    // While the user is marking their field (aoi.js), a click places a corner, not a place lookup.
    if (window.aoiDrawing && window.aoiDrawing()) return;
    handleMapPick(ev.latlng).catch(() => {});
  });
  setBasemap(state.basemap);
  renderLayerBar();
  updateMap();
  initOsm().catch(() => {});   // never blocks the map from drawing
}

function setBasemap(name) {
  state.basemap = name;
  if (!BASEMAPS[name]) name = 'osm';
  if (state.baseLayer) state.map.removeLayer(state.baseLayer);
  const b = BASEMAPS[name];
  state.baseLayer = L.tileLayer(b.url, { attribution: b.attr, maxZoom: b.maxZoom }).addTo(state.map);
}

/* ══════════════════════════ OPENSTREETMAP ══════════════════════════════════
 * Place search (Nominatim) and real map features (Overpass), both through this
 * server's /api/geo/* proxy rather than straight from the tab. The proxy keeps
 * the browser's connect-src at 'self', enforces the Nominatim one-request-per-
 * second policy in one place, and hands back the attribution and licence the
 * map is obliged to show. Nothing here invents a place name or a feature.
 * ══════════════════════════════════════════════════════════════════════════ */
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

async function initOsm() {
  try { state.osmStatus = await api('/api/geo/status'); } catch { state.osmStatus = null; }
  applyOsmBasemaps();
  renderOsmKinds();
  renderOsmCredit();
}

/** The server owns the basemap list; the local table is only a first paint. */
function applyOsmBasemaps() {
  const sel = $('#basemap');
  const fromServer = state.osmStatus?.basemaps || [];
  fromServer.forEach((b) => {
    BASEMAPS[b.key] = { url: b.url, attr: b.attribution, maxZoom: b.maxZoom };
  });
  const order = [
    ...fromServer.map((b) => ({ key: b.key, label: b.label })),
    { key: 'esri', label: 'Esri World Imagery' },
    { key: 'google', label: 'Google Satellite' },
    { key: 'hybrid', label: 'Google Hybrid' },
  ];
  sel.innerHTML = order.filter((o) => BASEMAPS[o.key]).map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('');
  if (!BASEMAPS[state.basemap]) state.basemap = fromServer[0]?.key || 'osm';
  sel.value = state.basemap;
  if (state.map && state.baseLayer) setBasemap(state.basemap);
}

/** Feature-class chips for the Overpass layer. */
function renderOsmKinds() {
  const bar = $('#osm-kinds');
  if (!bar) return;
  const available = state.osmStatus?.featureKinds || [];
  if (state.osmKinds == null) state.osmKinds = state.osmStatus?.defaultKinds || ['roads', 'waterways', 'water', 'landuse'];
  bar.innerHTML = available.map((k) => (
    `<button class="layer-chip${state.osmKinds.includes(k.key) ? ' on' : ''}" data-osm-kind="${esc(k.key)}" title="${esc(k.label)}">${esc(k.label)}</button>`
  )).join('');
  bar.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.osmKind;
    state.osmKinds = state.osmKinds.includes(key) ? state.osmKinds.filter((k) => k !== key) : [...state.osmKinds, key];
    renderOsmKinds();
    if (state.osmLayerOn) drawOsmFeatures();
  }));
}

function renderOsmCredit() {
  const el = $('#osm-credit');
  if (!el) return;
  const providers = state.osmStatus?.providers || [];
  const tiles = providers.find((p) => p.name === 'OSM raster tiles');
  if (!state.osmStatus) {
    el.innerHTML = 'OpenStreetMap status unavailable — the basemaps still load from the tile servers.';
    return;
  }
  el.innerHTML = `Basemaps, place search and map features: OpenStreetMap contributors (ODbL) · `
    + `<a href="${OSM_COPYRIGHT_URL}" target="_blank" rel="noreferrer noopener">copyright</a> · `
    + `tile hosts <span class="mono">${esc((tiles?.hosts || []).join(', '))}</span> · ${esc(tiles?.policy || '')}`;
}

/** Real OSM features around the focused field (or the current view centre). */
async function drawOsmFeatures({ force = false } = {}) {
  const layer = state.osmLayer;
  if (!layer || !state.map) return;
  if (!state.osmLayerOn) { layer.clearLayers(); renderOsmNote(''); state.osmKey = null; return; }
  if (!state.osmKinds.length) { layer.clearLayers(); renderOsmNote('Select at least one OpenStreetMap feature class.'); return; }

  const focused = geoFocusFieldId();
  const f = state.fields.find((x) => x.fieldId === focused);
  const c = f?.gps?.lat != null ? [f.gps.lat, f.gps.lon] : state.map.getCenter();
  // Redrawing on every map update would flicker and re-query; only a change of
  // focus field, class selection or an explicit request forces a fresh draw.
  const key = `${focused || 'view'}:${c[0].toFixed(5)},${c[1].toFixed(5)}:${state.osmKinds.join(',')}`;
  if (!force && key === state.osmKey) return;
  state.osmKey = key;
  layer.clearLayers();
  const gen = state.osmGen = (state.osmGen || 0) + 1;
  renderOsmNote('Loading real OpenStreetMap features…');
  try {
    const out = await api(`/api/geo/features?lat=${c[0].toFixed(6)}&lon=${c[1].toFixed(6)}&radius_m=1200&kinds=${encodeURIComponent(state.osmKinds.join(','))}`);
    if (gen !== state.osmGen) return;   // a newer request already won
    state.osmFeatures = out;
    const styles = Object.fromEntries((out.kindsAvailable || []).map((k) => [k.key, k.style]));
    L.geoJSON(out.geojson, {
      style: (feature) => {
        const isArea = feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon';
        const st = styles[feature.properties.kind] || { color: '#cbff3c', weight: 1 };
        return { color: st.color, weight: st.weight, opacity: 0.85, fillOpacity: isArea ? 0.12 : 0 };
      },
      onEachFeature: (feature, lyr) => {
        const tags = Object.entries(feature.properties.tags || {}).map(([k, v]) => `<i>${esc(k)}</i><span>${esc(v)}</span>`).join('');
        lyr.bindPopup(`<b>${esc(feature.properties.label)}</b><div class="pp-rows">${tags}</div>`
          + `<div class="pp-src"><span class="id">${esc(feature.properties.osmId)}</span> · ${esc(feature.properties.kindLabel)}</div>`);
      },
    }).addTo(layer);
    renderOsmNote(`${out.featureCount} real OpenStreetMap features within ${out.radiusM} m`
      + `${out.cached ? ' (cached)' : ''} · ${Object.entries(out.counts).filter(([, n]) => n).map(([k, n]) => `${esc(k)} ${n}`).join(' · ')}`);
  } catch (e) {
    if (gen !== state.osmGen) return;
    renderOsmNote(`OpenStreetMap features unavailable: ${esc(e.message)}`);
  }
}

function renderOsmNote(text) {
  const el = $('#osm-note');
  if (el) el.textContent = text;
}

/** Name the place at a clicked coordinate and offer it as the field location. */
async function handleMapPick(latlng) {
  const { lat, lng } = latlng;
  state.picked = { lat, lon: lng, place: null, loading: true };
  renderPick();
  if (state.pickMarker) state.map.removeLayer(state.pickMarker);
  state.pickMarker = L.circleMarker([lat, lng], { radius: 7, color: '#cbff3c', weight: 2, fillColor: '#07080a', fillOpacity: 1 }).addTo(state.map);
  try {
    const out = await api(`/api/geo/reverse?lat=${lat}&lon=${lng}`);
    state.picked = { lat, lon: lng, place: out.place, note: out.note, loading: false };
  } catch (e) {
    state.picked = { lat, lon: lng, place: null, error: e.message, loading: false };
  }
  renderPick();
  if (state.picked.place) state.pickMarker.bindPopup(`<b>${esc(state.picked.place.displayName)}</b><div class="dim mono">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>`).openPopup();
}

function renderPick() {
  const el = $('#osm-pick');
  if (!el) return;
  const p = state.picked;
  if (!p) { el.hidden = true; return; }
  el.hidden = false;
  const addr = p.place?.address ? Object.entries(p.place.address).slice(0, 4).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ') : '';
  const canTag = Boolean(state.fieldId);
  el.innerHTML = `<div><b>${esc(p.loading ? 'Resolving place name…' : p.place?.displayName || p.error || 'Unmapped in OpenStreetMap')}</b>`
    + `<div class="dim mono">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</div>`
    + (addr ? `<div class="note">${addr}</div>` : '')
    + (!p.loading && !p.place && p.note ? `<div class="note">${esc(p.note)}</div>` : '') + `</div>`
    + `<div class="row">`
    + (canTag ? `<button class="btn sm primary" id="osm-set-location">Set as ${esc(state.fieldId)} location</button>` : `<span class="chip">select a field to set its location</span>`)
    + `<button class="btn sm" id="osm-clear-pick">clear</button></div>`;
  $('#osm-clear-pick').addEventListener('click', () => {
    state.picked = null;
    if (state.pickMarker) { state.map.removeLayer(state.pickMarker); state.pickMarker = null; }
    renderPick();
  });
  const tag = $('#osm-set-location');
  if (tag) tag.addEventListener('click', async () => {
    tag.disabled = true;
    try {
      const r = await api(`/api/fields/${encodeURIComponent(state.fieldId)}/geotag`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: state.picked.lat, lon: state.picked.lon }),
      });
      toast(`${r.field.fieldId} located at ${state.picked.lat.toFixed(5)}, ${state.picked.lon.toFixed(5)} - re-analyze to re-project its grid`);
      await refreshFields();
      await updateMap();
      if (state.osmLayerOn) drawOsmFeatures();
    } catch (e) { toast(e.message, true); tag.disabled = false; }
  });
}

/** Nominatim search: an explicit submit, never per-keystroke (the policy forbids it). */
async function runOsmSearch() {
  const input = $('#osm-q');
  const box = $('#osm-results');
  const q = input.value.trim();
  if (q.length < 3) { box.innerHTML = '<div class="note">Enter at least 3 characters — a place, address or postcode.</div>'; box.hidden = false; return; }
  box.hidden = false;
  box.innerHTML = '<div class="note">Searching OpenStreetMap…</div>';
  try {
    const out = await api(`/api/geo/search?q=${encodeURIComponent(q)}&limit=6`);
    box.innerHTML = out.results.length
      ? out.results.map((r, i) => `<button class="osm-hit" data-hit="${i}"><b>${esc(r.name || r.displayName.split(',')[0])}</b><u>${esc(r.displayName)}</u><i>${r.lat.toFixed(5)}, ${r.lon.toFixed(5)} · ${esc(r.category || '')}/${esc(r.type || '')}</i></button>`).join('')
      : `<div class="note">OpenStreetMap has no match for “${esc(q)}”.</div>`;
    box.querySelectorAll('button[data-hit]').forEach((b) => b.addEventListener('click', () => {
      const r = out.results[+b.dataset.hit];
      state.map.flyTo([r.lat, r.lon], 15, { duration: 0.8 });
      if (r.bounds) state.map.fitBounds([[r.bounds[1], r.bounds[0]], [r.bounds[3], r.bounds[2]]], { padding: [40, 40] });
      handleMapPick({ lat: r.lat, lng: r.lon });
      box.hidden = true;
    }));
  } catch (e) {
    box.innerHTML = `<div class="note">Search failed: ${esc(e.message)}</div>`;
  }
}

/* ═══════════════════════════ GEO MAP LAYERS ═════════════════════════════════
 * One definition per drawable layer. `get` pulls the value off a tile, `probe`
 * marks layers that only exist where a physical instrument is installed.
 * ══════════════════════════════════════════════════════════════════════════ */
const RAMP = {
  green:  ['#1d2a1f', '#3c6b31', '#7bab36', '#c8dc55'],
  cover:  ['#241c14', '#4d3a24', '#8a6a38', '#d9c06a'],
  health: ['#3a2220', '#8a4a2a', '#d9a12a', '#5fbf6a'],
  weed:   ['#1a241c', '#5c7a2a', '#c2c62a', '#e05a2a'],
  soil:   ['#241a14', '#5b4331', '#8d6b4f', '#c8a67a'],
  moist:  ['#3a2a12', '#8a6a1e', '#3f8fb5', '#1c5fa8'],
  ph:     ['#b03a2e', '#e07b39', '#e8c547', '#63b34a', '#2f7fb5'],
  ec:     ['#e4efe6', '#a8c8a0', '#5f9e6a', '#c9a13a', '#a8402e'],
  temp:   ['#2b6cb0', '#6aa9d8', '#e8e6dc', '#e0a15a', '#c0392b'],
  tex:    ['#14181a', '#2e3a40', '#5f737d', '#9fb3bc'],
};
const _hx = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
/** Sample a colour ramp. Returns null for a missing value so the map can grey it. */
function rampColor(stops, v, lo, hi) {
  if (v == null || !Number.isFinite(+v)) return null;
  const t = Math.max(0, Math.min(1, (v - lo) / ((hi - lo) || 1)));
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = _hx(stops[i]), b = _hx(stops[i + 1]);
  return `rgb(${a.map((c, j) => Math.round(c + (b[j] - c) * f)).join(',')})`;
}
const rampCss = (stops) => `linear-gradient(90deg,${stops.join(',')})`;

const GEO_LAYERS = [
  { key: 'class',    label: 'Classification',    kind: 'class' },
  { key: 'vigor',    label: 'Vegetation vigor', get: (t) => t.vigor,     ramp: RAMP.green, lo: 0,  hi: 1,  fmt: (v) => `${(v * 100).toFixed(0)}%` },
  { key: 'cover',    label: 'Canopy cover',     get: (t) => t.cover,     ramp: RAMP.cover, lo: 0,  hi: 1,  fmt: (v) => `${(v * 100).toFixed(0)}%` },
  { key: 'health',   label: 'Plant health',     get: (t) => t.health,    ramp: RAMP.health, lo: 0, hi: 100, fmt: (v) => v.toFixed(0) },
  { key: 'weed',     label: 'Weed pressure',    get: (t) => t.weed,      ramp: RAMP.weed,   lo: 0, hi: 100, fmt: (v) => v.toFixed(0) },
  { key: 'soil',     label: 'Soil condition',   get: (t) => t.soil,      ramp: RAMP.soil,   lo: 0, hi: 100, fmt: (v) => v.toFixed(0) },
  { key: 'moisture', label: 'Soil moisture',    get: (t) => t.moisture,  ramp: RAMP.moist,  lo: 0, hi: 100, fmt: (v) => `${v.toFixed(1)}%`, probe: true },
  { key: 'ph',       label: 'Soil pH',          get: (t) => t.ph,        ramp: RAMP.ph,     lo: 3, hi: 9,   fmt: (v) => v.toFixed(2), probe: true },
  { key: 'ec',       label: 'Soil EC',          get: (t) => t.ec,        ramp: RAMP.ec,     lo: 0, hi: 4,   fmt: (v) => v.toFixed(2), probe: true },
  { key: 'soilTemp', label: 'Soil temperature', get: (t) => t.soilTempC, ramp: RAMP.temp,   lo: -5, hi: 45, fmt: (v) => `${v.toFixed(1)} °C`, probe: true },
  { key: 'texture',  label: 'Soil texture',     get: (t) => t.texture,   ramp: RAMP.tex,    lo: 0,  hi: 1,  fmt: (v) => (v * 100).toFixed(0) },
];
const activeLayer = () => GEO_LAYERS.find((l) => l.key === state.geoLayer) || GEO_LAYERS[0];

function renderLayerBar() {
  const bar = $('#geo-layers');
  if (!bar) return;
  bar.innerHTML = GEO_LAYERS.map((l) => {
    const dot = l.kind === 'class' ? rampCss(RAMP.green) : l.ramp[l.ramp.length - 1];
    const title = l.label + (l.probe ? ' - measured by an installed probe' : '');
    return `<button class="layer-chip${l.key === state.geoLayer ? ' on' : ''}" data-layer="${l.key}" title="${esc(title)}"><i class="dot" style="background:${dot}"></i>${esc(l.label)}</button>`;
  }).join('');
  bar.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    state.geoLayer = b.dataset.layer;
    renderLayerBar();
    updateMap();
  }));
}

/** Half-extent of a metre size expressed in degrees, at a given latitude. */
function degSpan(metres, lat) {
  return [metres / 2 / 111320, metres / 2 / (111320 * Math.cos((lat * Math.PI) / 180))];
}

/** Everything the map can say about one tile, in the popup. */
function tilePopup(t, geo) {
  const rows = [];
  const push = (k, v) => { if (v != null && v !== '') rows.push(`<i>${esc(k)}</i><span>${esc(v)}</span>`); };
  push('class', t.class ? (CLASSES[t.class] || {}).label || t.class : 'unclassified');
  push('confidence', t.confidence ? `${(t.confidence * 100).toFixed(0)}%` : null);
  push('vigor', t.vigor != null ? `${(t.vigor * 100).toFixed(0)} / 100` : null);
  push('canopy cover', t.cover != null ? `${(t.cover * 100).toFixed(0)}%` : null);
  push('plant health', t.health != null ? `${t.health} / 100` : null);
  push('weed pressure', t.weed != null ? `${t.weed} / 100` : null);
  push('soil condition', t.soil != null ? `${t.soil} / 100` : null);
  if (t.deviceId) {
    push('moisture', t.moisture != null ? `${t.moisture}% VWC` : null);
    push('pH', t.ph != null ? t.ph.toFixed(2) : null);
    push('EC', t.ec != null ? `${t.ec} mS/cm` : null);
    push('soil temp', t.soilTempC != null ? `${t.soilTempC} °C` : null);
  }
  return `<b>Tile ${t.r},${t.c}</b><div class="pp-rows">${rows.join('')}</div>`
    + `<div class="pp-actions"><button class="btn sm" data-identify="${esc(geo.fieldId)}:${t.r}:${t.c}">Identify here</button><div class="pp-ident-out"></div></div>`
    + `<div class="pp-src"><span class="id">${esc(geo.fieldId)}</span> · ${esc(geo.classifiedBy || 'unclassified')}`
    + `${t.manual ? ' · manual' : ''}${t.deviceId ? ` · probe <span class="id">${esc(t.deviceId)}</span>` : ''}</div>`;
}

/* Species identification from a map tile — delegated because popups are
 * rebuilt every time they open. The result lands inside the popup and in the
 * stored history; SSE carries the toast to every other client. */
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-identify]');
  if (!btn) return;
  const [fieldId, r, c] = btn.dataset.identify.split(':');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Identifying… (local model, up to a minute)';
  try {
    const rr = await api('/api/ai/identify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId, r: +r, c: +c }),
    });
    const out = btn.parentElement.querySelector('.pp-ident-out');
    if (out) out.innerHTML = identifyResultHTML(rr.result, { model: rr.model, latencyMs: rr.latencyMs, source: `tile ${r},${c}` });
    btn.remove();
    loadIdentifyHistory();
  } catch (e) {
    const out = btn.parentElement.querySelector('.pp-ident-out');
    if (out) out.innerHTML = `<div class="idr-error">${esc(e.message)}</div>`;
    btn.remove();
    toast(e.message, true);
    loadIdentifyHistory();
  }
});

/** Which field the Geo map, Windy panel and OSM layer are centred on. With a
 *  device fix the device wins until the operator picks a field, so a field
 *  in another country never hides the place the console is standing in. */
function geoFocusFieldId() {
  if (state.location && !state.geoFieldPicked) return null;
  return $('#geo-field').value || state.fieldId || null;
}

async function updateMap() {
  if (!state.map) return;
  const layer = activeLayer();
  const showTiles = $('#chk-tiles').checked;
  const showDevices = $('#chk-devices').checked;
  const showWeather = $('#chk-weather').checked;
  const geoFields = state.fields.filter((f) => f.gps && f.gps.lat != null);

  // Guard against out-of-order async responses: only the newest draw is allowed
  // to touch the map, otherwise a slow layer fetch repaints over a fast one.
  const gen = (state.mapGen = (state.mapGen || 0) + 1);
  state.mapLayers.clearLayers();
  if (!geoFields.length) {
    // No imagery is registered, but the console may still know exactly where it
    // is - so it frames the device's real position instead of the whole world.
    drawMyLocation(state.mapLayers);
    if (state.location) state.map.setView([state.location.lat, state.location.lon], 16);
    else state.map.setView([20, 0], 2);
    $('#map-note').textContent = state.location
      ? 'No field imagery registered yet - the map is centred on this device\'s own fix. Upload an image with EXIF GPS, or set coordinates in Analysis, for footprints, layers and sensor markers.'
      : 'No georeferenced fields yet. Upload an image with EXIF GPS, or set coordinates in Analysis - footprints, layers and sensor markers appear here.';
    return;
  }

  const bounds = [];
  const focused = geoFocusFieldId();
  const overlay = L.layerGroup().addTo(state.mapLayers);
  // Keep the Windy panel in step with the field the Leaflet map is focused on.
  loadWindy(focused).catch(() => {});

  for (const f of geoFields) {
    const wM = f.groundWidthM || 60;
    const hM = wM * ((f.height || 1) / (f.width || 1));
    const [dLat, dLon] = degSpan(wM, f.gps.lat);
    const hLat = hM / 2 / 111320;
    const ring = [[f.gps.lat + hLat, f.gps.lon - dLon], [f.gps.lat + hLat, f.gps.lon + dLon],
                  [f.gps.lat - hLat, f.gps.lon + dLon], [f.gps.lat - hLat, f.gps.lon - dLon]];
    const isFocus = f.fieldId === focused;
    L.polygon(ring, { color: isFocus ? UI.acid : UI.dim, weight: isFocus ? 2 : 1, fill: false, dashArray: isFocus ? '7 4' : '3 4' })
      .bindPopup(`<b>${esc(f.fieldId)}</b><div class="pp-rows"><i>status</i><span>${esc(f.status)}</span><i>grid</i><span>${f.grid.rows}x${f.grid.cols}</span><i>georef</i><span>${esc(f.gps.source)}</span></div>`)
      .addTo(overlay);
    bounds.push([f.gps.lat, f.gps.lon]);

    // Layer and overlay switches are pure client-side repaints, so reuse the
    // payload we already hold. The entry is dropped by selectField and by the
    // device-*/analysis SSE events, so a cache hit is never stale about sensor
    // readings - and this keeps layer hopping from refetching every field.
    const held = state.geoCache[f.fieldId];
    (held ? Promise.resolve(held) : api(`/api/fields/${f.fieldId}/layers`)).then((geo) => {
      if (gen !== state.mapGen || !state.map || !state.mapLayers) return;
      state.geoCache[f.fieldId] = geo;
      const grp = L.layerGroup().addTo(state.mapLayers);
      const [hT, hO] = degSpan(geo.geometry.tileH || 3, geo.gps.lat);

      if (showTiles) {
        for (const t of geo.tiles) {
          if (t.lat == null) continue;
          const col = layer.kind === 'class'
            ? (t.class ? CLASSES[t.class].hex : '#333')
            : (rampColor(layer.ramp, layer.get(t), layer.lo, layer.hi) || '#2b312e');
          L.rectangle([[t.lat - hT, t.lon - hO], [t.lat + hT, t.lon + hO]],
            { color: col, weight: 0.4, fillColor: col, fillOpacity: layer.kind === 'class' ? 0.5 : 0.72 })
            .bindPopup(tilePopup(t, geo)).addTo(grp);
        }
      }

      if (showWeather && geo.site && geo.site.wind && geo.site.wind.dirDeg != null) {
        const w = geo.site.wind;
        const dLatW = (geo.geometry.heightM || 60) * 0.6 / 111320;
        const dLonW = (geo.geometry.widthM || 60) * 0.6 / (111320 * Math.cos((geo.gps.lat * Math.PI) / 180));
        const rad = (w.dirDeg * Math.PI) / 180;
        L.polyline([[geo.gps.lat - dLatW * Math.cos(rad), geo.gps.lon - dLonW * Math.sin(rad)],
                    [geo.gps.lat + dLatW * Math.cos(rad), geo.gps.lon + dLonW * Math.sin(rad)]],
          { color: UI.acid, weight: 3, opacity: 0.85, dashArray: '10 7' })
          .bindPopup(`<b>Wind ${w.kmh} km/h</b><div class="pp-rows"><i>from</i><span>${esc(w.compass || '-')} ${w.dirDeg}&deg;</span><i>gusts</i><span>${w.gustKmh == null ? '-' : w.gustKmh + ' km/h'}</span></div>`)
          .addTo(grp);
      }

      if (showDevices) {
        for (const d of geo.devices) {
          if (d.lat == null || d.lon == null) continue;
          L.marker([d.lat, d.lon], {
            icon: L.divIcon({ className: '', html: `<div class="dev-marker ${d.status}"><i></i></div>`, iconSize: [13, 13], iconAnchor: [6, 6] }),
          }).bindPopup(`<b>${esc(d.name)}</b><div class="pp-rows"><i>type</i><span>${esc(d.typeLabel)}</span><i>${esc(d.primaryKey || 'reading')}</i><span>${d.value == null ? '-' : d.value + ' ' + esc(d.primaryUnit)}</span><i>status</i><span>${esc(d.status)}</span><i>last seen</i><span>${d.lastSeen ? esc(d.lastSeen.slice(11, 19)) : '-'}</span><i>readings</i><span>${d.count}</span></div><div class="pp-src">${esc(d.deviceId)} · tile ${d.r},${d.c}</div>`)
            .addTo(grp);
        }
      }

      if (f.fieldId === focused) {
        state.geo = geo;
        renderGeoSide(geo);
        $('#geo-gps-chip').textContent = geo.gps?.lat != null && geo.gps?.lon != null
          ? `${geo.gps.lat.toFixed(5)}, ${geo.gps.lon.toFixed(5)} · ${geo.gps.source}`
          : 'no GPS — geotag this field';
      }
    }).catch(() => {});
  }

  drawMyLocation(overlay);

  $('#map-note').textContent = `${geoFields.length} georeferenced site(s) · drawing ${activeLayer().label}`
    + `${showTiles ? ' per tile' : ''} · sensor markers ${showDevices ? 'on' : 'off'} · click any tile for its full agronomy readout.`;
  renderLegend(activeLayer());
  // With a device fix and no field chosen by the operator, the map frames the
  // device - the field footprints stay drawn, and picking a field frames it.
  if (!focused && state.location) state.map.setView([state.location.lat, state.location.lon], 12);
  else if (bounds.length === 1) state.map.setView(bounds[0], 18);
  else state.map.fitBounds(bounds, { padding: [50, 50] });
  if (state.osmLayerOn) drawOsmFeatures().catch(() => {});
}

/** The device's own fix on the map. The fix comes from the server, so this
 *  marker is the same point in every tab - not browser-local memory. */
function drawMyLocation(group) {
  const loc = state.location;
  if (!loc || !group) return;
  L.marker([loc.lat, loc.lon], {
    icon: L.divIcon({ className: '', html: '<div class="me-marker"><i></i></div>', iconSize: [15, 15], iconAnchor: [7, 7] }),
    zIndexOffset: 1000,
  }).bindPopup(`<b>My location</b><div class="pp-rows"><i>accuracy</i><span>±${loc.accuracyM == null ? '?' : Math.round(loc.accuracyM)} m</span><i>age</i><span>${esc(agoText(loc.ageSeconds))}</span>${loc.place?.name ? `<i>place</i><span>${esc(loc.place.name)}</span>` : ''}<i>source</i><span>${esc(loc.source)}</span></div>`).addTo(group);
}

function renderLegend(layer) {
  let el = document.querySelector('#map .legend');
  if (!el) { el = document.createElement('div'); el.className = 'legend'; $('#map').appendChild(el); }
  if (layer.kind === 'class') {
    el.innerHTML = '<b>Classification</b>'
      + CLASS_KEYS.map((k) => `<div><span class="sw" style="background:${CLASSES[k].hex}"></span>${esc(CLASSES[k].label)}</div>`).join('');
    return;
  }
  el.innerHTML = `<b>${esc(layer.label)}</b><div class="ramp" style="background:${rampCss(layer.ramp)}"></div>`
    + `<div class="ends"><span>${esc(layer.fmt(layer.lo))}</span><span>${esc(layer.fmt(layer.hi))}</span></div>`
    + `<div style="margin-top:7px"><span class="sw" style="background:var(--line-strong)"></span>${layer.probe ? 'no probe here' : 'no data'}</div>`;
}

/* ---- side panel: live conditions, soil quality, site sensors ---------------- */
const wxCell = (label, val, unit) =>
  `<div class="wx-cell${val == null ? ' na' : ''}"><u>${esc(label)}</u><b>${val == null ? '-' : esc(val)}${unit ? `<small>${esc(unit)}</small>` : ''}</b></div>`;

const BEAUFORT = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102];
function beaufort(kmh) {
  let i = 0; while (i < BEAUFORT.length && kmh >= BEAUFORT[i]) i++;
  return i;
}

/** Compass rose with a downwind arrow. dirDeg is the direction wind comes FROM. */
function windRose(w) {
  const R = 38, C = 48;
  const spd = w ? w.kmh : null;
  const rad = w && w.dirDeg != null ? ((w.dirDeg + 180) * Math.PI) / 180 : 0;
  const ax = C + Math.sin(rad) * (R - 4), ay = C - Math.cos(rad) * (R - 4);
  const bx = C + Math.sin(rad) * (R - 15), by = C - Math.cos(rad) * (R - 15);
  const ticks = [0, 90, 180, 270].map((d) => {
    const a = (d * Math.PI) / 180;
    return `<line x1="${(C + Math.sin(a) * (R - 5)).toFixed(1)}" y1="${(C - Math.cos(a) * (R - 5)).toFixed(1)}" x2="${(C + Math.sin(a) * R).toFixed(1)}" y2="${(C - Math.cos(a) * R).toFixed(1)}" stroke="rgba(255,255,255,.22)" stroke-width="1"/>`;
  }).join('');
  return `<div class="wind-row">`
    + `<div class="wind-dial"><svg viewBox="0 0 96 96" width="96" height="96">`
    + `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="1"/>`
    + `<circle cx="${C}" cy="${C}" r="${R - 12}" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="1"/>`
    + ticks
    + `<text x="${C}" y="9" text-anchor="middle" font-size="8" fill="${UI.dim}">N</text>`
    + `<text x="91" y="${C + 3}" text-anchor="middle" font-size="8" fill="${UI.dim}">E</text>`
    + (spd == null ? '' :
        `<line x1="${C}" y1="${C}" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}" stroke="${UI.acid}" stroke-width="3" stroke-linecap="round"/>`
        + `<polygon points="${ax.toFixed(1)},${ay.toFixed(1)} ${(bx - Math.cos(rad) * 4).toFixed(1)},${(by - Math.sin(rad) * 4).toFixed(1)} ${(bx + Math.cos(rad) * 4).toFixed(1)},${(by + Math.sin(rad) * 4).toFixed(1)}" fill="${UI.acid}"/>`)
    + `</svg><div class="rose-txt"><b>${spd == null ? '-' : spd.toFixed(1)}</b><u>km/h</u></div></div>`
    + `<div class="wind-facts">`
    + kv('from', w ? `${esc(w.compass || '-')} · ${w.dirDeg}°` : '—')
    + kv('gusts', w && w.gustKmh != null ? `${w.gustKmh} km/h` : '—')
    + kv('beaufort', spd == null ? '—' : String(beaufort(spd)))
    + kv('spraying', spd == null ? '—' : spd >= 39 ? 'window closed' : spd >= 20 ? 'caution' : 'good')
    + `</div></div>`;
}

/** Inline trend line for a device's primary metric. */
function sparkline(values, w = 300, h = 24) {
  if (!values || values.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
  const min = Math.min.apply(null, values), max = Math.max.apply(null, values), span = (max - min) || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 2) + 1, h - 2 - ((v - min) / span) * (h - 5)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const col = values[values.length - 1] >= values[0] ? '#4CAF50' : '#FFC107';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`
    + `<path d="${d} L ${(w - 1).toFixed(1)} ${h} L 1 ${h} Z" fill="${col}" opacity=".13"/>`
    + `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
    + `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2" fill="${col}"/></svg>`;
}

const DEV_ICO = {
  'soil-probe': '<path d="M12 2a2 2 0 00-2 2v6a6 6 0 106 6V8h3a1 1 0 100-2h-3V4a2 2 0 00-2-2z" fill="currentColor"/>',
  'weather-station': '<path d="M6.8 6.5c0 .8.6 1.5 1.5 1.5h.4L6 21h2.1l1.4-6h4.9l1.4 6H18l-2.7-13h.4c.8 0 1.5-.7 1.5-1.5V3H6.8zM12 13a2 2 0 100 4 2 2 0 000-4z" fill="currentColor"/>',
  'anemometer': '<path d="M12 12l6-6M12 12l-5.2 4M12 12v8M4 4l3.2 2M14 2.6L13 5.6M20.6 15.8l-3-1.2M12 20a1.4 1.4 0 100-2.8A1.4 1.4 0 0012 20z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/>',
  'rain-gauge': '<path d="M12 2.7S6 10 6 14.5A6 6 0 0018 14.5C18 10 12 2.7 12 2.7z" fill="currentColor"/>',
  'soil-temp': '<path d="M12 2a2 2 0 00-2 2v9.6a4.5 4.5 0 104 0V4a2 2 0 00-2-2zm0 2v11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  'ph-ec': '<path d="M4 4h16v16H4z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 16l3.2-4.6 2.6 2.4L16 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  'light': '<path d="M12 7a5 5 0 100 10 5 5 0 000-10zm0-5v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10l2.1 2.1M19.1 4.9l-2.1 2.1m-10 10l-2.1 2.1" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  'camera': '<path d="M9 3l-1.8 2H4a2 2 0 00-2 2v11a2 2 0 002 2h16a2 2 0 002-2V7a2 2 0 00-2-2h-3.2L15 3zm3 5.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9z" fill="currentColor"/>',
  'generic': '<path d="M12 2a10 10 0 1010 10A10 10 0 0012 2zm1 15h-2v-2h2zm0-4h-2V7h2z" fill="currentColor"/>',
};
const devIco = (t) => `<svg viewBox="0 0 24 24" width="15" height="15">${DEV_ICO[t] || DEV_ICO.generic}</svg>`;

function miniRow(label, value, pct, color) {
  const w = Math.max(0, Math.min(100, pct || 0));
  return `<div class="mini-row"><label>${esc(label)}</label>`
    + `<div class="bar"><div class="fill" style="width:${w}%;background:${color}"></div></div>`
    + `<b>${esc(String(value))}</b></div>`;
}
const gradeColor = (v) => (v == null ? 'var(--dim)' : v >= 70 ? 'var(--leaf)' : v >= 45 ? 'var(--amber)' : 'var(--danger)');

function renderGeoSide(geo) {
  const site = geo.site || {};
  const wx = site.weather, cl = site.climate || {};

  if (wx) {
    $('#geo-wx').innerHTML = '<div class="wx-grid">'
      + wxCell('air temp', wx.airTempC, '°C') + wxCell('feels like', wx.feelsLikeC, '°C')
      + wxCell('humidity', wx.humidityPct, '%') + wxCell('cloud cover', wx.cloudPct, '%')
      + wxCell('precipitation', wx.precipitationMm, 'mm') + wxCell('rain today', cl.rainTodayMm, 'mm')
      + wxCell('ET0', cl.et0MmDay, 'mm/d') + wxCell('pressure', cl.pressureHpa, 'hPa')
      + wxCell('soil moist 9cm', cl.soilMoisturePct, '%') + wxCell('surface moist', cl.soilMoistureSurfacePct, '%')
      + '</div>' + windRose(site.wind)
      + `<p class="note">Open-Meteo · ${esc(wx.timezone || '')} · observed ${esc(wx.observedAt || '-')}</p>`;
  } else {
    $('#geo-wx').innerHTML = '<span class="dim">No georeference - set coordinates in Analysis to pull live weather for this site.</span>';
  }

  const sq = site.soilQuality || {};
  const ph = site.plantHealth || {};
  const wd = site.weed || {};
  const g = geo.geometry || {};
  const irr = site.irrigation;
  $('#geo-soil').innerHTML = '<div class="mini-rows">'
    + miniRow('soil quality', sq.score == null ? '-' : sq.score.toFixed(1), sq.score, gradeColor(sq.score))
    + miniRow('plant health', ph.score == null ? '-' : ph.score.toFixed(0), ph.score, gradeColor(ph.score))
    + miniRow('weed pressure', wd.pct == null ? '-' : wd.pct.toFixed(1), wd.pct, 'var(--weed)')
    + miniRow('canopy cover', ph.canopyCoverPct == null ? '-' : ph.canopyCoverPct.toFixed(1), ph.canopyCoverPct, 'var(--mint)')
    + '</div>'
    + `<div class="klist">`
    + kv('soil grade', sq.grade || '—')
    + kv('health grade', ph.grade || '—')
    + kv('weed level', wd.level || '—')
    + kv('field area', g.fieldAreaHa != null ? `${g.fieldAreaHa} ha / ${g.fieldAreaAcres} ac` : '—')
    + kv('tile', g.cols ? `${g.cols}x${g.rows} of ${g.tileW}m x ${g.tileH}m` : '—')
    + `</div>`
    + (sq.inputs && sq.inputs.length
        ? `<div class="divider"></div><p class="eyebrow" style="margin:0 0 6px">Measured soil inputs</p><div class="klist">`
          + sq.inputs.slice(0, 8).map((i) => `<div class="kv"><b>${esc(i.label || i.key)}</b><span>${esc(i.value == null ? '-' : i.value)} ${esc(i.unit || '')} <em class="dim">${esc(i.source || '')}</em></span></div>`).join('')
          + '</div>'
        : '')
    + (irr
        ? `<div class="divider"></div><p class="eyebrow" style="margin:0 0 6px">Irrigation advisory</p>`
          + `<div class="klist">`
          + kv('recommendation', esc(irr.recommendation || (irr.insufficient ? 'insufficient data' : '—')))
          + kv('urgency', irr.urgency || '—')
          + (irr.litersPerAcre != null ? kv('litres / acre', irr.litersPerAcre) : '')
          + (irr.inputs?.soilMoistureSource ? kv('moisture from', irr.inputs.soilMoistureSource) : '')
          + `</div>`
          + (irr.reasons ? `<ul class="reason-list">${irr.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '')
          + (irr.insufficient && irr.reason ? `<div class="alert info">${esc(irr.reason)}</div>` : '')
        : '');

  const devs = geo.devices || [];
  $('#geo-dev-count').textContent = `${devs.length} deployed`;
  $('#geo-devices').innerHTML = devs.length
    ? devs.map((d) => `<div class="dev-card">`
        + `<div class="dev-ico">${devIco(d.type)}</div>`
        + `<div class="dev-name"><b>${esc(d.name)}</b><u>${esc(d.typeLabel)}</u><code>${esc(d.deviceId)}</code></div>`
        + `<div class="dev-read${d.value == null ? ' na' : ''}"><b>${d.value == null ? '-' : d.value}</b><u>${esc(d.primaryUnit)}</u></div>`
        + sparkline(d.series)
        + `<div class="dev-facts"><i><span class="st-pill ${d.status}">${esc(d.status)}</span></i>`
        + `<i><em>last</em>${d.lastSeen ? esc(d.lastSeen.slice(11, 19)) : '-'}</i>`
        + `<i><em>n</em>${d.count}</i><i><em>tile</em>${d.r},${d.c}</i></div>`
      + `</div>`).join('')
    : '<span class="dim">No sensors registered on this site. Add them in the Sensors tab - each one gets its own id, token and history.</span>';
}

/* ═══════════════════════ MY LOCATION — the device's own fix ═════════════════
 * Everything the console says about "here" comes from the device's own fix, and
 * the server stores it, so the same location serves every tab and every console
 * on the network rather than a coordinate somebody typed.
 *
 * What this deliberately will not do:
 *   · substitute a default or sample coordinate. If the browser cannot say where
 *     it is, the card says so and the rest of the console keeps reporting on the
 *     fields it genuinely knows about;
 *   · dress a denied permission up as a temporary glitch. A browser block is a
 *     browser block, and only the user's settings can lift it;
 *   · hide the secure-context rule. navigator.geolocation is simply absent on a
 *     plain-http origin, so a LAN IP over http is told that instead of being
 *     offered a button that quietly fails.
 * ═══════════════════════════════════════════════════════════════════════════ */
const GEO_NO_API = 'This browser exposes no location API (navigator.geolocation is missing).';
const GEO_INSECURE = 'Location is blocked outside a secure context: browsers only expose the device fix over HTTPS or on localhost. Serve this console over TLS (or open it at http://localhost:5177) and the button works.';

state.location = null;        // the server's stored fix
state.locLive = null;         // the last live bundle for that fix
state.locWatch = null;        // watchPosition id while following
state.locBusy = false;
state.locLastPostAt = 0;
state.locLastPostLatLon = null;

const LOC_COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compassOf = (deg) => (deg == null || !Number.isFinite(+deg)
  ? null : LOC_COMPASS[Math.round((((+deg % 360) + 360) % 360) / 22.5) % 16]);
const agoText = (s) => (s == null ? '—' : s < 45 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`);
const stamp = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '—');

/** Turn a PositionError into something a person can act on. */
function positionErrorMessage(err) {
  const code = err && err.code;
  if (code === 1) return 'Location permission was denied for this site. Allow location in the browser (the padlock in the address bar → Site settings), then try again. Nothing is invented while it stays denied.';
  if (code === 2) return 'The device could not obtain a fix (POSITION_UNAVAILABLE). On a laptop that usually means Wi-Fi positioning is off, or there is no GPS radio in range.';
  if (code === 3) return 'The device did not answer in time (TIMEOUT). Move near a window or outdoors and retry.';
  return `Location failed: ${(err && err.message) || 'unknown error'}`;
}

/** One high-accuracy reading from the device, or a truthful failure. */
function requestFix() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) return reject(new Error(GEO_INSECURE));
    if (!navigator.geolocation) return reject(new Error(GEO_NO_API));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        accuracyM: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null,
        altitudeM: Number.isFinite(p.coords.altitude) ? p.coords.altitude : null,
        capturedAt: new Date(p.timestamp || Date.now()).toISOString(),
      }),
      (err) => reject(new Error(positionErrorMessage(err))),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

function setLocStatus(text, kind = '') {
  const el = $('#loc-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = `loc-status${kind ? ` ${kind}` : ''}`;
  el.hidden = !text;
}

/** The stored fix (or null). A 404 NoLocation is a normal state, not an error. */
async function loadLocation() {
  try {
    state.location = await api('/api/location');
  } catch {
    // 404 NoLocation: this device has not reported a fix yet. A normal state.
    state.location = null;
  }
  state.locLoaded = true;
  if (state.location && state.location.live) state.locLive = state.location.live;
  renderLocation();
  // A fix that is already known loads silently; say what it is rather than
  // leaving a panel that looks like it is still thinking.
  if (state.location && !state.locLive) {
    setLocStatus(`Stored fix loaded — ±${state.location.accuracyM == null ? '?' : Math.round(state.location.accuracyM)} m, ${agoText(state.location.ageSeconds)}. Press Refresh live data to pull live weather, satellite passes and terrain for it.`);
  }
  return state.location;
}

/** Send the device's fix to the server, so everyone reads the same location. */
async function storeFix(fix) {
  const r = await api('/api/location', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fix),
  });
  state.location = r.location;
  state.locLastPostAt = Date.now();
  state.locLastPostLatLon = { lat: r.location.lat, lon: r.location.lon };
  renderLocation();
  return r;
}

async function useMyLocation() {
  if (state.locBusy) return;
  state.locBusy = true;
  state.geoFieldPicked = false;   // asking for the device re-centres the map on it
  const buttons = ['#btn-loc-use', '#btn-locate'].map((s) => $(s)).filter(Boolean);
  buttons.forEach((b) => { b.disabled = true; });
  setLocStatus('Asking the device for a fix…', 'busy');
  try {
    const fix = await requestFix();
    await storeFix(fix);
    if (state.map) {
      state.map.setView([fix.lat, fix.lon], Math.max(state.map.getZoom(), 16));
      updateMap();
    }
    toast(`Located ±${Math.round(fix.accuracyM ?? 0)} m — fetching live data for your coordinates`);
    await refreshLive();
  } catch (e) {
    setLocStatus(e.message, 'err');
    toast(e.message, true);
  } finally {
    state.locBusy = false;
    buttons.forEach((b) => { b.disabled = false; });
  }
}

/** Every real provider, for the stored fix, in one server round-trip. */
async function refreshLive({ quiet = false } = {}) {
  if (!state.location) {
    if (!quiet) toast('No device location stored yet', true);
    return;
  }
  const btn = $('#btn-loc-refresh');
  if (btn) btn.disabled = true;
  if (!quiet) setLocStatus('Fetching live weather, archived rainfall, satellite passes, terrain and map context for your coordinates…', 'busy');
  try {
    state.locLive = await api('/api/location/live');
    const { partsOk, partsTotal, errors } = state.locLive;
    setLocStatus(errors?.length
      ? `${partsOk}/${partsTotal} providers answered for your location — ${errors.length} did not.`
      : `${partsOk}/${partsTotal} providers answered at ${stamp(state.locLive.fetchedAt)} — all live, none simulated.`,
    errors?.length ? 'warn' : 'ok');
  } catch (e) {
    setLocStatus(`Live data failed: ${e.message}`, 'err');
  }
  if (btn) btn.disabled = false;
  renderLocation();
}

/**
 * Follow mode: a real-time stream from the device.
 * Position updates arrive about once a second; the server is told only when the
 * fix has actually moved or a little time has passed, so following does not
 * become a heartbeat of writes and provider calls.
 */
function startFollow() {
  if (state.locWatch != null) return;
  if (!window.isSecureContext) { setLocStatus(GEO_INSECURE, 'err'); return; }
  if (!navigator.geolocation) { setLocStatus(GEO_NO_API, 'err'); return; }
  state.locWatch = navigator.geolocation.watchPosition(async (p) => {
    const fix = {
      lat: p.coords.latitude,
      lon: p.coords.longitude,
      accuracyM: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null,
      altitudeM: Number.isFinite(p.coords.altitude) ? p.coords.altitude : null,
      capturedAt: new Date(p.timestamp || Date.now()).toISOString(),
    };
    const prev = state.locLastPostLatLon;
    const movedM = prev
      ? Math.hypot((fix.lat - prev.lat) * 111320, (fix.lon - prev.lon) * 111320 * Math.cos((fix.lat * Math.PI) / 180))
      : Infinity;
    if (movedM < 3 && Date.now() - state.locLastPostAt < 15000) {
      setLocStatus(`Following · ±${Math.round(fix.accuracyM ?? 0)} m · holding the stored fix (moved ${movedM === Infinity ? '—' : movedM.toFixed(1)} m)`, 'busy');
      return;
    }
    setLocStatus(`Following · ±${Math.round(fix.accuracyM ?? 0)} m · updating…`, 'busy');
    try {
      await storeFix(fix);
      await refreshLive({ quiet: true });
    } catch (e) { setLocStatus(e.message, 'err'); }
  }, (err) => {
    setLocStatus(positionErrorMessage(err), 'err');
    stopFollow();
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 });
  const btn = $('#btn-loc-follow');
  if (btn) { btn.setAttribute('aria-pressed', 'true'); btn.classList.add('on'); btn.textContent = 'Following'; }
}

/** Ask once, unprompted, and only when nothing is known about where we are. */
function autoAskLocation() {
  if (state.locAutoAsked) return;
  state.locAutoAsked = true;
  if (state.location || state.locBusy) return;
  if (!window.isSecureContext) {
    setLocStatus(GEO_INSECURE, 'warn');
    return;
  }
  useMyLocation();
}

function stopFollow() {
  if (state.locWatch != null) {
    try { navigator.geolocation.clearWatch(state.locWatch); } catch {}
  }
  state.locWatch = null;
  const btn = $('#btn-loc-follow');
  if (btn) { btn.setAttribute('aria-pressed', 'false'); btn.classList.remove('on'); btn.textContent = 'Follow'; }
}

/** Everything the console knows about the fix, with each provider named. */
function renderLocation() {
  const chip = $('#loc-chip');
  const body = $('#loc-body');
  const note = $('#loc-note');
  if (!chip || !body) return;
  const loc = state.location;

  if (!loc) {
    chip.textContent = 'no fix';
    chip.className = 'chip';
    body.innerHTML = '<span class="dim">No fix yet. Press <b>Use my device location</b> — the browser asks permission, and the console then pulls live data for your real coordinates.</span>';
    note.textContent = '';
    return;
  }

  chip.textContent = loc.stale ? `stale · ${agoText(loc.ageSeconds)}` : `±${loc.accuracyM == null ? '?' : Math.round(loc.accuracyM)} m`;
  chip.className = `chip ${loc.stale ? 'warn-chip' : 'ok-chip'}`;

  const live = state.locLive || {};
  const w = live.weather || null;
  const arch = live.archive || null;
  const sc = live.scenes || null;
  const tr = live.terrain || null;
  const cx = live.context || null;
  const xc = live.crosscheck || null;
  const place = loc.place || live.place || null;
  const near = loc.nearestField
    ? `${loc.nearestField.kilometres} km from field ${esc(loc.nearestField.fieldId)}`
    : 'no georeferenced field registered yet';

  const sections = [];
  sections.push(`<div class="loc-here">`
    + `<div class="loc-coord"><b>${esc(loc.coordinatesText)}</b><span>±${loc.accuracyM == null ? '?' : Math.round(loc.accuracyM)} m`
    + `${loc.altitudeM == null ? '' : ` · ${Math.round(loc.altitudeM)} m asl`} · ${esc(agoText(loc.ageSeconds))}${loc.stale ? ' · stale' : ''}</span></div>`
    + `<div class="loc-place">${place
      ? `<b>${esc(place.name || place.displayName || 'unnamed place')}</b><u>${esc(place.displayName || '')}</u>`
      : '<b>place name not resolved yet</b><u>press Refresh live data to reverse-geocode this point</u>'}</div>`
    + `<div class="loc-meta"><span class="chip">${near}</span></div>`
    + `</div>`);

  if (w) {
    sections.push('<p class="eyebrow">Right now, here</p><div class="wx-grid">'
      + wxCell('air temp', w.airTempC, '°C') + wxCell('feels like', w.feelsLikeC, '°C')
      + wxCell('humidity', w.humidityPct, '%') + wxCell('cloud cover', w.cloudPct, '%')
      + wxCell('rain now', w.precipitationMm, 'mm') + wxCell('rain today', w.rainTodayMm, 'mm')
      + wxCell('ET0', w.et0MmDay, 'mm/d') + wxCell('pressure', w.pressureHpa, 'hPa')
      + wxCell('soil moist 9cm', w.soilMoisturePct, '%') + wxCell('surface moist', w.soilMoistureSurfacePct, '%')
      + `</div><div class="klist">`
      + kv('wind', `${w.windKmh ?? '—'} km/h ${compassOf(w.windDirDeg) || ''}`.trim())
      + kv('gusts', w.windGustKmh == null ? '—' : `${w.windGustKmh} km/h`)
      + kv('beaufort', w.windKmh == null ? '—' : String(beaufort(w.windKmh)))
      + kv('spraying', w.windKmh == null ? '—' : w.windKmh >= 39 ? 'window closed' : w.windKmh >= 20 ? 'caution' : 'good')
      + `</div><p class="note">Open-Meteo forecast · ${esc(w.timezone || '')} · observed ${esc(String(w.observedAt || '—'))} · fetched ${esc(stamp(w.fetchedAt))}</p>`);
  } else {
    sections.push('<div class="alert info">Live weather did not answer for this point. The coordinates above are still the device\'s own — nothing has been substituted.</div>');
  }

  if (arch) {
    sections.push('<p class="eyebrow">The last 7 days here — reanalysis, not forecast</p><div class="klist">'
      + kv('rain', `${arch.rainMm} mm`)
      + kv('reference ET0', `${arch.et0Mm} mm`)
      + kv('water balance', `${(+(arch.rainMm - arch.et0Mm)).toFixed(1)} mm`)
      + kv('soil moisture', arch.soilMoisturePct == null ? '—' : `${arch.soilMoisturePct}%`)
      + kv('days reported', `${arch.days} of ${arch.window?.days || 7}`)
      + `</div><p class="note">ERA5 / ERA5-Land through the Open-Meteo archive · window ${esc(arch.window?.from || '—')} → ${esc(arch.window?.to || '—')}${(arch.warnings || []).length ? ` · ${esc(arch.warnings[0])}` : ''}</p>`);
  }

  if (sc) {
    const latest = sc.latest;
    sections.push('<p class="eyebrow">Satellite passes over this point</p><div class="klist">'
      + kv('collection', esc(sc.collectionLabel || sc.collection || '—'))
      + kv('scenes', `${sc.count} in ${sc.window?.days || '—'} days`)
      + kv('latest', latest ? `${esc(String(latest.datetime).slice(0, 10))} · ${latest.cloudCover == null ? '—' : `${latest.cloudCover.toFixed(0)}% cloud`}` : '—')
      + kv('clearest', sc.leastCloudy ? `${esc(String(sc.leastCloudy.datetime).slice(0, 10))} · ${sc.leastCloudy.cloudCover == null ? '—' : `${sc.leastCloudy.cloudCover.toFixed(0)}% cloud`}` : '—')
      + `</div><p class="note">Copernicus Sentinel via the Element 84 STAC catalogue — real acquisitions over these exact coordinates.</p>`);
  }

  if (tr) {
    sections.push('<p class="eyebrow">Ground under this point</p><div class="klist">'
      + kv('elevation', `${tr.elevationM} m`)
      + kv('relief', `${tr.reliefM} m`)
      + kv('slope', `${tr.slopePct}% (${tr.slopeDeg}°)`)
      + kv('drainage', esc(tr.drainage || '—'))
      + `</div><p class="note">Copernicus DEM GLO-90 via Open-Meteo elevation.</p>`);
  }

  if (cx) {
    sections.push('<p class="eyebrow">What OpenStreetMap maps around you</p><div class="klist">'
      + kv('features found', `${cx.total}${cx.truncated ? ' (page full)' : ''}`)
      + kv('radius', `${cx.radiusM} m`)
      + Object.entries(cx.byKind || {}).map(([k, n]) => kv(k, n)).join('')
      + `</div>`
      + ((cx.named || []).length
        ? `<div class="loc-tags">${cx.named.slice(0, 8).map((n) => `<span class="chip">${esc(n.label)}</span>`).join('')}</div>`
        : '<span class="dim">No named features inside the radius — OSM is volunteer-mapped, so unmapped is not the same as absent.</span>')
      + `<p class="note">Overpass API · ${esc(cx.attribution || 'OpenStreetMap contributors')} · ${esc(cx.licence || 'ODbL 1.0')}</p>`);
  }

  if (xc) {
    sections.push('<p class="eyebrow">Second opinion on the weather</p><div class="klist">'
      + kv('agreement', esc(xc.agreement || '—'))
      + kv('Δ mean temp', xc.delta?.meanTempC == null ? '—' : `${xc.delta.meanTempC} °C`)
      + kv('Δ rain', xc.delta?.rainSumMm == null ? '—' : `${xc.delta.rainSumMm} mm`)
      + kv('days compared', `${xc.days} (NASA POWER lags real time)`)
      + `</div><p class="note">Open-Meteo against NASA POWER, over the days both report.</p>`);
  }

  if ((live.errors || []).length) {
    sections.push('<p class="eyebrow">Providers that did not answer</p><ul class="reason-list">'
      + live.errors.map((e) => `<li><b>${esc(e.part)}</b> — ${esc(e.error)}</li>`).join('')
      + `</ul>`);
  }

  body.innerHTML = sections.join('<div class="divider"></div>');
  note.textContent = `Fix: navigator.geolocation on this device, validated and stored by the server so every console reads the same location`
    + `${loc.firstSeenAt ? ` · first seen ${stamp(loc.firstSeenAt)}` : ''}`
    + `${live.fetchedAt ? ` · live data ${stamp(live.fetchedAt)}` : ''}.`;
}

/* ══════════════════════════ WINDY FORECAST MAP ═════════════════════════════
 * Windy's own embed, centred on the focused field, for the layers it is good at
 * - wind, gusts, rain, temperature, humidity, cloud and pressure.
 *
 * Windy is the MAP here, never a number. Its API returns forecasts only ("It is
 * not possible to retrieve historical forecasts with past data"), its free key
 * returns randomly shuffled data, and its paid tier has neither radiation nor
 * evapotranspiration nor soil moisture - so every value in this console still
 * comes from the reanalysis archive, which reaches 1940. The credit below is a
 * real link because Windy's embed terms require its logo to stay visible and
 * clickable; it is never hidden or collapsed.
 * ═══════════════════════════════════════════════════════════════════════════ */
state.windyOverlay = state.windyOverlay || 'wind';
state.windyField = null;
state.windyKey = null;

/** The mandatory credit, built from whatever the server returned. */
function windyCredit(d) {
  const site = (d && d.attributionUrl) || 'https://www.windy.com';
  const terms = (d && d.termsUrl) || 'https://account.windy.com/agreements/windy-terms-of-use';
  const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
  return `${esc((d && d.attribution) || 'Weather map by Windy.com')}`
    + ` - ${link(site, 'windy.com')} - ${link(terms, 'embed terms')}`
    + (d && d.licenceNote ? ` - ${esc(d.licenceNote)}` : '');
}

function renderWindyOverlays(overlays, active) {
  const bar = $('#windy-overlays');
  if (!bar) return;
  bar.innerHTML = (overlays || []).map((o) => {
    const on = o.key === active;
    return `<button class="layer-chip${on ? ' on' : ''}" data-windy-overlay="${esc(o.key)}"`
      + `${on ? ' aria-current="true"' : ''} title="${esc(o.label)}${o.unit ? ` in ${esc(o.unit)}` : ''}">${esc(o.label)}</button>`;
  }).join('');
  bar.querySelectorAll('[data-windy-overlay]').forEach((b) => b.addEventListener('click', () => {
    state.windyOverlay = b.dataset.windyOverlay;
    loadWindy(state.windyField, { force: true });
  }));
}

/** Point the Windy frame at one field and one overlay layer. */
async function loadWindy(fieldId, { force = false } = {}) {
  const frame = $('#windy-frame');
  if (!frame) return;
  const empty = $('#windy-empty');
  // No field: the device fix wins over the last-selected field.
  const wanted = fieldId || (state.location ? null : state.fieldId);
  state.windyField = wanted || null;
  const field = state.fields.find((f) => f.fieldId === wanted);

  if (!field || !field.gps || field.gps.lat == null) {
    // No georeferenced field, but the console may still know where the device
    // is: then the map is drawn for the real fix instead of showing nothing.
    if (state.location) {
      const locKey = `device|${state.windyOverlay}`;
      if (force || state.windyKey !== locKey || !frame.getAttribute('src')) {
        try {
          const d = await api(`/api/weather/windy?overlay=${encodeURIComponent(state.windyOverlay)}`);
          state.windyOverlays = d.overlays;
          state.windyKey = locKey;
          renderWindyOverlays(d.overlays, d.overlay);
          if (frame.getAttribute('src') !== d.url) frame.setAttribute('src', d.url);
          frame.hidden = false;
          if (empty) empty.hidden = true;
          $('#windy-chip').textContent = `Windy · ${d.overlay}`;
          $('#windy-note').textContent = `${d.coverage.note} Centred on your device location ${d.centre.lat}, ${d.centre.lon}.`;
          $('#windy-credit').innerHTML = windyCredit(d);
          return;
        } catch (e) {
          // Fall through to the honest empty state below, with the reason.
          $('#windy-note').textContent = `Windy map unavailable for your location: ${e.message}`;
        }
      } else return;
    }
    frame.hidden = true; frame.removeAttribute('src');
    if (empty) empty.hidden = false;
    state.windyKey = null;
    $('#windy-note').textContent = wanted
      ? `${wanted} is not georeferenced - add coordinates in Analysis and the Windy map opens at them, or use the device location above.`
      : 'Select a georeferenced field - or read the device location - and the Windy map opens at those coordinates.';
    $('#windy-credit').innerHTML = windyCredit(null);
    renderWindyOverlays(state.windyOverlays || [], state.windyOverlay);
    return;
  }

  // Re-serving the same field and layer would reload the frame for nothing.
  const key = `${field.fieldId}|${state.windyOverlay}`;
  if (!force && state.windyKey === key && frame.getAttribute('src')) return;

  try {
    const d = await api(`/api/weather/windy?fieldId=${encodeURIComponent(field.fieldId)}`
      + `&overlay=${encodeURIComponent(state.windyOverlay)}`);
    state.windyOverlays = d.overlays;
    state.windyKey = key;
    renderWindyOverlays(d.overlays, d.overlay);
    if (frame.getAttribute('src') !== d.url) frame.setAttribute('src', d.url);
    frame.hidden = false;
    if (empty) empty.hidden = true;
    $('#windy-chip').textContent = `Windy · ${d.overlay}`;
    $('#windy-note').textContent = `${d.coverage.note} Centred on ${d.centre.lat}, ${d.centre.lon}.`;
    $('#windy-credit').innerHTML = windyCredit(d);
  } catch (e) {
    frame.hidden = true; frame.removeAttribute('src');
    if (empty) empty.hidden = false;
    state.windyKey = null;
    // A switched-off or refused map says so instead of showing a blank frame.
    $('#windy-note').textContent = `Windy map unavailable: ${e.message}`;
    $('#windy-credit').innerHTML = windyCredit(null);
  }
}

$('#basemap').addEventListener('change', (ev) => setBasemap(ev.target.value));

/* OpenStreetMap controls: search submit, the feature-layer switch, and the
 * kind chips (rendered from /api/geo/status, so the server owns the list). */
$('#osm-search').addEventListener('submit', (ev) => { ev.preventDefault(); runOsmSearch(); });
$('#osm-clear').addEventListener('click', () => { $('#osm-q').value = ''; $('#osm-results').hidden = true; });
$('#chk-osm').addEventListener('change', (ev) => {
  state.osmLayerOn = ev.target.checked;
  drawOsmFeatures({ force: true }).catch(() => {});
});
['#chk-tiles', '#chk-devices', '#chk-weather'].forEach((id) => $(id).addEventListener('change', () => updateMap()));
$('#geo-field').addEventListener('change', () => { state.geoFieldPicked = true; updateMap(); });

/* The toolbar shortcut and the card's own button share one code path on purpose:
 * two handlers that could drift apart would be two chances to report a
 * different location for the same device. */
['#btn-locate', '#btn-loc-use'].forEach((sel) => $(sel).addEventListener('click', () => useMyLocation()));
$('#btn-loc-follow').addEventListener('click', () => (state.locWatch == null ? startFollow() : stopFollow()));
$('#btn-loc-refresh').addEventListener('click', () => refreshLive());
$('#btn-loc-forget').addEventListener('click', async () => {
  stopFollow();
  try {
    await api('/api/location', { method: 'DELETE' });
    state.location = null;
    state.locLive = null;
    state.locLastPostLatLon = null;
    setLocStatus('Device location forgotten on the server. Nothing about this point is retained.', '');
    renderLocation();
    if (state.map) updateMap();
    toast('Device location forgotten');
  } catch (e) { toast(e.message, true); }
});

/* ═══════════════════════ SENSOR NETWORK (SITES) ════════════════════════════ */
function renderIngestSnippet() {
  const fid = $('#sensor-field') ? $('#sensor-field').value : state.fieldId;
  const el = $('#ingest-snippet');
  if (!el) return;
  if (!fid) { el.textContent = '# select a field'; return; }
  api(`/api/fields/${fid}`).then((f) => {
    el.textContent =
`# site-level stream
curl -X POST http://localhost:5177/api/fields/${f.fieldId}/ingest \\
  -H "Content-Type: application/json" \\
  -H "X-Sensor-Token: ${f.ingestToken}" \\
  -d '{"soilMoisture": 31.5, "temperatureC": 24.2, "humidityPct": 63,
       "ph": 6.4, "ec": 1.2, "rainMm": 0, "battery": 87}'

# one specific sensor - its own independent history
curl -X POST "http://localhost:5177/api/fields/${f.fieldId}/ingest?deviceId=S-xxxxxx" \\
  -H "X-Sensor-Token: <that sensor's ingest token>" \\
  -d '{"soilMoisture": 28.0, "ph": 6.6}'`;
  }).catch(() => {});
}

function deviceCard(d, siteId) {
  const extra = Object.entries(d.latest || {})
    .filter(([k, v]) => k !== 't' && k !== d.primaryKey && v != null)
    .map(([k, v]) => `<i><em>${esc(k)}</em>${esc(String(v))}</i>`).join('');
  return `<div class="dev-card">`
    + `<div class="dev-ico">${devIco(d.type)}</div>`
    + `<div class="dev-name"><b>${esc(d.name)}</b><u>${esc(d.typeLabel)}</u><code>${esc(d.deviceId)}</code></div>`
    + `<div class="dev-read${d.value == null ? ' na' : ''}"><b>${d.value == null ? '-' : d.value}</b><u>${esc(d.primaryUnit)}</u></div>`
    + sparkline(d.series)
    + `<div class="dev-facts"><i><span class="st-pill ${d.status}">${esc(d.status)}</span></i>`
    + `<i><em>last</em>${d.lastSeen ? esc(d.lastSeen.slice(11, 19)) : '-'}</i>`
    + `<i><em>n</em>${d.count}</i><i><em>fetching</em>${esc(d.primaryKey || '-')}</i>${extra}</div>`
    + `<div class="dev-acts">`
    + `<button class="btn sm" data-ping-dev="${esc(siteId)}|${esc(d.deviceId)}" title="POST one reading through the real ingest API from this browser">Test packet</button>`
    + `<button class="btn sm" data-copy-dev="${esc(siteId)}|${esc(d.deviceId)}">Endpoint</button>`
    + `<button class="btn sm danger" data-del-dev="${esc(siteId)}|${esc(d.deviceId)}">Remove</button>`
    + `</div></div>`;
}

const kiloHa = (v) => (v == null ? '-' : `${(+v).toFixed(2)} ha`);

/** What is growing on this site and what state its soil is in. Every number
 *  comes from the cached report and the freshest probe reading - nothing here
 *  is invented for an empty site, it says so instead. */
function agroStrip(s) {
  const c = s.crop;
  const q = s.soil || {};
  const crop = c
    ? `<span class="agro-pill crop"><u>crop</u><b>canopy ${c.canopyPct}%</b> · health ${c.healthScore}/100 ${esc(c.healthGrade)} · ${kiloHa(c.healthyHa)} healthy${c.stressedHa ? ` · ${kiloHa(c.stressedHa)} stressed` : ''}${c.ndvi != null ? ` · NDVI ${c.ndvi}` : ''}</span>`
    : `<span class="agro-pill crop"><u>crop</u><b>not analysed yet</b> · run the classifier or an AI analysis to populate it</span>`;
  const bits = [];
  if (q.moisturePct != null) bits.push(`moisture ${q.moisturePct}%${q.moistureSource ? ` (${esc(q.moistureSource)})` : ''}`);
  if (q.ph != null) bits.push(`pH ${q.ph}`);
  if (q.ec != null) bits.push(`EC ${q.ec}`);
  if (q.soilTempC != null) bits.push(`soil temp ${q.soilTempC}°`);
  const soil = `<span class="agro-pill soil"><u>soil</u>${q.score != null
    ? `<b>${q.score}/100 ${esc(q.grade)}</b>${bits.length ? ` · ${bits.join(' · ')}` : ''}`
    : '<b>no soil data</b> · connect a probe or georeference the field for satellite moisture'}</span>`;
  return `<div class="site-agro">${crop}${soil}</div>`;
}

/** A plausible packet for this device: its own latest values, nudged slightly,
 *  so a repeated press still draws a new point on the sparkline. */
const PACKET_DEFAULTS = {
  soilMoisture: 27.5, soilTempC: 14, ph: 6.5, ec: 1.15, temperatureC: 21.5,
  humidityPct: 62, rainMm: 0, windKmh: 9, lightLux: 38000, battery: 88,
};
function testPacket(d) {
  const keys = d.metrics && d.metrics.length ? d.metrics : [d.primaryKey || 'soilMoisture'];
  const out = {};
  for (const k of keys) {
    const base = d.latest && d.latest[k] != null ? +d.latest[k] : PACKET_DEFAULTS[k];
    if (base == null || !Number.isFinite(base)) continue;
    const jitter = k === 'ph' ? 0.05 : k === 'ec' ? 0.03 : k === 'battery' ? 1 : Math.max(0.2, Math.abs(base) * 0.03);
    out[k] = +(base + (Math.random() * 2 - 1) * jitter).toFixed(k === 'ph' || k === 'ec' ? 2 : 1);
  }
  return out;
}

function renderSites() {
  const data = state.sites;
  const box = $('#site-list');
  if (!box || !data) return;
  const filter = $('#site-filter').value;
  const sites = filter ? data.sites.filter((s) => s.siteId === filter) : data.sites;

  const chip = $('#sensor-chip');
  if (chip) chip.textContent = `${data.totalDevices} sensor${data.totalDevices === 1 ? '' : 's'} across ${data.sites.length} site${data.sites.length === 1 ? '' : 's'}`;

  if (!sites.length) {
    box.innerHTML = '<div class="empty-state">No sites registered. Upload a georeferenced field first.</div>';
    return;
  }
  box.innerHTML = sites.map((s) => {
    const wx = s.weather;
    return `<div class="site-block">`
      + `<div class="site-head">`
      + `<span class="site-name">${esc(s.siteId)}</span>`
      + `<span class="site-meta">${esc(s.name || '')} · ${s.grid.rows}x${s.grid.cols} · ${s.gps?.lat != null && s.gps?.lon != null ? `${s.gps.lat.toFixed(4)}, ${s.gps.lon.toFixed(4)}` : 'no GPS — geotag to unlock weather & map'}</span>`
      + `<span class="chip">${esc(s.status)}</span>`
      + `<div class="site-wx">${wx
        ? `<span><u>air</u>${wx.airTempC == null ? '-' : wx.airTempC}°</span>`
          + `<span><u>rh</u>${wx.humidityPct == null ? '-' : wx.humidityPct}%</span>`
          + `<span><u>wind</u>${wx.windKmh == null ? '-' : wx.windKmh}</span>`
          + `<span><u>rain</u>${wx.rainTodayMm == null ? '-' : wx.rainTodayMm}</span>`
          + `<span><u>et0</u>${wx.et0MmDay == null ? '-' : wx.et0MmDay}</span>`
        : `<span><u>weather</u>${esc(s.weatherError || 'needs GPS')}</span>`}</div>`
      + `</div>${agroStrip(s)}<div class="site-body">`
      + (s.devices.length ? s.devices.map((d) => deviceCard(d, s.siteId)).join('')
                          : '<span class="dim">No sensors deployed at this site yet.</span>')
      + `</div></div>`;
  }).join('');

  box.querySelectorAll('[data-del-dev]').forEach((b) => b.addEventListener('click', async () => {
    const [siteId, deviceId] = b.dataset.delDev.split('|');
    const dev = (data.sites.find((s) => s.siteId === siteId) || { devices: [] }).devices.find((d) => d.deviceId === deviceId);
    if (!confirm(`Remove sensor ${deviceId} and its ${(dev && dev.count) || 0} readings?`)) return;
    try {
      await api(`/api/fields/${siteId}/sensors/${deviceId}`, { method: 'DELETE' });
      toast(`Removed ${deviceId}`);
      await loadSites();
      if (state.map) updateMap();
    } catch (e) { toast(e.message, true); }
  }));
  // Connectivity demo, not simulated data: the browser itself becomes the
  // device and POSTs one reading to /api/fields/:id/ingest with the site's
  // token, exactly the path an ESP32 takes. A success proves the whole chain
  // (auth, validation, history, liveness) end to end.
  box.querySelectorAll('[data-ping-dev]').forEach((b) => b.addEventListener('click', async () => {
    const [siteId, deviceId] = b.dataset.pingDev.split('|');
    const site = data.sites.find((s) => s.siteId === siteId);
    const d = site && site.devices.find((x) => x.deviceId === deviceId);
    if (!d) return;
    b.disabled = true;
    try {
      const { ingestToken } = await api(`/api/fields/${siteId}`);
      const out = await api(`/api/fields/${siteId}/ingest?deviceId=${encodeURIComponent(deviceId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sensor-Token': ingestToken },
        body: JSON.stringify(testPacket(d)),
      });
      toast(`${d.name} accepted ${out.accepted.join(', ')} - now live`);
      await loadSites();
      if (state.map) updateMap();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
  box.querySelectorAll('[data-copy-dev]').forEach((b) => b.addEventListener('click', async () => {
    const [siteId, deviceId] = b.dataset.copyDev.split('|');
    try {
      const site = data.sites.find((s) => s.siteId === siteId);
      const d = site && site.devices.find((x) => x.deviceId === deviceId);
      const tok = (await api(`/api/fields/${siteId}`)).ingestToken;
      const key = (d && d.primaryKey) || 'soilMoisture';
      copyText(
        `curl -X POST "http://localhost:5177/api/fields/${siteId}/ingest?deviceId=${deviceId}" \\\n`
        + `  -H "Content-Type: application/json" \\\n`
        + `  -H "X-Sensor-Token: ${tok}" \\\n`
        + `  -d '{"${key}": 0}'`,
        () => toast(`Endpoint for ${deviceId} copied`));
    } catch (e) { toast(e.message, true); }
  }));

  renderReadingHistory(data, filter || ($('#sensor-field') ? $('#sensor-field').value : state.fieldId));
}

/** Reading history for the newest sensor on the focused site.
 *  `focus` is the site the list above is actually showing, so the table can
 *  never disagree with the visible filter (it used to read the register form's
 *  selector and echo another site's readings under the wrong heading). */
function renderReadingHistory(data, focus) {
  const tb = $('#readings-table');
  if (!tb) return;
  const wanted = focus || ($('#sensor-field') ? $('#sensor-field').value : state.fieldId);
  const site = data.sites.find((s) => s.siteId === wanted)
    || (!wanted ? data.sites[0] : null);
  // Keep the sub-heading honest about which stream the table is showing.
  const say = (txt) => { const sub = $('#readings-sub'); if (sub) sub.textContent = txt; };
  if (!site) {
    say('No site selected');
    tb.querySelector('thead').innerHTML = '';
    tb.querySelector('tbody').innerHTML = '<tr><td class="dim">No device readings recorded</td></tr>';
    return;
  }
  const dev = site.devices.slice().sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))[0];
  if (dev && dev.latest) {
    say(`Latest packet from ${dev.name} (${dev.deviceId}) at ${site.siteId} - ${dev.count} reading${dev.count === 1 ? '' : 's'} received`);
    const keys = (dev.metrics && dev.metrics.length ? dev.metrics : Object.keys(dev.latest).filter((k) => k !== 't'));
    tb.querySelector('thead').innerHTML = `<tr><th>Time</th>${keys.map((k) => `<th class="num">${esc(k)}</th>`).join('')}</tr>`;
    tb.querySelector('tbody').innerHTML = `<tr><td class="mono dim">${esc(dev.latest.t.slice(11, 19))}</td>`
      + keys.map((k) => `<td class="num">${dev.latest[k] == null ? '·' : esc(String(dev.latest[k]))}</td>`).join('')
      + `</tr><tr><td colspan="${keys.length + 1}" class="dim">${esc(dev.name)} (${esc(dev.deviceId)}) — ${dev.count} readings of ${esc(dev.primaryKey || '-')} · trend charted on its card above</td></tr>`;
    return;
  }
  const hist = (state.sensors.find((s) => s.fieldId === site.siteId) || {}).device || [];
  if (hist.length) {
    say(`Site-level stream at ${site.siteId} - ${hist.length} reading${hist.length === 1 ? '' : 's'} recorded before per-sensor history`);
    const keys = [...new Set(hist.flatMap((d) => Object.keys(d)))].filter((k) => k !== 't');
    tb.querySelector('thead').innerHTML = `<tr><th>Time</th>${keys.map((k) => `<th class="num">${esc(k)}</th>`).join('')}</tr>`;
    tb.querySelector('tbody').innerHTML = hist.slice(-12).reverse().map((d) =>
      `<tr><td class="mono dim">${new Date(d.t).toISOString().slice(11, 19)}</td>${keys.map((k) => `<td class="num">${d[k] == null ? '·' : d[k]}</td>`).join('')}</tr>`).join('');
  } else {
    say(`No readings yet at ${site.siteId}`);
    tb.querySelector('thead').innerHTML = '';
    tb.querySelector('tbody').innerHTML = '<tr><td class="dim">No device readings recorded</td></tr>';
  }
}

async function loadSites() {
  state.sites = await api('/api/sensors/sites').catch(() => null);
  renderSites();
}

/** Sensor network view: sites, their deployed sensors and live values. */
function renderSensors() {
  if (!$('#site-list')) return;
  const sel = $('#site-filter');
  if (sel && !sel.dataset.ready && state.sites) {
    sel.dataset.ready = '1';
    sel.innerHTML = '<option value="">All sites</option>'
      + state.sites.sites.map((s) => `<option value="${esc(s.siteId)}">${esc(s.siteId)} (${s.deviceCount})</option>`).join('');
  }
  renderSites();
  renderIngestSnippet();
  const f = state.fields.find((x) => x.fieldId === ($('#sensor-field').value || state.fieldId));
  const note = $('#dev-grid-note');
  if (note) note.textContent = f && f.grid ? `grid ${f.grid.rows} rows x ${f.grid.cols} cols - leave blank for field centre` : 'select a site first';
  if (!$('#dev-type').dataset.ready) fillDeviceTypes();
}

/** Populate the sensor-type picker from the server's sensor registry. */
function fillDeviceTypes() {
  const sel = $('#dev-type');
  if (!sel || sel.dataset.ready) return;
  const fid = ($('#sensor-field') ? $('#sensor-field').value : state.fieldId);
  if (!fid) return;
  sel.dataset.ready = '1';
  sel.innerHTML = '<option>loading…</option>';
  api(`/api/fields/${fid}/layers`).then((geo) => {
    const types = geo.sensorTypes || {};
    sel.innerHTML = Object.entries(types).map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`).join('');
    $('#dev-type-note').textContent = Object.entries(types)
      .map(([k, v]) => `${v.label}: ${(v.metrics || []).join(', ') || 'any'}`).join('  ·  ');
  }).catch(() => { sel.innerHTML = '<option value="generic">Generic device</option>'; });
}

$('#sensor-field').addEventListener('change', () => renderSensors());
$('#site-filter').addEventListener('change', renderSites);
$('#btn-refresh-wx').addEventListener('click', async () => {
  try {
    const r = await api('/api/sensors/refresh-weather', { method: 'POST' });
    state.sensors = r.sensors;
    await loadSites();
    if (state.map) updateMap();
    toast('Live weather refreshed - Open-Meteo');
  } catch (e) { toast(e.message, true); }
});
$('#btn-copy-snippet').addEventListener('click', () => {
  copyText($('#ingest-snippet').textContent, () => toast('Snippet copied to clipboard'));
});
$('#btn-add-sensor').addEventListener('click', async () => {
  const siteId = ($('#sensor-field') ? $('#sensor-field').value : state.fieldId);
  if (!siteId) return toast('Select a site first', true);
  const payload = { type: $('#dev-type').value || 'generic' };
  const name = $('#dev-name').value.trim();
  if (name) payload.name = name;
  const r = $('#dev-r').value, c = $('#dev-c').value;
  if (r !== '' && c !== '') { payload.r = +r; payload.c = +c; }
  try {
    const out = await api(`/api/fields/${siteId}/sensors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    $('#dev-created').innerHTML = `<div class="alert info"><b>${esc(out.device.name)}</b> registered as <code class="mono">${esc(out.device.deviceId)}</code>`
      + `<span class="tok">ingest token ${esc(out.ingestToken)} &rarr; POST /api/fields/${esc(siteId)}/ingest?deviceId=${esc(out.device.deviceId)}</span></div>`;
    $('#dev-name').value = ''; $('#dev-r').value = ''; $('#dev-c').value = '';
    toast(`${out.device.name} registered at ${siteId}`);
    await loadSites();
    if (state.map) updateMap();
  } catch (e) { toast(e.message, true); }
});
/* ═════════════════ CP9 + CP10 · WORKFLOWS & FUSION SOURCES ═════════════════ */
const WF_NODE_HINT = { fetch: 'fetches a real dataset', prepare: 'reshapes upstream results', infer: 'produces an insight' };

function wfFieldId() {
  const sel = $('#wf-field');
  if (sel && sel.value) return sel.value;
  return (state.fields.find((f) => f.gps?.lat != null) || state.fields[0] || {}).fieldId || '';
}

function nodeChip(n) {
  const style = n.status === 'failed'
    ? ' style="color:var(--flare);border-color:var(--flare)"'
    : n.cached ? ' style="color:var(--muted)"' : '';
  const detail = n.cached ? 'cached' : n.status === 'failed' ? 'failed' : `${n.durationMs ?? 0} ms`;
  return `<span class="chip"${style} title="${esc(n.label || n.nodeId)}">${esc(n.nodeId)} · ${esc(detail)}</span>`;
}

function renderWfFieldSelect() {
  const sel = $('#wf-field');
  if (!sel) return;
  const keep = sel.value;
  const hasGps = (f) => f.gps?.lat != null && f.gps?.lon != null;
  sel.innerHTML = state.fields.map((f) => `<option value="${esc(f.fieldId)}">${esc(f.fieldId)} · ${f.fieldId === state.fieldId ? 'selected · ' : ''}${hasGps(f) ? 'GPS' : 'no GPS'}</option>`).join('');
  // Satellite, terrain and weather nodes need real coordinates, so the default
  // choice is a georeferenced field when one exists. An explicit pick always wins.
  if (keep && state.fields.some((f) => f.fieldId === keep)) sel.value = keep;
  else {
    const target = state.fields.find((f) => f.fieldId === state.fieldId && hasGps(f))
      || state.fields.find(hasGps)
      || state.fields.find((f) => f.fieldId === state.fieldId)
      || state.fields[0];
    if (target) sel.value = target.fieldId;
  }
}

function renderWorkflows() {
  renderWfFieldSelect();
  const list = $('#wf-list');
  if (!list || !state.workflows) return;
  list.innerHTML = state.workflows.map((w) => `
    <div class="wf-card">
      <div class="wf-head">
        <div>
          <b>${esc(w.label)}</b>
          <u class="mono">${esc(w.id)} · ${w.nodeCount} nodes · ${w.edges.length} edges${w.requiresGps ? ' · needs a georeferenced field' : ''}</u>
        </div>
        <div class="row">
          <button class="btn primary sm" data-wf-run="${esc(w.id)}">Run</button>
          <button class="btn sm" data-wf-force="${esc(w.id)}">Re-run forced</button>
        </div>
      </div>
      <p class="note">${esc(w.description)}</p>
      <div class="wf-nodes">${w.graph.map((n) => `<span class="chip" title="${esc(n.kind)} — ${esc(WF_NODE_HINT[n.kind] || '')}">${esc(n.id)}</span>`).join('')}</div>
    </div>`).join('');
  list.querySelectorAll('[data-wf-run]').forEach((b) => b.addEventListener('click', () => runWorkflow(b.dataset.wfRun, false)));
  list.querySelectorAll('[data-wf-force]').forEach((b) => b.addEventListener('click', () => runWorkflow(b.dataset.wfForce, true)));
  const chip = $('#wf-chip');
  if (chip) chip.textContent = `${state.workflows.length} workflows`;
}

async function loadWorkflows() {
  try {
    const d = await api('/api/workflows');
    state.workflows = d.workflows;
    renderWorkflows();
  } catch (e) { toast(e.message, true); }
}

async function loadSources() {
  const box = $('#src-table');
  if (!box) return;
  try {
    const d = await api('/api/sources');
    box.innerHTML = '<table class="data-table"><thead><tr><th>Source</th><th>Dataset</th><th>Attribution</th><th>Last fetch</th></tr></thead><tbody>'
      + d.sources.map((s) => `<tr>
          <td class="mono">${esc(s.id)}</td>
          <td class="dim">${esc(s.product)}</td>
          <td class="dim">${esc(s.attribution)}</td>
          <td class="mono dim">${s.lastFetchedAt ? esc(String(s.lastFetchedAt).slice(11, 19)) : '—'}</td>
        </tr>`).join('')
      + '</tbody></table>';
  } catch (e) { box.innerHTML = `<span class="dim">${esc(e.message)}</span>`; }
}

async function loadRuns() {
  const box = $('#wf-runs');
  if (!box || !state.workflows) return;
  const fieldId = wfFieldId();
  try {
    const all = [];
    for (const w of state.workflows) {
      const d = await api(`/api/workflows/${encodeURIComponent(w.id)}/runs?fieldId=${encodeURIComponent(fieldId)}&limit=5`);
      all.push(...d.items);
    }
    all.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    if (!all.length) { box.innerHTML = `<span class="dim">No runs yet for ${esc(fieldId)} — press Run on a workflow.</span>`; return; }
    box.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr><th>Run</th><th>Workflow</th><th>Status</th><th class="num">Ran</th><th class="num">Cached</th><th class="num">ms</th><th>Started</th><th>Nodes</th></tr></thead><tbody>'
      + all.slice(0, 12).map((r) => `<tr>
          <td class="mono">${esc(r.runId)}</td>
          <td>${esc(r.workflowId)}</td>
          <td>${esc(r.status)}${r.error ? ` <span class="dim">${esc(String(r.error).slice(0, 60))}</span>` : ''}</td>
          <td class="num">${r.executed}</td>
          <td class="num">${r.reused}</td>
          <td class="num">${r.durationMs}</td>
          <td class="mono dim">${esc(String(r.startedAt).slice(11, 19))}</td>
          <td><div class="wf-nodes">${(r.nodes || []).map((n) => nodeChip(n)).join('')}</div></td>
        </tr>`).join('')
      + '</tbody></table></div>';
  } catch (e) { box.innerHTML = `<span class="dim">${esc(e.message)}</span>`; }
}

async function runWorkflow(id, force) {
  const out = $('#wf-out');
  const fieldId = wfFieldId();
  if (out) out.innerHTML = `<span class="dim">Running ${esc(id)}${force ? ' (forced)' : ''} for ${esc(fieldId)} …</span>`;
  try {
    const r = await api(`/api/workflows/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId, force }),
    });
    toast(`${r.workflowLabel}: ${r.executed} node(s) ran, ${r.reused} reused`);
    const irr = r.nodes.find((n) => n.nodeId === 'irrigation' && n.output);
    const ctx = r.nodes.find((n) => n.nodeId === 'context' && n.output);
    if (out) {
      out.innerHTML = `<div class="klist"><div class="kv"><b>${esc(r.runId)}</b><span>${esc(r.status)} · ${r.durationMs} ms · ${r.executed} ran / ${r.reused} reused${r.forced ? ' · forced' : ''}</span></div></div>`
        + `<div class="wf-nodes">${r.nodes.map(nodeChip).join('')}</div>`
        + (r.error ? `<p class="note" style="color:var(--flare)">${esc(r.error)}</p>` : '')
        + (irr ? `<p class="note">Advisory: <b>${esc(irr.output.recommendation || '—')}</b>${irr.output.urgency ? ` · urgency ${esc(irr.output.urgency)}` : ''}${irr.output.inputs ? ` · soil ${esc(String(irr.output.inputs.soilMoisture))} ${esc(irr.output.inputs.soilMoistureSource || '')}` : ''}</p>` : '')
        + (ctx ? `<p class="note">Context: ${ctx.output.sourcesUsed} live source(s) — ${ctx.output.optical ? `${ctx.output.optical.scenes} optical scene(s)` : 'no optical'}, ${ctx.output.sar ? `${ctx.output.sar.scenes} SAR scene(s)` : 'no SAR'}, terrain ${ctx.output.terrain ? `${ctx.output.terrain.elevationM} m` : '—'}, weather ${ctx.output.weather ? `${ctx.output.weather.airTempC} °C` : '—'}</p>` : '');
    }
    loadRuns(); loadSources();
  } catch (e) {
    if (out) out.innerHTML = `<p class="note" style="color:var(--flare)">${esc(e.message)}</p>`;
    toast(e.message, true);
  }
}

const WF_FETCH_LABEL = {
  'sentinel-2-l2a': 'Sentinel-2 optical scenes',
  'sentinel-1-grd': 'Sentinel-1 SAR scenes',
  terrain: 'Terrain + slope',
  crosscheck: 'Weather cross-check',
};

async function fetchConnector(kind) {
  const out = $('#wf-fetch-out');
  const fieldId = wfFieldId();
  const label = WF_FETCH_LABEL[kind] || kind;
  if (out) out.innerHTML = `<span class="dim">Fetching ${esc(label)} for ${esc(fieldId)} …</span>`;
  try {
    let html;
    if (kind === 'terrain') {
      const t = await api(`/api/fields/${encodeURIComponent(fieldId)}/terrain`);
      html = `<div class="klist"><div class="kv"><b>${esc(label)}</b><span>${t.elevationM} m · slope ${t.slopePct}% (${t.slopeDeg}°) · aspect ${t.aspectDeg}° · ${esc(t.drainage)}</span></div></div>`
        + `<div class="wf-nodes">${t.samples.map((s) => `<span class="chip">${esc(s.role)} ${s.elevationM} m</span>`).join('')}</div>`
        + `<p class="note">${esc(t.provenance.attribution)} · relief ${t.reliefM} m · ${t.cached ? 'served from cache' : `fetched ${esc(String(t.fetchedAt).slice(11, 19))}`}</p>`;
    } else if (kind === 'crosscheck') {
      const x = await api(`/api/fields/${encodeURIComponent(fieldId)}/weather-crosscheck`);
      html = '<div class="table-wrap"><table class="data-table"><thead><tr><th>Window</th><th class="num">Days</th><th class="num">Open-Meteo °C</th><th class="num">NASA POWER °C</th><th class="num">Δ °C</th><th class="num">Rain OM</th><th class="num">Rain NASA</th><th>Agreement</th></tr></thead><tbody>'
        + `<tr><td class="mono">${esc(String(x.window.from))} to ${esc(String(x.window.to))}</td><td class="num">${x.days}</td><td class="num">${x.primary.meanTempC}</td><td class="num">${x.crosscheck.meanTempC}</td><td class="num">${x.delta.meanTempC}</td><td class="num">${x.primary.rainSumMm} mm</td><td class="num">${x.crosscheck.rainSumMm} mm</td><td><span class="chip${x.agreement === 'close' ? ' ok-chip' : ''}">${esc(x.agreement)}</span></td></tr></tbody></table></div>`
        + `<p class="note">${esc(x.note || '')}${x.crosscheck.meanHumidityPct != null ? ` Mean humidity ${x.crosscheck.meanHumidityPct}%.` : ''}</p>`;
    } else {
      const s = await api(`/api/fields/${encodeURIComponent(fieldId)}/satellite?collection=${encodeURIComponent(kind)}&days=90&limit=6`);
      html = `<div class="klist"><div class="kv"><b>${esc(label)}</b><span>${s.count} scene(s) in the last ${s.window.days} days${s.leastCloudy ? ` · clearest ${esc(String(s.leastCloudy.datetime).slice(0, 10))} at ${s.leastCloudy.cloudCover.toFixed(1)}% cloud` : ''}</span></div></div>`
        + '<div class="wf-scenes">'
        + s.scenes.map((sc) => `<figure class="wf-scene">${sc.thumbnail ? `<img src="${esc(sc.thumbnail)}" alt="Sentinel scene preview" loading="lazy" />` : '<div class="wf-noimg">SAR</div>'}`
          + `<figcaption><b>${esc(String(sc.datetime).slice(0, 10))}</b><u>${sc.cloudCover == null ? 'SAR · cloud-independent' : `${sc.cloudCover.toFixed(1)}% cloud`}</u><em>${esc(sc.platform || sc.collection || '')}</em></figcaption></figure>`).join('')
        + '</div>'
        + `<p class="note">${esc(s.provenance.attribution)} · ${s.cached ? 'served from cache' : `fetched ${esc(String(s.fetchedAt).slice(11, 19))}`}</p>`;
    }
    if (out) out.innerHTML = html;
    loadSources();
  } catch (e) {
    if (out) out.innerHTML = `<p class="note" style="color:var(--flare)">${esc(e.message)}</p>`;
    toast(e.message, true);
  }
}

async function initWorkflows() {
  if (!state.fields.length) { try { await refreshFields(); } catch {} }
  renderWfFieldSelect();
  loadSources();
  if (!state.workflows) await loadWorkflows(); else renderWorkflows();
  loadRuns();
}

$('#btn-wf-history').addEventListener('click', loadRuns);
$('#btn-wf-clear').addEventListener('click', async () => {
  try {
    const fieldId = wfFieldId();
    await api('/api/workflow-runs/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fieldId }) });
    toast(`Run history cleared for ${fieldId}`);
    loadRuns();
  } catch (e) { toast(e.message, true); }
});
$('#wf-field').addEventListener('change', () => {
  loadRuns();
  if ($('#wf-out')) $('#wf-out').innerHTML = '<span class="dim">Field changed — press Run on a workflow.</span>';
});
$$('#wf-fetch-btns button').forEach((b) => b.addEventListener('click', () => fetchConnector(b.dataset.fetch)));

/* ═══════════════════ AI MODEL (EXTERNAL) TAB ═══════════════════════════════ */
const AI_CONTRACT_TEXT = `REQUEST  POST <baseUrl>
  Content-Type: application/json
  Authorization: Bearer <apiKey>          # only when a key is set

  { "model": "<model>",
    "task":  "<what to analyse>",
    "classes": ["healthy", "stressed", "soil", "weed"],
    "image": "data:image/jpeg;base64,...",   # or image/png for a single tile
    "grid":  { "rows": 20, "cols": 20 },      # shape hint, omit to skip per-tile
    "context": { "fieldId": "...", "gps": { "lat": 0, "lon": 0 } } }

RESPONSE  200 with a JSON object (plain, or under choices[0].message.content
           for the OpenAI-compatible provider). Every key is optional.

  { "class": "healthy",            # healthy | stressed | soil | weed
    "confidence": 0.87,            # 0..1
    "classes": { "healthy": 0.7, "stressed": 0.05,
                 "soil": 0.19, "weed": 0.06 },
    "health": 82.5,                # 0..100  plant health / quality
    "weed":  6.1,                  # 0..100  weed pressure
    "soil":  74.0,                 # 0..100  soil quality
    "ndvi":  0.81,                 # 0..1
    "grid": [["healthy","soil",...], ...] }   # rows x cols, optional

Aliases are accepted for every field (label/category, score/conf,
vigour/quality, weed_pressure, soil_quality, tile_grid/matrix, ...).
Class names are matched loosely: "crop", "vegetation" -> healthy;
"diseased", "sick" -> stressed; "bare", "earth" -> soil; "grass" -> weed.
Fenced or prose-wrapped JSON is parsed too.`;

const AI_PROVIDER_HINT = {
  disabled: 'External AI is off. The local kNN model trained on your labeled tiles is used for every classification.',
  generic: 'The console POSTs the contract above straight to your endpoint and parses the JSON it returns.',
  openai: 'The console calls an OpenAI-compatible /chat/completions vision endpoint and reads the JSON object out of the reply.',
};

/* ============================ SPECIES IDENTIFICATION ======================== */
const AI_IDENTIFY_CONTRACT_TEXT = `REQUEST  POST /api/ai/identify
  Content-Type: application/json

  { "image": "data:image/jpeg;base64,...",   # camera / uploaded frame
    "thumb": "data:image/jpeg;base64,...",   # small preview for history, optional
    "source": "camera",                      # camera | map
    "gps":  { "lat": 0, "lon": 0 } }          # optional

  — or —  { "fieldId": "F-...", "r": 4, "c": 4 }   # identify from a field region
          (the server sends the biggest crop of the source image around that
           tile — a 50 px tile alone is too small for any species model)

RESPONSE  200 · 409 when the endpoint is not configured · 502 when the model fails

  { "ok": true, "id": "id-...", "latencyMs": 840, "model": "qwen2.5vl:3b",
    "result": {
      "common": "Perennial ryegrass",
      "scientific": "Lolium perenne",
      "family": "Poaceae",
      "type": "grass",       # crop|grass|weed|wildflower|tree|shrub|fungus|soil|unknown
      "confidence": 0.86,     # 0..1
      "candidates": [{ "common": "...", "scientific": "...", "confidence": 0.86 }],
      "health": 78.5,         # 0..100 or null
      "condition": "healthy", # thriving|healthy|stressed|diseased|dead|unknown
      "traits": ["..."],      # observable facts taken from the image
      "notes": "..." } }

GET  /api/identify   -> { total, items: [ stored entries, newest first ] }

Aliases accepted: scientific_name/binomial, common_name, predictions,
top_species, quality/vigour -> health, remarks -> notes; fenced or
prose-wrapped JSON parses too. Nothing is invented locally: an unconfigured
or unreachable endpoint returns 409/502, never a guessed species.`;

/** Grab the camera frame at model size plus a tiny history thumbnail. */
function grabFrame(video) {
  const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.max(1, Math.round(video.videoWidth * scale));
  const h = Math.max(1, Math.round(video.videoHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  const t = document.createElement('canvas');
  const ts = Math.min(1, 144 / Math.max(w, h));
  t.width = Math.max(1, Math.round(w * ts));
  t.height = Math.max(1, Math.round(h * ts));
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  return { dataUrl: c.toDataURL('image/jpeg', 0.85), thumb: t.toDataURL('image/jpeg', 0.6) };
}

/** One identification rendered as a card — camera modal, popup and history all
 *  use this so the species, type, confidence and health always read the same. */
function identifyResultHTML(r, meta = {}) {
  if (!r) return '<div class="idr-error">Model returned no species information.</div>';
  const name = r.common || r.scientific || 'Unknown';
  const sci = r.scientific && r.scientific !== name ? `<i class="sci">${esc(r.scientific)}</i>` : '';
  const pct = Math.round((r.confidence || 0) * 100);
  const cond = r.condition && r.condition !== 'unknown' ? `<span class="chip">${esc(r.condition)}</span>` : '';
  const traits = (r.traits || []).map((t) => `<li>${esc(t)}</li>`).join('');
  const cands = (r.candidates || []).filter((c) => c.common || c.scientific)
    .map((c) => `<div class="cand"><span>${esc(c.common || c.scientific || '')}</span><span class="mono small dim">${c.confidence != null ? `${Math.round(c.confidence * 100)}%` : '—'}</span></div>`).join('');
  const src = [meta.model, meta.latencyMs != null ? `${meta.latencyMs} ms` : null, meta.source].filter(Boolean).map(esc).join(' · ');
  return `
    <div class="idr-head"><b>${esc(name)}</b>${sci}<span class="chip idr-type">${esc(r.type || 'unknown')}</span></div>
    <div class="idr-conf"><div class="idr-conf-bar"><i style="width:${pct}%"></i></div><span class="mono small">${pct}% confident</span></div>
    ${r.health != null || cond ? `<div class="idr-scores">${r.health != null ? `<span>health <b class="mono">${Math.round(r.health)}/100</b></span>` : ''}${cond}</div>` : ''}
    ${traits ? `<ul class="idr-traits">${traits}</ul>` : ''}
    ${r.notes ? `<p class="idr-notes">${esc(r.notes)}</p>` : ''}
    ${cands ? `<div class="idr-cands"><span class="small dim">other candidates</span>${cands}</div>` : ''}
    ${src ? `<div class="idr-src small dim">${src}</div>` : ''}`;
}

/** Stored identification history on the AI tab (real calls only). */
async function loadIdentifyHistory() {
  const box = document.getElementById('identify-history');
  if (!box) return;
  let data;
  try { data = await api('/api/identify'); }
  catch (e) { box.innerHTML = `<div class="empty-state"><span>${esc(e.message)}</span></div>`; return; }
  const items = data.items || [];
  if (!items.length) {
    box.innerHTML = '<div class="empty-state"><span>No identifications yet — open the camera and press Identify plant, or use Identify here on a map tile.</span></div>';
    return;
  }
  box.innerHTML = items.map((it) => {
    const r = it.result || {};
    const name = r.common || r.scientific || 'Unknown';
    const sci = r.scientific && r.scientific !== name ? `<i class="sci">${esc(r.scientific)}</i>` : '';
    const pct = Math.round((r.confidence || 0) * 100);
    return `<div class="id-item">
      ${it.thumb ? `<img class="id-thumb" src="${it.thumb}" alt="">` : '<div class="id-thumb id-thumb-none"></div>'}
      <div class="id-item-body">
        <div class="idr-head"><b>${esc(name)}</b>${sci}<span class="chip idr-type">${esc(r.type || 'unknown')}</span></div>
        <div class="small dim">${esc(it.source)}${it.fieldId != null ? ` · tile ${it.r},${it.c}` : ''}${it.gps && it.gps.lat != null ? ` · ${(+it.gps.lat).toFixed(4)}, ${(+it.gps.lon).toFixed(4)}` : ''}${r.health != null ? ` · health ${Math.round(r.health)}/100` : ''}</div>
        <div class="idr-conf"><div class="idr-conf-bar"><i style="width:${pct}%"></i></div><span class="mono small">${pct}%</span></div>
      </div>
      <div class="id-item-meta small dim mono">${esc(String(it.at || '').replace('T', ' ').slice(0, 19))}<br>${esc(it.model || '')} · ${it.latencyMs} ms</div>
    </div>`;
  }).join('');
}

$('#btn-ai-id-save').addEventListener('click', async () => {
  const b = $('#btn-ai-id-save');
  b.disabled = true;
  try {
    await api('/api/ai/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identify: {
        provider: $('#ai-id-provider').value,
        baseUrl: $('#ai-id-baseurl').value.trim(),
        model: $('#ai-id-model').value.trim(),
        timeoutMs: +$('#ai-id-timeout').value || 120000,
      } }),
    });
    await renderAiStatus();
    toast('Species identification endpoint saved');
  } catch (e) { toast(e.message, true); }
  b.disabled = false;
});

$('#btn-ai-id-test').addEventListener('click', async () => {
  const b = $('#btn-ai-id-test');
  b.disabled = true;
  const old = b.textContent;
  b.textContent = 'Testing…';
  try {
    const r = await api('/api/ai/test-identify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId: $('#ai-field').value || undefined }),
    });
    const res = r.result || {};
    $('#ai-id-note').textContent = `Round-trip OK in ${r.latencyMs} ms — ${res.common || res.scientific || 'unknown'} (${res.type}, ${Math.round((res.confidence || 0) * 100)}%) · model ${r.model}`;
    toast(`${res.common || res.scientific || 'identified'} in ${r.latencyMs} ms`);
  } catch (e) {
    $('#ai-id-note').textContent = e.message;
    toast(e.message, true);
  }
  b.textContent = old;
  b.disabled = false;
});

function setAiBadge(text, kind = '') {
  const b = $('#ai-source-badge');
  b.textContent = text;
  b.className = 'chip' + (kind ? ' ' + kind : '');
}

/** Status/config card: provider form + live call stats. */
async function renderAiStatus() {
  let s;
  try { s = await api('/api/ai/status'); }
  catch (e) { $('#ai-status-note').textContent = `Status unavailable: ${e.message}`; return; }
  state.ai = s;

  if (document.activeElement !== $('#ai-baseurl')) $('#ai-baseurl').value = s.baseUrl || '';
  if (document.activeElement !== $('#ai-model')) $('#ai-model').value = s.model || '';
  if (document.activeElement !== $('#ai-key')) $('#ai-key').value = s.apiKeyMasked || '';
  if (document.activeElement !== $('#ai-timeout')) $('#ai-timeout').value = s.timeoutMs;
  $('#ai-provider').value = s.provider;

  $('#ai-status-note').textContent = s.configured
    ? `Connected to ${s.provider} at ${s.baseUrl}${s.model ? ` · model ${s.model}` : ''}${s.hasApiKey ? ' · key on file' : ' · no auth key'}.`
    : AI_PROVIDER_HINT[s.provider] || 'External AI is not configured.';

  const rt = s.runtime || {};
  $('#ai-runtime').innerHTML =
    kv('provider', s.provider) +
    kv('endpoint', s.baseUrl || '—') +
    kv('model', s.model || '—') +
    kv('auth key', s.hasApiKey ? s.apiKeyMasked : 'none') +
    kv('timeout', `${s.timeoutMs} ms`) +
    kv('calls', rt.calls ?? 0) +
    kv('errors', rt.errors ?? 0) +
    kv('last latency', rt.lastLatencyMs == null ? '—' : `${rt.lastLatencyMs} ms`) +
    kv('last call', rt.lastCallAt ? new Date(rt.lastCallAt).toLocaleTimeString() : '—') +
    (rt.lastError ? kv('last error', `<span style="color:var(--danger)">${esc(rt.lastError)}</span>`) : '');

  $('#btn-ai-test').disabled = !s.configured;
  setAiBadge(s.configured ? `EXTERNAL AI · ${s.provider.toUpperCase()}` : 'LOCAL MODEL', s.configured ? 'ok-chip' : '');

  // species identification endpoint (separate model, falls back to the main one)
  const idt = s.identify || {};
  if (document.activeElement !== $('#ai-id-baseurl')) $('#ai-id-baseurl').value = idt.baseUrl || '';
  if (document.activeElement !== $('#ai-id-model')) $('#ai-id-model').value = idt.model || '';
  if (document.activeElement !== $('#ai-id-timeout')) $('#ai-id-timeout').value = idt.timeoutMs || 120000;
  if (document.activeElement !== $('#ai-id-provider')) $('#ai-id-provider').value = idt.provider || 'openai';
  $('#ai-id-chip').textContent = !idt.configured ? 'NOT CONFIGURED' : idt.dedicated ? `DEDICATED · ${idt.runtime?.calls ?? 0} CALLS` : 'USES MAIN ENDPOINT';
  $('#ai-id-chip').className = 'chip' + (idt.configured ? ' ok-chip' : '');
  $('#btn-ai-id-test').disabled = !idt.configured;
  $('#ai-id-note').textContent = idt.configured
    ? `Connected: ${idt.provider} · ${idt.baseUrl}${idt.model ? ` · model ${idt.model}` : ''} · ${idt.stored} identification${idt.stored === 1 ? '' : 's'} stored.`
    : 'Not configured — identification falls back to the main endpoint above.';
}

const DIAL_R = 40, DIAL_C = 2 * Math.PI * DIAL_R;
function dial(label, value, { grade, color } = {}) {
  const has = value != null && Number.isFinite(+value);
  const pct = has ? Math.max(0, Math.min(100, +value)) : 0;
  const col = color || (pct >= 75 ? 'var(--leaf)' : pct >= 50 ? 'var(--amber)' : 'var(--danger)');
  return `
    <div class="dial${has ? '' : ' na'}">
      <div class="dial-ring">
        <svg width="92" height="92" viewBox="0 0 92 92">
          <circle class="track" cx="46" cy="46" r="${DIAL_R}" fill="none" stroke-width="7"/>
          <circle class="arc" cx="46" cy="46" r="${DIAL_R}" fill="none" stroke-width="7" stroke="${col}"
            stroke-dasharray="${DIAL_C.toFixed(1)}"
            stroke-dashoffset="${(DIAL_C * (1 - pct / 100)).toFixed(1)}"
            style="--circ:${DIAL_C.toFixed(1)}"/>
        </svg>
        <div class="dial-val">${has ? Math.round(pct) : '—'}<i>/100</i></div>
      </div>
      <b>${esc(label)}</b>
      ${grade ? `<span class="small dim">${esc(grade)}</span>` : ''}
    </div>`;
}

const fmtM2 = (v) => (v == null ? '—' : `${(+v).toLocaleString(undefined, { maximumFractionDigits: 1 })} m²`);

/** The agronomy report: scores, real ground areas, alerts. */
function renderAiReport(r, meta = {}) {
  const badge = $('#ai-source-badge');
  if (r) {
    const label = r.source === 'external-ai' || r.source === 'external-ai+grid' ? r.source.replace('-ai', ' AI') : r.source;
    setAiBadge(String(label).toUpperCase(), r.source?.startsWith('external-ai') ? 'ok-chip' : '');
    if (meta.aiError) badge.title = `AI fallback: ${meta.aiError}`;
  }

  const scores = $('#ai-scores'), areas = $('#ai-areas'), alerts = $('#ai-alerts');
  if (!r) {
    scores.innerHTML = '<div class="empty-state"><span>Run an AI analysis to populate plant detection, health, weed area and soil quality.</span></div>';
    areas.innerHTML = ''; alerts.innerHTML = '';
    return;
  }

  scores.innerHTML = `<div class="dials">
    ${dial('Plant health', r.plant.healthScore, { grade: r.plant.healthGrade })}
    ${dial('Soil quality', r.soil.score, { grade: r.soil.insufficient ? 'insufficient data' : r.soil.grade })}
    ${dial('Canopy cover', r.plant.canopyCoverPct, { grade: `${r.plant.plantAreaM2} m² crop` })}
    ${dial('Weed pressure', r.weed.level === 'low' ? 100 - r.weed.pct * 4 : r.weed.pressure != null ? r.weed.pressure : r.weed.pct * 4,
      { grade: `${r.weed.areaM2} m² weed`, color: r.weed.pct > 8 ? 'var(--danger)' : 'var(--leaf)' })}
  </div>
  <div class="small dim" style="margin-top:10px">
    ${meta.latencyMs != null ? `Model round-trip ${meta.latencyMs} ms · ` : ''}${esc(r.mode)} ·
    ${r.labels.manualTiles} manual + ${r.labels.predictedTiles} model tiles ·
    ${r.geometry.grid} grid, ${r.geometry.tileSizeM} m tiles · ${r.geometry.fieldAreaHa} ha
    ${r.geometry.georeferenced ? `(georeferenced)` : '(no GPS — using default field width)'}
  </div>`;

  const g = r.geometry;
  areas.innerHTML = `
    <h3>Measured areas</h3>
    <div class="area-table">
      ${CLASS_KEYS.map((k) => `
        <div class="area-row">
          <i style="background:${CLASSES[k].hex}"></i>
          <span class="lbl">${esc(CLASSES[k].label)}<small>${r.classes[k].tiles} tiles · ${r.classes[k].ha} ha · ${r.classes[k].acres} ac</small></span>
          <span class="amt">${fmtM2(r.classes[k].m2)}</span>
          <span class="pct">${fmtPct(r.classes[k].pct)}</span>
        </div>`).join('')}
    </div>
    <div class="small dim" style="margin-top:10px">
      Tile area ${g.tileAreaM2} m² · field ${g.fieldAreaM2} m² (${g.fieldAreaHa} ha / ${g.fieldAreaAcres} acres) · width ${g.groundWidthM} m [${g.widthSource}]
      ${r.plant.ndvi != null ? ` · model NDVI ${r.plant.ndvi}` : ''}
      ${r.plant.aiConfidence != null ? ` · model confidence ${Math.round(r.plant.aiConfidence * 100)}%` : ''}
    </div>
    ${r.soil.inputs?.length ? `
      <div class="soil-inputs">
        ${r.soil.inputs.map((i) => `
          <div class="soil-in">
            <span>${esc(i.input)} <span class="dim">${esc(i.value)}</span></span>
            <span class="src">${esc(i.source)}</span>
            <span style="color:${i.score >= 75 ? 'var(--leaf)' : i.score >= 50 ? 'var(--amber)' : 'var(--danger)'}">${i.score == null ? '—' : Math.round(i.score)}</span>
          </div>`).join('')}
      </div>` : ''}`;

  alerts.innerHTML = `
    ${(r.alerts || []).map((a) => `<span class="alert ${esc(a.level)}">${ICON[a.level] || ICON.info}${esc(a.text)}</span>`).join('')}
    ${(r.recommendations || []).map((t) => `<span class="alert info">${ICON.ok}${esc(t)}</span>`).join('')}
    ${!(r.alerts || []).length && !(r.recommendations || []).length ? '<span class="dim small">No alerts — canopy, weed load and soil inputs all within range.</span>' : ''}`;
}

async function renderAi({ fresh = false } = {}) {
  await renderAiStatus();
  const fid = $('#ai-field').value || state.fieldId;
  if (!fid) { renderAiReport(null); return; }
  try {
    const r = await api(`/api/fields/${fid}/report`);
    renderAiReport(r, { fresh });
  } catch (e) {
    $('#ai-scores').innerHTML = `<div class="empty-state"><span>${esc(e.message)}</span></div>`;
    $('#ai-areas').innerHTML = ''; $('#ai-alerts').innerHTML = '';
  }
}

$('#ai-field').addEventListener('change', (ev) => {
  state.fieldId = ev.target.value;
  for (const s of ['#field-select', '#analysis-field', '#sensor-field']) $(s).value = ev.target.value;
  selectField(ev.target.value).then(() => renderAi());
});

$('#btn-ai-save').addEventListener('click', async () => {
  const b = $('#btn-ai-save'); b.disabled = true;
  try {
    await api('/api/ai/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: $('#ai-provider').value,
        baseUrl: $('#ai-baseurl').value.trim(),
        apiKey: $('#ai-key').value.trim(),
        model: $('#ai-model').value.trim(),
        timeoutMs: +$('#ai-timeout').value || 45000,
      }),
    });
    await renderAiStatus();
    toast('AI endpoint saved');
  } catch (e) { toast(e.message, true); }
  b.disabled = false;
});

$('#btn-ai-test').addEventListener('click', async () => {
  const b = $('#btn-ai-test'); b.disabled = true;
  const old = b.textContent; b.textContent = 'Testing…';
  try {
    const r = await api('/api/ai/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId: $('#ai-field').value || undefined }),
    });
    const n = r.normalized || {};
    toast(`Model reachable in ${r.latencyMs} ms — ${n.class || 'no class'} ${n.confidence ? `${Math.round(n.confidence * 100)}%` : ''}`);
    $('#ai-runtime').insertAdjacentHTML('afterbegin',
      `<div class="kv"><b>test reply</b><span class="mono small">${esc(JSON.stringify(n).slice(0, 160))}</span></div>`);
    await renderAiStatus();
  } catch (e) { toast(e.message, true); await renderAiStatus(); }
  b.textContent = old; b.disabled = false;
});

$('#btn-ai-run').addEventListener('click', async () => {
  const fid = $('#ai-field').value;
  if (!fid) return toast('Select a field first', true);
  const b = $('#btn-ai-run'); b.disabled = true;
  const old = b.innerHTML; b.textContent = 'Analysing…';
  try {
    const r = await api('/api/ai/field', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId: fid }),
    });
    renderAiReport(r.report, { latencyMs: r.latencyMs, aiError: r.aiError });
    if (r.aiError) toast(`AI unavailable (${r.aiError}) — report built from the local model`, true);
    else toast(`${fid} analysed by ${r.source} in ${r.latencyMs} ms`);
    await refreshFields();
    await selectField(fid, { quiet: true });
    renderAi();
  } catch (e) { toast(e.message, true); }
  b.innerHTML = old; b.disabled = false;
});

$('#btn-ai-report').addEventListener('click', async () => {
  const fid = $('#ai-field').value;
  if (!fid) return toast('Select a field first', true);
  try {
    const r = await api(`/api/fields/${fid}/report`);
    renderAiReport(r);
    toast(`Cached report for ${fid} — no model call made`);
  } catch (e) { toast(e.message, true); }
});

$('#btn-ai-copy').addEventListener('click', () => copyText(AI_CONTRACT_TEXT, () => toast('Integration contract copied')));

/* ----------------------------------- boot ----------------------------------- */
(async function boot() {
  wireUpload();
  connectSSE();
  renderApplications();
  $('#ai-contract').innerHTML = esc(AI_CONTRACT_TEXT)
    .replace(/&quot;/g, '"')
    .replace(/^(\/\/[A-Z ]+$)/gm, '<b>$1</b>');
  $('#ai-id-contract').textContent = AI_IDENTIFY_CONTRACT_TEXT;
  try {
    const cv = await api('/api/cv-status');
    $('#st-opencv span').textContent = `CV ${cv.mode.toUpperCase()}`;
    $('#st-opencv').className = 'stat ' + (cv.opencv ? 'ok' : 'warn');
  } catch {}
  await refreshFields();
  await loadLocation();
  await refreshModels();
  await renderAiStatus();
  loadIdentifyHistory();
  state.sensors = await api('/api/sensors').catch(() => []);
  await loadSites();
  renderSensors();
  fillDeviceTypes();
})();
