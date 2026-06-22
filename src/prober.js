import http from 'http';
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

// Adaptive back-off when Picnic rate-limits us. This lives PER POD on purpose:
// Picnic's WAF blocks by egress IP, so each DaemonSet pod (= distinct node IP)
// backs off independently — a block on one node never pauses the others.
const COOLDOWN_BASE_MS = 45_000;
const COOLDOWN_MAX_MS = 5 * 60_000;

export const proberState = {
  running: false,
  total: 0,
  done: 0, // areas this pod has probed since start (informational)
  startedAt: null,
  lastPc4: null,
  cooldownUntil: 0,
  cooldownMs: COOLDOWN_BASE_MS,
  blocks: 0,
};

// Live coverage deltas go through Redis pub/sub so they reach the server pod(s)
// no matter which prober pod produced them. The server re-emits them to SSE.
function emitCoverage(pc4, rec) {
  const payload = JSON.stringify({
    pc4,
    s: rec.status,
    city: rec.city || null,
    municipality: rec.municipality || null,
    province: rec.province || null,
    postcode: rec.postcode || null,
  });
  redis.publish(keys.events, payload).catch(() => {});
}

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
 *  2. Check Picnic coverage (try alternates if Picnic doesn't know the address).
 *  3. Enrich/validate via postcode.tech (globally budgeted across all pods).
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

// ---- Shared work queue (Redis) --------------------------------------------

// Refill the queue with every area that still needs probing. Guarded by a lock
// so only one pod scans the keyspace at a time.
async function refillQueue() {
  const got = await redis.set(keys.fillLock, config.proberId, 'NX', 'EX', config.fillLockTtlS);
  if (!got) return false;

  const codes = await listPc4Codes();
  proberState.total = codes.length;
  let added = 0;
  for (const pc4 of codes) {
    if (await isFresh(pc4)) continue;
    if (await redis.exists(keys.claim(pc4))) continue; // in-flight on some pod
    await redis.rpush(keys.queue, pc4);
    added++;
  }
  if (added) console.log(`[prober] refilled queue with ${added} areas`);
  return added > 0;
}

// Claim the next area to probe, or null if there's nothing to do right now.
async function nextPc4() {
  let pc4 = await redis.lpop(keys.queue);
  if (pc4) return pc4;
  await refillQueue(); // empty — try to (re)fill it (one pod wins the lock)
  return redis.lpop(keys.queue);
}

async function worker() {
  while (proberState.running) {
    // This pod's egress IP is cooling down after a Picnic block.
    const wait = proberState.cooldownUntil - Date.now();
    if (wait > 0) {
      await sleep(Math.min(wait, 3000));
      continue;
    }

    const pc4 = await nextPc4();
    if (!pc4) {
      await sleep(config.idleWaitMs); // queue drained and everything is fresh
      continue;
    }

    // Mark in-flight so another pod won't grab the same area during a refill race.
    const claimed = await redis.set(keys.claim(pc4), config.proberId, 'NX', 'EX', config.claimTtlS);
    if (!claimed) continue;
    if (await isFresh(pc4)) {
      await redis.del(keys.claim(pc4));
      continue;
    }

    try {
      const rec = await probeOne(pc4);
      await redis.set(keys.coverage(pc4), JSON.stringify(rec));
      await redis.del(keys.claim(pc4));
      proberState.lastPc4 = pc4;
      proberState.done++;
      emitCoverage(pc4, rec);
      proberState.cooldownMs = COOLDOWN_BASE_MS; // healthy — relax the back-off
    } catch (err) {
      if (err instanceof PicnicBlockedError) {
        // Put it back for another (un-blocked) pod and cool down THIS pod.
        await redis.lpush(keys.queue, pc4);
        await redis.del(keys.claim(pc4));
        proberState.blocks++;
        proberState.cooldownUntil = Date.now() + proberState.cooldownMs;
        console.warn(
          `[prober ${config.proberId}] Picnic blocked — cooling down ${Math.round(
            proberState.cooldownMs / 1000,
          )}s (block #${proberState.blocks})`,
        );
        proberState.cooldownMs = Math.min(proberState.cooldownMs * 2, COOLDOWN_MAX_MS);
        continue;
      }
      const rec = { status: 'error', pc4, reason: err.message, ts: Date.now() };
      await redis.set(keys.coverage(pc4), JSON.stringify(rec));
      await redis.del(keys.claim(pc4));
      proberState.done++;
      emitCoverage(pc4, rec);
    }
    await sleep(config.probeDelayMs);
  }
}

// ---- Liveness heartbeat ----------------------------------------------------

async function heartbeat() {
  const payload = JSON.stringify({
    id: config.proberId,
    cooldownMs: Math.max(0, proberState.cooldownUntil - Date.now()),
    blocks: proberState.blocks,
    done: proberState.done,
    lastPc4: proberState.lastPc4,
    ts: Date.now(),
  });
  try {
    await redis.sadd(keys.probers, config.proberId);
    await redis.set(keys.prober(config.proberId), payload, 'EX', config.heartbeatTtlS);
  } catch {
    /* transient */
  }
}

/** Start this pod's probing workers + heartbeat. Idempotent. */
export async function startProber() {
  if (proberState.running) return;
  proberState.running = true;
  proberState.startedAt = Date.now();

  try {
    const codes = await listPc4Codes();
    proberState.total = codes.length;
  } catch {
    /* total is also re-set on refill */
  }

  await heartbeat();
  setInterval(heartbeat, config.heartbeatMs);

  console.log(
    `[prober ${config.proberId}] started, concurrency=${config.probeConcurrency}, delay=${config.probeDelayMs}ms`,
  );
  for (let i = 0; i < Math.max(1, config.probeConcurrency); i++) {
    worker().catch((e) => console.error('[prober] worker crashed', e));
  }
}

/** Minimal HTTP server so prober-only pods have a k8s health endpoint. */
export function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'prober', id: config.proberId }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(config.port, () => console.log(`[prober] health server on :${config.port}`));
  return server;
}
