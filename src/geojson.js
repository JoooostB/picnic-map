import fs from 'fs/promises';
import path from 'path';
import { config, keys } from './config.js';
import { redis } from './redisClient.js';

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
