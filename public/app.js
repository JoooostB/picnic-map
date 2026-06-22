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

  await refresh();
  pollLoop();
}

function pc4Of(f) {
  return String(f.properties?.postcode ?? f.id ?? '').padStart(4, '0');
}
function toContainer(e) {
  return { containerPoint: map.latLngToContainerPoint(e.latlng) };
}

// ---- Live updates ----------------------------------------------------------
async function refresh() {
  const [cov, status] = await Promise.all([
    fetch('/api/coverage').then((r) => r.json()),
    fetch('/api/status').then((r) => r.json()),
  ]);

  // Restyle only the areas whose status changed since last poll.
  for (const [pc4, rec] of Object.entries(cov)) {
    const prev = coverage[pc4];
    if (!prev || prev.s !== rec.s) {
      const layer = layersByPc4[pc4];
      if (layer) layer.setStyle(STYLES[rec.s] || STYLES.pending);
    }
  }
  coverage = cov;
  updateStats(status);
}

function updateStats(s) {
  const c = s.counts || {};
  const covered = c.covered || 0;
  const waitlist = c.waitlist || 0;
  const none = (c.not_found || 0) + (c.invalid || 0) + (c.nodata || 0) + (c.error || 0);
  const total = s.total || 0;
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

  const done = s.done || 0;
  document.getElementById('progressCount').textContent =
    `${done.toLocaleString()} / ${total.toLocaleString()}`;
  document.getElementById('scanBar').style.width =
    total ? (done / total) * 100 + '%' : '0%';

  const progressEl = document.querySelector('.progress');
  const label = document.getElementById('progressLabel');
  if (s.cooldownMs > 0) {
    progressEl.classList.remove('done');
    label.textContent = `Rate-limited — resuming in ${Math.ceil(s.cooldownMs / 1000)}s…`;
  } else if (s.running) {
    progressEl.classList.remove('done');
    label.textContent = 'Scanning postcode areas…';
  } else {
    progressEl.classList.add('done');
    label.textContent = 'Scan complete';
  }

  const pt = s.postcodeTech || {};
  document.getElementById('budgetLabel').textContent =
    `postcode.tech: ${(pt.used || 0).toLocaleString()} / ${(pt.limit || 0).toLocaleString()} calls today`;
}

function pollLoop() {
  setInterval(refresh, 4000);
}

loadMap().catch((err) => {
  console.error(err);
  document.getElementById('progressLabel').textContent = 'Failed to load map: ' + err.message;
});
