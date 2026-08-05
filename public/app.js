'use strict';

// ---- Coverage status -> visual style -------------------------------------
const STYLES = {
  covered:   { color: '#e5010b', fillColor: '#e5010b', fillOpacity: 0.78, weight: 0.4 },
  waitlist:  { color: '#ff9f1c', fillColor: '#ff9f1c', fillOpacity: 0.62, weight: 0.4 },
  not_found: { color: '#c7ccd6', fillColor: '#c7ccd6', fillOpacity: 0.30, weight: 0.3 },
  invalid:   { color: '#c7ccd6', fillColor: '#c7ccd6', fillOpacity: 0.30, weight: 0.3 },
  nodata:    { color: '#c7ccd6', fillColor: '#c7ccd6', fillOpacity: 0.30, weight: 0.3 },
  error:     { color: '#c7ccd6', fillColor: '#c7ccd6', fillOpacity: 0.20, weight: 0.3 },
  pending:   { color: '#aab2c0', fillColor: '#e9ecf2', fillOpacity: 0.18, weight: 0.3 },
  // PC6 refinement showed this PC4 is a mix of served and not-served postcodes.
  partial:   { color: '#e5010b', fillColor: 'url(#partialStripes)', fillOpacity: 0.72, weight: 0.5 },
};

const STATUS_TEXT = {
  covered: ['Delivers here', 'st-covered'],
  waitlist: ['Waitlist · coming soon', 'st-waitlist'],
  not_found: ['No service', 'st-none'],
  invalid: ['No service', 'st-none'],
  nodata: ['Unknown', 'st-none'],
  error: ['Unknown', 'st-none'],
  pending: ['Not checked yet', 'st-pending'],
};

const layersByPc4 = {};
let coverage = {}; // pc4 -> { s, city, municipality, province, postcode, pc6?: {c,w,n,t} }

// A PC4 is "partial" when its probed PC6s disagree: some served, some not.
function isPartial(rec) {
  if (!rec || !rec.pc6) return false;
  const { c = 0, w = 0, n = 0 } = rec.pc6;
  return c > 0 && w + n > 0;
}

function effKey(rec) {
  if (!rec) return 'pending';
  return isPartial(rec) ? 'partial' : rec.s;
}

// The striped "partial" fill is an SVG pattern that must live inside Leaflet's
// own overlay SVG (url() references don't cross SVG documents).
function ensureStripePattern() {
  const svg = document.querySelector('#map .leaflet-overlay-pane svg');
  if (!svg || svg.querySelector('#partialStripes')) return;
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML =
    '<pattern id="partialStripes" patternUnits="userSpaceOnUse" width="12" height="12" patternTransform="rotate(45)">' +
    '<rect width="12" height="12" fill="#e5010b"></rect>' +
    '<rect width="5" height="12" fill="#ff9f1c"></rect></pattern>';
  svg.insertBefore(defs, svg.firstChild);
}

// ---- Map -------------------------------------------------------------------
const map = L.map('map', {
  center: [52.15, 5.3],
  zoom: 8,
  minZoom: 7,
  maxZoom: 13,
  zoomControl: true,
  attributionControl: true,
}).setView([52.15, 5.3], 8);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);

// Labels on top so place names sit above the choropleth.
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd', maxZoom: 19, pane: 'shadowPane',
}).addTo(map);

// How much of a PC4's postcodes have a PC6 result yet (0..1). Refinement runs
// sample-first, so an area can be flagged "partial" off a handful of probes.
function refinedFraction(rec) {
  const a = rec && rec.pc6;
  if (!a || !a.t) return 0;
  return Math.min(1, ((a.c || 0) + (a.w || 0) + (a.n || 0)) / a.t);
}

function styleFor(pc4) {
  const rec = coverage[pc4];
  const base = STYLES[effKey(rec)] || STYLES.pending;
  // While the PC6 detail tiles are on screen, dim the PC4 base so per-postcode
  // colours read on top. Never fade it out entirely: CBS PC6 polygons only
  // cover addressed land, so the rural remainder of an area would punch
  // through as a hole. Dim further as more of the area gets refined.
  if (detailShown.has(pc4)) {
    return { ...base, fillOpacity: base.fillOpacity * (1 - refinedFraction(rec) * 0.55) };
  }
  return base;
}

