/* ══════════════════════════ AREA ANALYSIS ══════════════════════════════════
 * The user finds their location (browser geolocation), marks the corners of
 * their field by clicking the Geo map, optionally enters soil lab results, and
 * gets real Sentinel-2 imagery for that polygon plus a wheat advisory. The chat
 * answers questions about the last analysis.
 *
 * Attaches to the Leaflet map created in app.js (global `state.map`). Nothing
 * here invents data: every number shown came back from /api/aoi/analyze.
 * ══════════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const MAX_POINTS = 50;
  const AOI = {
    points: [],        // [{lat, lng}]
    drawing: false,
    preview: null,     // polyline while drawing
    markers: [],
    polygon: null,     // the analysed polygon
    overlay: null,     // current Sentinel image overlay
    me: null,          // your location marker
    analysis: null,
    aoiId: null,
    busy: false,
  };
  // app.js's map-click handler checks this so a drawing click does not also reverse-geocode.
  window.aoiDrawing = () => AOI.drawing;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $q = (s) => document.querySelector(s);

  /* ------------------------------ Card markup ------------------------------ */
  const SOIL_FIELDS = [
    ['ph', 'Soil pH', '6.8'],
    ['zincDtpaPpm', 'Zinc, DTPA (mg/kg)', '0.45'],
    ['olsenPPm', 'Phosphorus, Olsen (mg/kg)', '12'],
    ['exchangeableKPm', 'Potassium, exch. (mg/kg)', '120'],
    ['nitrogenKgHa', 'Mineral N (kg/ha)', '40'],
    ['organicCarbonPct', 'Organic carbon (%)', '1.2'],
  ];

  function buildCard() {
    const card = document.createElement('div');
    card.className = 'card reveal aoi-card';
    card.id = 'aoi-card';
    card.innerHTML = `
      <div class="card-h spread">
        <div><h2>Area analysis — your field</h2>
          <p class="card-sub">Mark the corners of your field on the map. We read real Sentinel-2 satellite pixels inside them, then give a wheat advisory from the imagery, live weather and any soil test you enter.</p></div>
      </div>
      <div class="aoi-tools">
        <button class="btn sm" type="button" id="aoi-locate">Locate me</button>
        <button class="btn sm primary" type="button" id="aoi-draw">Start drawing</button>
        <button class="btn sm" type="button" id="aoi-undo">Undo point</button>
        <button class="btn sm" type="button" id="aoi-clear">Clear</button>
        <button class="btn sm primary" type="button" id="aoi-analyse" disabled>Analyse area</button>
      </div>
      <p class="note" id="aoi-hint">Press <b>Locate me</b> to centre the map on your position, then <b>Start drawing</b> and click each corner of your field (at least 3).</p>
      <details class="aoi-soil" id="aoi-soil-box">
        <summary>Soil test results (optional, from a lab)</summary>
        <div class="aoi-soil-grid">
          ${SOIL_FIELDS.map(([k, label, ph]) => `<label class="aoi-soil-field"><span>${esc(label)}</span><input type="number" step="any" min="0" id="aoi-soil-${k}" placeholder="${esc(ph)}" /></label>`).join('')}
        </div>
        <p class="note">Zinc and nutrient levels can only come from a soil test. Leave a value blank if you do not have it.</p>
      </details>
      <p class="note aoi-status" id="aoi-status" hidden></p>
      <div id="aoi-results" hidden>
        <div class="aoi-stats" id="aoi-stats"></div>
        <div class="layer-bar" id="aoi-layers">
          <button class="layer-chip on" type="button" data-aoi-layer="true">Satellite colour</button>
          <button class="layer-chip" type="button" data-aoi-layer="ndvi">Plant health (NDVI)</button>
          <button class="layer-chip" type="button" data-aoi-layer="off">Hide imagery</button>
        </div>
        <div class="aoi-weather" id="aoi-weather"></div>
        <h3 class="aoi-h">Advice for this area</h3>
        <div id="aoi-advice"></div>
        <div id="aoi-unknowns"></div>
        <p class="credit" id="aoi-credit"></p>
      </div>
      <div class="aoi-chat" id="aoi-chat" hidden>
        <h3 class="aoi-h">Ask about this area</h3>
        <div class="aoi-log" id="aoi-log" aria-live="polite"></div>
        <form class="aoi-chat-form" id="aoi-chat-form">
          <input id="aoi-chat-input" type="text" maxlength="1000" placeholder="e.g. What fertilizer should I apply?" autocomplete="off" aria-label="Ask about this area" />
          <button class="btn sm primary" type="submit">Send</button>
        </form>
      </div>`;
    return card;
  }

  /* ------------------------------ Map drawing ------------------------------ */
  function redrawPreview() {
    if (AOI.preview) { state.map.removeLayer(AOI.preview); AOI.preview = null; }
    if (AOI.points.length >= 2) {
      const ll = AOI.points.map((p) => [p.lat, p.lng]);
      AOI.preview = L.polyline(ll, { color: '#c6ff3d', weight: 2, dashArray: '6 4' }).addTo(state.map);
    }
    AOI.markers.forEach((m) => state.map.removeLayer(m));
    AOI.markers = AOI.points.map((p, i) => L.circleMarker([p.lat, p.lng], {
      radius: 5, color: '#c6ff3d', weight: 2, fillColor: '#0b0d0a', fillOpacity: 1,
    }).bindTooltip(`Corner ${i + 1}`).addTo(state.map));
    $q('#aoi-analyse').disabled = AOI.points.length < 3 || AOI.busy;
  }

  function addPoint(latlng) {
    if (AOI.points.length >= MAX_POINTS) return setHint(`That is the ${MAX_POINTS}-corner limit. Analyse the area or clear and start again.`);
    AOI.points.push({ lat: latlng.lat, lng: latlng.lng });
    redrawPreview();
    setHint(`${AOI.points.length} corner${AOI.points.length === 1 ? '' : 's'} marked${AOI.points.length < 3 ? ' — at least 3 are needed' : '. Click more corners, or press Analyse area.'}`);
  }

  function setDrawing(on) {
    AOI.drawing = on;
    $q('#aoi-draw').textContent = on ? 'Stop drawing' : 'Start drawing';
    $q('#aoi-draw').classList.toggle('primary', !on);
    state.map.getContainer().style.cursor = on ? 'crosshair' : '';
    if (on) setHint('Click each corner of your field on the map, going around its edge.');
  }

  function clearArea() {
    AOI.points = [];
    AOI.analysis = null;
    AOI.aoiId = null;
    redrawPreview();
    if (AOI.polygon) { state.map.removeLayer(AOI.polygon); AOI.polygon = null; }
    if (AOI.overlay) { state.map.removeLayer(AOI.overlay); AOI.overlay = null; }
    $q('#aoi-results').hidden = true;
    $q('#aoi-chat').hidden = true;
    setStatus('');
    setHint('Area cleared. Start drawing to mark a new field.');
  }

  /* ------------------------------ Geolocation ------------------------------ */
  function locate() {
    if (!navigator.geolocation) return setHint('This browser has no location service. Mark the corners of your field on the map instead.');
    setHint('Finding your location… allow the browser prompt if it appears.');
    navigator.geolocation.getCurrentPosition((p) => {
      const ll = [p.coords.latitude, p.coords.longitude];
      if (!AOI.me) AOI.me = L.circleMarker(ll, { radius: 8, color: '#4aa3ff', weight: 2, fillColor: '#4aa3ff', fillOpacity: 0.6 }).bindTooltip('You are here').addTo(state.map);
      else AOI.me.setLatLng(ll);
      state.map.setView(ll, 17);
      setHint(`Located you at ${ll[0].toFixed(5)}, ${ll[1].toFixed(5)} (±${Math.round(p.coords.accuracy)} m). ${AOI.drawing ? 'Click the corners of your field.' : 'Press Start drawing, then click the corners of your field.'}`);
    }, (err) => {
      setHint(`Location unavailable (${err.message}). Use the map to find your field, then mark its corners.`);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  /* ------------------------------ Analysis ------------------------------ */
  function readSoil() {
    const soil = {};
    for (const [k] of SOIL_FIELDS) {
      const v = $q(`#aoi-soil-${k}`).value;
      if (v !== '' && Number.isFinite(Number(v))) soil[k] = Number(v);
    }
    return Object.keys(soil).length ? soil : null;
  }

  function setStatus(text, kind) {
    const el = $q('#aoi-status');
    el.textContent = text || '';
    el.hidden = !text;
    el.className = `note aoi-status${kind ? ` ${kind}` : ''}`;
  }
  function setHint(text) { const el = $q('#aoi-hint'); if (el) el.textContent = text; }

  function setBusy(on) {
    AOI.busy = on;
    for (const id of ['#aoi-analyse', '#aoi-draw', '#aoi-undo', '#aoi-clear', '#aoi-locate']) $q(id).disabled = on;
    if (!on) $q('#aoi-analyse').disabled = AOI.points.length < 3;
  }

  async function analyse() {
    if (AOI.points.length < 3 || AOI.busy) return;
    if (AOI.drawing) setDrawing(false);
    setBusy(true);
    setStatus('Reading Sentinel-2 pixels inside your area. The first analysis of an area can take about a minute; repeat requests are instant.', 'busy');
    try {
      const r = await fetch('/api/aoi/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: AOI.points.map((p) => [p.lat, p.lng]), soil: readSoil() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      AOI.analysis = d;
      AOI.aoiId = d.id;
      renderResults(d);
      setStatus(d.cached ? 'Showing the stored analysis for this area.' : `Analysed from the ${(d.scene.datetime || '').slice(0, 10)} Sentinel-2 scene.`, 'ok');
    } catch (e) {
      setStatus(`Analysis failed: ${e.message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ Results ------------------------------ */
  function bboxOf(points) {
    const lats = points.map((p) => p.lat), lngs = points.map((p) => p.lng);
    return L.latLngBounds([Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]);
  }

  function showLayer(kind) {
    if (AOI.overlay) { state.map.removeLayer(AOI.overlay); AOI.overlay = null; }
    document.querySelectorAll('[data-aoi-layer]').forEach((b) => b.classList.toggle('on', b.dataset.aoiLayer === kind));
    if (kind === 'off' || !AOI.analysis) return;
    const url = kind === 'ndvi' ? AOI.analysis.images.ndvi : AOI.analysis.images.trueColour;
    AOI.overlay = L.imageOverlay(url, bboxOf(AOI.points), { opacity: 0.9, alt: `Sentinel-2 ${kind === 'ndvi' ? 'plant health' : 'true colour'} over your area` }).addTo(state.map);
  }

  const pct = (v) => (v == null ? '—' : `${v}%`);
  const sevLabel = { high: 'High', medium: 'Medium', low: 'Low', info: 'Note' };
  const srcLabel = { lab: 'From your soil test', satellite: 'From satellite', weather: 'From weather', rule: 'Advisory' };

  function renderResults(d) {
    // Polygon outline on the map, replacing the preview.
    if (AOI.preview) { state.map.removeLayer(AOI.preview); AOI.preview = null; }
    if (AOI.polygon) state.map.removeLayer(AOI.polygon);
    AOI.polygon = L.polygon(AOI.points.map((p) => [p.lat, p.lng]), { color: '#c6ff3d', weight: 2, fillOpacity: 0.05 }).addTo(state.map);
    showLayer('true');
    state.map.fitBounds(AOI.polygon.getBounds().pad(0.2));

    const ix = d.indices || {};
    const s = d.stats || {};
    $q('#aoi-stats').innerHTML = [
      ['Area', `${(d.areaM2 / 10000).toFixed(2)} ha`],
      ['Healthy canopy', pct(ix.healthyPct)],
      ['Stressed', pct(ix.stressedPct)],
      ['Bare ground', pct(ix.barePct)],
      ['Mean NDVI', ix.ndviMean == null ? '—' : ix.ndviMean.toFixed(2)],
      ['Scene', `${esc(d.scene?.datetime?.slice(0, 10) || '—')} · ${d.scene?.cloudCover == null ? '?' : Math.round(d.scene.cloudCover)}% cloud`],
    ].map(([k, v]) => `<div class="aoi-stat"><span class="aoi-stat-k">${esc(k)}</span><span class="aoi-stat-v">${esc(v)}</span></div>`).join('');

    const w = d.weather?.live || {};
    const f = d.weather?.forecast || {};
    const wx = [
      w.airTempC != null ? `${w.airTempC}°C now` : null,
      w.windKmh != null ? `wind ${Math.round(w.windKmh)} km/h` : null,
      f.rainNext7dMm != null ? `${f.rainNext7dMm} mm rain forecast (7 days)` : null,
      f.tempMinC != null ? `coldest night ${f.tempMinC}°C` : null,
    ].filter(Boolean);
    $q('#aoi-weather').textContent = wx.length ? `Weather here: ${wx.join(' · ')}` : 'Weather unavailable for this location right now.';

    const findings = d.advice?.findings || [];
    $q('#aoi-advice').innerHTML = findings.length
      ? findings.map((x) => `
          <div class="aoi-finding sev-${esc(x.severity)}">
            <div class="aoi-finding-h"><span class="aoi-badge">${esc(sevLabel[x.severity] || x.severity)}</span>
              <b>${esc(x.title)}</b> <span class="dim">· ${esc(srcLabel[x.source] || x.source)}</span></div>
            <p class="note">${esc(x.evidence || '')}</p>
            ${x.action ? `<p class="aoi-action">${esc(x.action)}</p>` : ''}
          </div>`).join('')
      : '<p class="note">No issue was raised for this area. Check again after the next satellite pass.</p>';

    const unk = d.advice?.unknowns || [];
    $q('#aoi-unknowns').innerHTML = unk.length
      ? `<h3 class="aoi-h">What satellite data cannot tell you</h3><ul class="aoi-unknowns">${unk.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>`
      : '';

    $q('#aoi-credit').textContent = 'Imagery: Copernicus Sentinel-2 L2A via Earth Search (AWS). Weather: Open-Meteo.com.';
    $q('#aoi-results').hidden = false;

    $q('#aoi-chat').hidden = false;
    $q('#aoi-log').innerHTML = '';
    appendChat('bot', `Analysed ${(d.areaM2 / 10000).toFixed(2)} ha. Ask me about zinc, fertilizer, the weather, or the crop.`, null);
    setHint('Area analysed. Use the layer buttons to compare the imagery, or ask the assistant below.');
  }

  /* ------------------------------ Chat ------------------------------ */
  function appendChat(who, text, mode) {
    const log = $q('#aoi-log');
    const div = document.createElement('div');
    div.className = `aoi-msg ${who}`;
    const body = document.createElement('div');
    body.className = 'aoi-msg-body';
    body.textContent = text;   // textContent: model output is never rendered as HTML
    div.appendChild(body);
    if (mode) {
      const tag = document.createElement('div');
      tag.className = 'aoi-msg-mode';
      tag.textContent = mode === 'llm' ? 'AI model' : 'Rule-based answer from this analysis (no chat model configured)';
      div.appendChild(tag);
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  async function sendChat(text) {
    if (!AOI.aoiId) return;
    appendChat('you', text, null);
    appendChat('bot', '…', null);
    const pending = $q('#aoi-log').lastElementChild;
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, aoiId: AOI.aoiId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      pending.remove();
      appendChat('bot', d.reply, d.mode);
    } catch (e) {
      pending.remove();
      appendChat('bot', `Could not answer: ${e.message}`, null);
    }
  }

  /* ------------------------------ Wiring ------------------------------ */
  function wire() {
    $q('#aoi-locate').addEventListener('click', locate);
    $q('#aoi-draw').addEventListener('click', () => setDrawing(!AOI.drawing));
    $q('#aoi-undo').addEventListener('click', () => { AOI.points.pop(); redrawPreview(); });
    $q('#aoi-clear').addEventListener('click', clearArea);
    $q('#aoi-analyse').addEventListener('click', analyse);
    $q('#aoi-results').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-aoi-layer]');
      if (b) showLayer(b.dataset.aoiLayer);
    });
    $q('#aoi-chat-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const input = $q('#aoi-chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendChat(text);
    });
    state.map.on('click', (ev) => { if (AOI.drawing) addPoint(ev.latlng); });
  }

  /* Build the card once, beside the Geo map, after app.js has created the map. */
  function start() {
    const geo = document.querySelector('.geo-layout');
    if (!geo || document.getElementById('aoi-card')) return;
    geo.after(buildCard());
    wire();
    locate();   // take the user's location on open, as they asked; a denied prompt just leaves the map where it is
  }

  function waitForMap(tries = 0) {
    if (typeof state !== 'undefined' && state.map && document.getElementById('aoi-card') === null) {
      try { start(); } catch (e) { console.warn('[aoi] could not start area tool:', e); }
      return;
    }
    if (tries < 200) setTimeout(() => waitForMap(tries + 1), 300);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => waitForMap());
  else waitForMap();
})();
