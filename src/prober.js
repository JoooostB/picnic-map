import { config, keys } from './config.js';
import { redis } from './redisClient.js';
import { listPc4Codes } from './geojson.js';
import {
  findAddressesInPc4,
  enrichPostcode,
  checkPicnicCoverage,
  ptBudgetRemaining,
  incrPtBudget,
  PicnicBlockedError,
} from './sources.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Adaptive back-off shared across workers when Picnic rate-limits us.
const COOLDOWN_BASE_MS = 45_000;
const COOLDOWN_MAX_MS = 5 * 60_000;

export const proberState = {
  running: false,
  total: 0,
  done: 0,
  startedAt: null,
  lastPc4: null,
  paused: false,
  pauseReason: null,
  cooldownUntil: 0,
  cooldownMs: COOLDOWN_BASE_MS,
  blocks: 0,
};

async function isFresh(pc4) {
  const raw = await redis.get(keys.coverage(pc4));
  if (!raw) return false;
  try {
    const rec = JSON.parse(raw);
    if (rec.status === 'error') return false; // always retry errors
    return Date.now() - (rec.ts || 0) < config.cacheTtlMs;
  } catch {
    return false;
  }
}

/**
 * Probe a single PC4 area:
 *  1. Discover real candidate addresses via PDOK.
 *  2. Enrich/validate via postcode.tech (budgeted).
 *  3. Check Picnic coverage (try alternates if Picnic doesn't know the address).
 */
async function probeOne(pc4) {
  let candidates = [];
  try {
    candidates = await findAddressesInPc4(pc4, 3);
  } catch (err) {
    return { status: 'error', reason: `pdok: ${err.message}`, ts: Date.now() };
  }

  if (!candidates.length) {
    return { status: 'nodata', reason: 'no address in PC4', ts: Date.now() };
  }

  // Ask Picnic first. If it doesn't recognise this exact address, try the
  // alternates. A PicnicBlockedError propagates so the worker can back off
  // before we spend any postcode.tech quota on this area.
  let result = null;
  let used = candidates[0];
  for (const cand of candidates) {
    const r = await checkPicnicCoverage(cand.postcode, cand.huisnummer);
    used = cand;
    if (r.status === 'covered' || r.status === 'waitlist') {
      result = r;
      break;
    }
    if (r.status === 'not_found' || r.status === 'invalid') {
      result = r; // keep, but try the next candidate for a definitive answer
      await sleep(config.probeDelayMs);
      continue;
    }
    result = r;
    break;
  }

  // Enrich the resolved address with postcode.tech when budget allows.
  let enrich = null;
  if ((await ptBudgetRemaining()) > 0 && config.postcodeTechToken) {
    try {
      await incrPtBudget();
      enrich = await enrichPostcode(used.postcode, used.huisnummer);
    } catch {
      /* enrichment is best-effort */
    }
  }

  const geoLat = enrich?.lat ?? used.lat ?? result?.address?.geolocation?.latitude;
  const geoLon = enrich?.lon ?? used.lon ?? result?.address?.geolocation?.longitude;

  return {
    status: result?.status || 'error',
    pc4,
    postcode: used.postcode,
    huisnummer: used.huisnummer,
    street: enrich?.street ?? result?.address?.street ?? null,
    city: enrich?.city ?? result?.address?.city ?? null,
    municipality: enrich?.municipality ?? null,
    province: enrich?.province ?? null,
    lat: geoLat ?? null,
    lon: geoLon ?? null,
    ts: Date.now(),
  };
}

async function worker(queue) {
  while (queue.length) {
    if (proberState.paused) {
      await sleep(5000);
      continue;
    }

    // Respect a shared cooldown after a Picnic block.
    const wait = proberState.cooldownUntil - Date.now();
    if (wait > 0) {
      await sleep(Math.min(wait, 5000));
      continue;
    }

    const pc4 = queue.shift();
    if (!pc4) break;

    if (await isFresh(pc4)) {
      proberState.done++;
      continue;
    }

    try {
      const rec = await probeOne(pc4);
      await redis.set(keys.coverage(pc4), JSON.stringify(rec));
      proberState.lastPc4 = pc4;
      // Healthy response — relax the back-off.
      proberState.cooldownMs = COOLDOWN_BASE_MS;
    } catch (err) {
      if (err instanceof PicnicBlockedError) {
        // Don't consume this area; re-queue and cool down with exponential back-off.
        queue.unshift(pc4);
        proberState.blocks++;
        proberState.cooldownUntil = Date.now() + proberState.cooldownMs;
        console.warn(
          `[prober] Picnic blocked (rate limit) — cooling down ${Math.round(
            proberState.cooldownMs / 1000,
          )}s (block #${proberState.blocks})`,
        );
        proberState.cooldownMs = Math.min(proberState.cooldownMs * 2, COOLDOWN_MAX_MS);
        continue;
      }
      await redis.set(
        keys.coverage(pc4),
        JSON.stringify({ status: 'error', pc4, reason: err.message, ts: Date.now() }),
      );
    }
    proberState.done++;
    await sleep(config.probeDelayMs);
  }
}

/** Kick off (or resume) probing of every PC4 area. Idempotent. */
export async function startProber() {
  if (proberState.running) return;
  proberState.running = true;
  proberState.startedAt = Date.now();

  const codes = await listPc4Codes();
  proberState.total = codes.length;
  proberState.done = 0;

  // Shared work queue consumed by N polite workers.
  const queue = [...codes];
  const workers = Array.from({ length: Math.max(1, config.probeConcurrency) }, () =>
    worker(queue),
  );

  console.log(`[prober] probing ${codes.length} PC4 areas, concurrency=${config.probeConcurrency}`);
  Promise.all(workers)
    .then(() => console.log('[prober] sweep complete'))
    .catch((e) => console.error('[prober] error', e))
    .finally(() => {
      proberState.running = false;
    });
}