// ---- Hover card ------------------------------------------------------------
const hovercard = document.getElementById('hovercard');
function placeFor(pc4) {
  const rec = coverage[pc4];
  return rec && (rec.city || rec.municipality)
    ? [rec.city, rec.province].filter(Boolean).join(' · ')
    : 'Netherlands';
}
function renderHover(title, place, label, cls, e) {
  document.getElementById('hcPc4').textContent = title;
  document.getElementById('hcPlace').textContent = place;
  const st = document.getElementById('hcStatus');
  st.textContent = label;
  st.className = 'hovercard__status ' + cls;
  hovercard.hidden = false;
  const pt = e.containerPoint;
  hovercard.style.left = pt.x + 'px';
  hovercard.style.top = pt.y + 'px';
}
function showHover(pc4, e) {
  const rec = coverage[pc4];
  let label, cls;
  if (isPartial(rec)) {
    const { c = 0, w = 0, n = 0 } = rec.pc6;
    label = `Partially covered · ${c}/${c + w + n} postcodes`;
    cls = 'st-partial';
  } else {
    [label, cls] = STATUS_TEXT[rec ? rec.s : 'pending'] || STATUS_TEXT.pending;
  }
  renderHover(pc4, placeFor(pc4), label, cls, e);
}
// Hover for one full postcode inside an expanded PC6 detail view.
function showHover6(pc4, pc6, e) {
  const det = pc6Detail[pc4];
  const s = det && det.cov[pc6] ? det.cov[pc6].s : 'pending';
  const [label, cls] = STATUS_TEXT[s] || STATUS_TEXT.pending;
  renderHover(pc6, placeFor(pc4), label, cls, e);
}
function hideHover() { hovercard.hidden = true; }

// ---- Load polygons ---------------------------------------------------------
async function loadMap() {
  const fc = await fetch('/api/geojson').then((r) => r.json());

  L.geoJSON(fc, {
    style: (f) => styleFor(pc4Of(f)),
    onEachFeature: (f, layer) => {
      const pc4 = pc4Of(f);
      layersByPc4[pc4] = layer;
      layer.on('mouseover', (e) => {
        layer.setStyle({ weight: 1.6, color: '#1a1d24' });
        // Never raise the PC4 above its own PC6 detail tiles.
        if (!detailShown.has(pc4)) layer.bringToFront();
        showHover(pc4, e.originalEvent ? toContainer(e) : e);
      });
      layer.on('mousemove', (e) => showHover(pc4, toContainer(e)));
      layer.on('mouseout', () => {
        layer.setStyle(styleFor(pc4));
        hideHover();
      });
    },
  }).addTo(map);
  ensureStripePattern();
  map.on('moveend', syncPc6Detail);

  // First paint + live updates via SSE (falls back to polling if unsupported).
  if (window.EventSource) streamStart();
  else pollFallback();
  // Keep the cooldown countdown ticking smoothly every second, locally.
  setInterval(renderProgress, 1000);
}

function pc4Of(f) {
  return String(f.properties?.postcode ?? f.id ?? '').padStart(4, '0');
}
function toContainer(e) {
  return { containerPoint: map.latLngToContainerPoint(e.latlng) };
}

// ---- PC6 detail layer ------------------------------------------------------
// Refined areas expand into real PC6 polygons when zoomed in. Loaded lazily
// per PC4 for the current viewport; a small cache keeps recent areas around.
const PC6_MIN_ZOOM = 11;
const PC6_CACHE_MAX = 48;
const pc6Detail = {}; // pc4 -> { group, cov: {pc6: {s}}, byPc6, shownAt }
const detailShown = new Set(); // pc4s whose detail group is on the map
const pc6Loading = new Set();

function pc6StyleFor(pc4, pc6) {
  const det = pc6Detail[pc4];
  const s = det && det.cov[pc6] ? det.cov[pc6].s : 'pending';
  if (s === 'pending') {
    // Unprobed PC6: transparent fill so the faded PC4 base shows through,
    // but still painted so it catches hover.
    return { color: '#aab2c0', weight: 0.5, fillColor: '#ffffff', fillOpacity: 0 };
  }
  return { ...(STYLES[s] || STYLES.pending), weight: 0.7 };
}

// Polygon bounds never change, but getBounds() walks every ring — cache it so
// panning doesn't recompute for thousands of areas.
const boundsCache = {};
function boundsOf(pc4) {
  return (boundsCache[pc4] ||= layersByPc4[pc4].getBounds());
}

function syncPc6Detail() {
  if (map.getZoom() < PC6_MIN_ZOOM) {
    for (const pc4 of [...detailShown]) hideDetail(pc4);
    return;
  }
  const view = map.getBounds();
  for (const pc4 of Object.keys(layersByPc4)) {
    const rec = coverage[pc4];
    // Cheap checks first: only refined areas ever need a bounds test.
    if (rec && rec.pc6 && view.intersects(boundsOf(pc4))) showDetail(pc4);
    else hideDetail(pc4);
  }
}

