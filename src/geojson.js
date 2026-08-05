import fs from 'fs/promises';
import path from 'path';
import { config, keys } from './config.js';
import { redis } from './redisClient.js';
import { fetchJson } from './sources.js';

const DATA_FILE = path.resolve('data', 'pc4.geojson');

let memo = null; // in-memory cache of the parsed FeatureCollection

/**
 * Load the PC4 polygon GeoJSON. Resolution order: memory -> local file ->
 * Redis -> download from cartomap (then persist to both file and Redis).
 */
export async function loadGeojson() {
  if (memo) return memo;

  // Local file cache (survives container rebuilds via the mounted ./data volume)
  try {
    const txt = await fs.readFile(DATA_FILE, 'utf8');
    memo = JSON.parse(txt);
    console.log(`[geojson] loaded ${memo.features.length} PC4 areas from disk`);
    return memo;
  } catch {
    /* not on disk yet */
  }

  // Redis cache
  const cached = await redis.get(keys.geojson);
  if (cached) {
    memo = JSON.parse(cached);
    await fs.writeFile(DATA_FILE, cached).catch(() => {});
    console.log(`[geojson] loaded ${memo.features.length} PC4 areas from Redis`);
    return memo;
  }

  // Download
  console.log('[geojson] downloading PC4 polygons from cartomap…');
  const res = await fetch(config.pc4GeojsonUrl);
  if (!res.ok) throw new Error(`Failed to download GeoJSON: HTTP ${res.status}`);
  const txt = await res.text();
  memo = JSON.parse(txt);
  await redis.set(keys.geojson, txt);
  await fs.writeFile(DATA_FILE, txt).catch(() => {});
  console.log(`[geojson] downloaded ${memo.features.length} PC4 areas`);
  return memo;
}

/** Sorted list of unique 4-digit postcode codes (as strings) present in the map. */
export async function listPc4Codes() {
  const fc = await loadGeojson();
  const set = new Set();
  for (const f of fc.features) {
    const code = String(f.properties?.postcode ?? f.id ?? '').padStart(4, '0');
    if (/^\d{4}$/.test(code)) set.add(code);
  }
  return [...set].sort();
}

// ---- PC6 polygons (CBS via PDOK WFS) ---------------------------------------

// Small in-memory cache of recently used PC6 FeatureCollections; each is
// ~250KB slimmed, so keep the footprint bounded and let Redis hold the rest.
const PC6_MEMO_MAX = 30;
const pc6Memo = new Map(); // pc4 -> FeatureCollection (insertion order = LRU)

function pc6MemoPut(pc4, fc) {
  pc6Memo.delete(pc4);
  pc6Memo.set(pc4, fc);
  while (pc6Memo.size > PC6_MEMO_MAX) pc6Memo.delete(pc6Memo.keys().next().value);
}

// Fetch every CBS PC6 polygon whose postcode starts with `pc4`, in WGS84.
// Paginated as a safety net, though no PC4 holds more than one page.
async function fetchPc6FeaturesFromWfs(pc4) {
  const pageSize = 1000;
  const filter =
    '<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0">' +
    '<fes:PropertyIsLike wildCard="*" singleChar="." escapeChar="!">' +
    '<fes:ValueReference>postcode6</fes:ValueReference>' +
    `<fes:Literal>${pc4}*</fes:Literal>` +
    '</fes:PropertyIsLike></fes:Filter>';
  const features = [];
  for (let start = 0; ; start += pageSize) {
    const url =
      `${config.pc6WfsUrl}?service=WFS&version=2.0.0&request=GetFeature` +
      '&typeNames=postcode6:postcode6&outputFormat=application/json' +
      `&srsName=urn:ogc:def:crs:EPSG::4326&count=${pageSize}&startIndex=${start}` +
      `&FILTER=${encodeURIComponent(filter)}`;
    const { status, body } = await fetchJson(url);
    if (status !== 200 || !Array.isArray(body?.features)) {
      throw new Error(`PC6 WFS returned HTTP ${status}`);
    }
    // Slim: drop the CBS statistics, keep only the postcode + geometry.
    for (const f of body.features) {
      const pc6 = f?.properties?.postcode6;
      if (pc6 && f.geometry) {
        features.push({ type: 'Feature', properties: { pc6 }, geometry: f.geometry });
      }
    }
    if (body.features.length < pageSize) break;
  }
  return features;
}

/**
 * PC6 polygon FeatureCollection for one PC4 area (memory -> Redis -> WFS).
 * Also refreshes the cached PC6 code list used by the prober's refill scan.
 */
export async function loadPc6Geojson(pc4) {
  const memoized = pc6Memo.get(pc4);
  if (memoized) return memoized;

  const cached = await redis.get(keys.pc6Geo(pc4));
  if (cached) {
    const fc = JSON.parse(cached);
    pc6MemoPut(pc4, fc);
    return fc;
  }

  const features = await fetchPc6FeaturesFromWfs(pc4);
  const fc = { type: 'FeatureCollection', features };
  const codes = features.map((f) => f.properties.pc6).sort();

  // Boundaries are as stable as the BAG; empty areas (no CBS data) retry sooner.
  const ttl = features.length ? 60 * 24 * 3600 * 1000 : 6 * 3600 * 1000;
  await redis.set(keys.pc6Geo(pc4), JSON.stringify(fc), 'PX', ttl);
  await redis.set(keys.pc6List(pc4), JSON.stringify(codes), 'PX', ttl);
  pc6MemoPut(pc4, fc);
  console.log(`[geojson] fetched ${features.length} PC6 polygons for ${pc4}`);
  return fc;
}

/** Sorted PC6 codes inside a PC4 (cheap cached list; falls back to geometry). */
export async function listPc6InPc4(pc4) {
  const cached = await redis.get(keys.pc6List(pc4));
  if (cached) return JSON.parse(cached);
  const fc = await loadPc6Geojson(pc4);
  return fc.features.map((f) => f.properties.pc6).sort();
}
