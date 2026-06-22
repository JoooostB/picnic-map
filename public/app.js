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
let coverage = {}; // pc4 -> { s, city, municipality, province, postcode }

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

function styleFor(pc4) {
  const rec = coverage[pc4];
  return STYLES[rec ? rec.s : 'pending'] || STYLES.pending;
}

// ---- Hover card ------------------------------------------------------------
const hovercard = document.getElementById('hovercard');
function showHover(pc4, e) {
  const rec = coverage[pc4];
  const status = rec ? rec.s : 'pending';
  const [label, cls] = STATUS_TEXT[status] || STATUS_TEXT.pending;
  document.getElementById('hcPc4').textContent = pc4;
  const place = rec && (rec.city || rec.municipality)
    ? [rec.city, rec.province].filter(Boolean).join(' · ')
    : 'Netherlands';
  document.getElementById('hcPlace').textContent = place;
  const st = document.getElementById('hcStatus');
  st.textContent = label;
  st.className = 'hovercard__status ' + cls;
  hovercard.hidden = false;
  const pt = e.containerPoint;
  hovercard.style.left = pt.x + 'px';
  hovercard.style.top = pt.y + 'px';
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
        layer.bringToFront();
        showHover(pc4, e.originalEvent ? toContainer(e) : e);
      });
      layer.on('mousemove', (e) => showHover(pc4, toContainer(e)));
      layer.on('mouseout', () => {
        layer.setStyle(styleFor(pc4));
        hideHover();
      });
    },
  }).addTo(map);

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

function restyle(pc4, s) {
  const layer = layersByPc4[pc4];
  if (layer) layer.setStyle(STYLES[s] || STYLES.pending);
}

// Apply a single live area update (the prober just probed this PC4).
function applyCoverageDelta(d) {
  const prev = coverage[d.pc4];
  coverage[d.pc4] = d;
  if (!prev || prev.s !== d.s) restyle(d.pc4, d.s);
  renderCounts();
}

// Apply a full snapshot (on (re)connect or polling tick).
function applySnapshot(cov, status) {
  for (const [pc4, rec] of Object.entries(cov)) {
    const prev = coverage[pc4];
    if (!prev || prev.s !== rec.s) restyle(pc4, rec.s);
  }
  coverage = cov;
  if (status) onStatus(status);
  else { renderCounts(); renderProgress(); }
}

function onStatus(status) {
  lastStatus = status;
  setCooldown(status.cooldownMs);
  renderCounts();
  renderProgress();
}

// Counts are derived from the coverage map the client already holds.
function renderCounts() {
  let covered = 0, waitlist = 0, none = 0;
  for (const v of Object.values(coverage)) {
    if (v.s === 'covered') covered++;
    else if (v.s === 'waitlist') waitlist++;
    else none++; // not_found / invalid / nodata / error
  }
  const total = lastStatus.total || 0;
  const pending = Math.max(0, total - covered - waitlist - none);

  // "Served" share is among areas where we got a definitive Picnic answer.
  const decided = covered + waitlist;
  const pct = decided ? Math.round((covered / decided) * 100) : 0;

  document.getElementById('coveredPct').textContent = decided ? pct + '%' : '—';
  document.getElementById('coveredBar').style.width = pct + '%';
  document.getElementById('cntCovered').textContent = covered.toLocaleString();
  document.getElementById('cntWaitlist').textContent = waitlist.toLocaleString();
  document.getElementById('cntNone').textContent = none.toLocaleString();
  document.getElementById('cntPending').textContent = pending.toLocaleString();
}

// Progress bar, live cooldown countdown, and API budget.
function renderProgress() {
  const total = lastStatus.total || 0;
  const done = lastStatus.done || 0;
  document.getElementById('progressCount').textContent =
    `${done.toLocaleString()} / ${total.toLocaleString()}`;
  document.getElementById('scanBar').style.width = total ? (done / total) * 100 + '%' : '0%';

  const progressEl = document.querySelector('.progress');
  const label = document.getElementById('progressLabel');
  const remaining = tickedCooldown();
  if (remaining > 0) {
    progressEl.classList.remove('done');
    label.textContent = `Rate-limited — resuming in ${Math.ceil(remaining / 1000)}s…`;
  } else if (lastStatus.running) {
    progressEl.classList.remove('done');
    label.textContent = 'Scanning postcode areas…';
  } else if (lastStatus.total) {
    progressEl.classList.add('done');
    label.textContent = 'Scan complete';
  }

  const pt = lastStatus.postcodeTech || {};
  document.getElementById('budgetLabel').textContent =
    `postcode.tech: ${(pt.used || 0).toLocaleString()} / ${(pt.limit || 0).toLocaleString()} calls today`;
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