async function showDetail(pc4) {
  const det = pc6Detail[pc4];
  if (det) {
    det.shownAt = Date.now();
    if (!detailShown.has(pc4)) {
      det.group.addTo(map);
      detailShown.add(pc4);
      restyle(pc4);
    }
    return;
  }
  if (pc6Loading.has(pc4)) return;
  pc6Loading.add(pc4);
  try {
    const [geo, cov] = await Promise.all([
      fetch(`/api/geojson6/${pc4}`).then((r) => r.json()),
      fetch(`/api/coverage6/${pc4}`).then((r) => r.json()),
    ]);
    const byPc6 = {};
    // Register before constructing: the style callback reads pc6Detail[pc4].
    const entry = { group: null, cov, byPc6, shownAt: Date.now() };
    pc6Detail[pc4] = entry;
    entry.group = L.geoJSON(geo, {
      style: (f) => pc6StyleFor(pc4, f.properties.pc6),
      onEachFeature: (f, lyr) => {
        const pc6 = f.properties.pc6;
        byPc6[pc6] = lyr;
        lyr.on('mouseover', (e) => {
          lyr.setStyle({ weight: 1.8, color: '#1a1d24' });
          lyr.bringToFront();
          showHover6(pc4, pc6, e.originalEvent ? toContainer(e) : e);
        });
        lyr.on('mousemove', (e) => showHover6(pc4, pc6, toContainer(e)));
        lyr.on('mouseout', () => {
          lyr.setStyle(pc6StyleFor(pc4, pc6));
          hideHover();
        });
      },
    });
    prunePc6Cache();
    // Re-check — the user may have panned or zoomed away during the fetch.
    if (map.getZoom() >= PC6_MIN_ZOOM && map.getBounds().intersects(layersByPc4[pc4].getBounds())) {
      entry.group.addTo(map);
      detailShown.add(pc4);
      restyle(pc4);
    }
  } catch (err) {
    delete pc6Detail[pc4];
    console.error('PC6 detail failed for', pc4, err);
  } finally {
    pc6Loading.delete(pc4);
  }
}

function hideDetail(pc4) {
  if (!detailShown.has(pc4)) return;
  const det = pc6Detail[pc4];
  if (det) map.removeLayer(det.group);
  detailShown.delete(pc4);
  restyle(pc4);
}

function prunePc6Cache() {
  const cached = Object.keys(pc6Detail);
  if (cached.length <= PC6_CACHE_MAX) return;
  cached
    .filter((pc4) => !detailShown.has(pc4) && !pc6Loading.has(pc4))
    .sort((a, b) => pc6Detail[a].shownAt - pc6Detail[b].shownAt)
    .slice(0, cached.length - PC6_CACHE_MAX)
    .forEach((pc4) => delete pc6Detail[pc4]);
}

// ---- Live updates ----------------------------------------------------------
let lastStatus = {};
// Track cooldown as (remaining-at-receipt, received-at) so we can count down
// locally without depending on server/client clock skew.
let cooldown = { ms: 0, at: 0 };
function setCooldown(ms) {
  cooldown = { ms: ms || 0, at: Date.now() };
}
function tickedCooldown() {
  return Math.max(0, cooldown.ms - (Date.now() - cooldown.at));
}

function restyle(pc4) {
  const layer = layersByPc4[pc4];
  if (layer) layer.setStyle(styleFor(pc4));
}

// Apply a single live update. PC4 deltas carry {pc4, s, city, ...}; PC6 deltas
// carry {pc6, pc4, s, agg} where agg is the area's updated {c,w,n,t} tally.
function applyCoverageDelta(d) {
  if (d.pc6) {
    const rec = coverage[d.pc4] || (coverage[d.pc4] = { s: 'pending' });
    const isFirst = !rec.pc6; // area just became refined
    rec.pc6 = d.agg;
    restyle(d.pc4);
    const det = pc6Detail[d.pc4];
    if (det) {
      det.cov[d.pc6] = { s: d.s };
      const lyr = det.byPc6[d.pc6];
      if (lyr) lyr.setStyle(pc6StyleFor(d.pc4, d.pc6));
    }
    // Newly refined areas become eligible for the detail layer right away,
    // without waiting for the next pan or snapshot.
    if (isFirst) syncPc6Detail();
    renderCounts();
    return;
  }
  const prev = coverage[d.pc4];
  coverage[d.pc4] = { ...d, pc6: prev && prev.pc6 }; // keep the PC6 tally
  if (!prev || effKey(prev) !== effKey(coverage[d.pc4])) restyle(d.pc4);
  renderCounts();
}

// Apply a full snapshot (on (re)connect or polling tick).
function applySnapshot(cov, status) {
  const changed = [];
  for (const [pc4, rec] of Object.entries(cov)) {
    if (effKey(coverage[pc4]) !== effKey(rec)) changed.push(pc4);
  }
  coverage = cov;
  for (const pc4 of changed) restyle(pc4);
  if (status) onStatus(status);
  else { renderCounts(); renderProgress(); }
  syncPc6Detail(); // newly refined areas may now qualify for detail
}

function onStatus(status) {
  lastStatus = status;
  setCooldown(status.cooldownMs);
  renderCounts();
  renderProgress();
}

// Counts are derived from the coverage map the client already holds.
function renderCounts() {
  let covered = 0, waitlist = 0, none = 0, partial = 0;
  for (const v of Object.values(coverage)) {
    if (isPartial(v)) partial++;
    else if (v.s === 'covered') covered++;
    else if (v.s === 'waitlist') waitlist++;
    else none++; // not_found / invalid / nodata / error
  }
  const total = lastStatus.total || 0;
  const pending = Math.max(0, total - covered - waitlist - none - partial);

  // "Served" share is among areas where we got a definitive Picnic answer;
  // partially covered areas count as served (Picnic delivers to part of them).
  const decided = covered + partial + waitlist;
  const pct = decided ? Math.round(((covered + partial) / decided) * 100) : 0;

  document.getElementById('coveredPct').textContent = decided ? pct + '%' : '—';
  document.getElementById('coveredBar').style.width = pct + '%';
  document.getElementById('cntCovered').textContent = covered.toLocaleString();
  document.getElementById('cntPartial').textContent = partial.toLocaleString();
  document.getElementById('cntWaitlist').textContent = waitlist.toLocaleString();
  document.getElementById('cntNone').textContent = none.toLocaleString();
  document.getElementById('cntPending').textContent = pending.toLocaleString();
}

// Progress bar, live cooldown countdown, and API budget.
function renderProgress() {
  const total = lastStatus.total || 0;
  const done = Object.keys(coverage).length; // areas with a result, live
  document.getElementById('progressCount').textContent =
    `${done.toLocaleString()} / ${total.toLocaleString()}`;
  document.getElementById('scanBar').style.width = total ? (done / total) * 100 + '%' : '0%';

  const progressEl = document.querySelector('.progress');
  const label = document.getElementById('progressLabel');
  const remaining = tickedCooldown();
  const probers = lastStatus.probers || 0;
  const proberTag = probers > 1 ? ` · ${probers} probers` : '';
  const pc6 = lastStatus.pc6 || {};
  if (remaining > 0) {
    progressEl.classList.remove('done');
    label.textContent = `Rate-limited — resuming in ${Math.ceil(remaining / 1000)}s…`;
  } else if (lastStatus.running && total && done >= total && pc6.enabled && pc6.queued > 0) {
    progressEl.classList.remove('done');
    label.textContent = `Refining at full-postcode detail…${proberTag}`;
  } else if (lastStatus.running) {
    progressEl.classList.remove('done');
    label.textContent = `Scanning postcode areas…${proberTag}`;
  } else if (total && done >= total) {
    progressEl.classList.add('done');
    label.textContent = 'Scan complete';
  } else if (total) {
    progressEl.classList.remove('done');
    label.textContent = 'Waiting for a prober…';
  }

  const pt = lastStatus.postcodeTech || {};
  document.getElementById('budgetLabel').textContent =
    `postcode.tech: ${(pt.used || 0).toLocaleString()} / ${(pt.limit || 0).toLocaleString()} calls today`;

  const pc6Label = document.getElementById('pc6Label');
  if (pc6.enabled && (pc6.refined > 0 || pc6.queued > 0)) {
    pc6Label.textContent =
      `PC6 detail: ${(pc6.refined || 0).toLocaleString()} checked · ${(pc6.queued || 0).toLocaleString()} queued`;
  } else {
    pc6Label.textContent = '';
  }
}

// Live stream — push updates as the prober works.
function streamStart() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => {
    const m = JSON.parse(e.data);
    applySnapshot(m.coverage, m.status);
  });
  es.addEventListener('coverage', (e) => applyCoverageDelta(JSON.parse(e.data)));
  es.addEventListener('status', (e) => onStatus(JSON.parse(e.data)));
  // EventSource auto-reconnects on a dropped connection; nothing to do on error.
}

// Fallback for browsers without EventSource.
function pollFallback() {
  const tickPoll = async () => {
    try {
      const [cov, status] = await Promise.all([
        fetch('/api/coverage').then((r) => r.json()),
        fetch('/api/status').then((r) => r.json()),
      ]);
      applySnapshot(cov, status);
    } catch (err) {
      console.error(err);
    }
  };
  tickPoll();
  setInterval(tickPoll, 4000);
}

loadMap().catch((err) => {
  console.error(err);
  document.getElementById('progressLabel').textContent = 'Failed to load map: ' + err.message;
});
