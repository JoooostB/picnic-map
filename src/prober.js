import http from 'http';
import { config, keys } from './config.js';
import { redis } from './redisClient.js';
import { listPc4Codes, listPc6InPc4 } from './geojson.js';
import {
  findAddressesInPc4,
  findAddressesInPc6,
  enrichPostcode,
  checkPicnicCoverage,
  ptBudgetRemaining,
  incrPtBudget,
  PicnicBlockedError,
} from './sources.js';
import { initPicnicClient } from './picnicClient.js';

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

async function isFresh6(pc6) {
  const raw = await redis.get(keys.cov6(pc6));
  if (!raw) return false;
  try {
    const rec = JSON.parse(raw);
    if (rec.status === 'error') return false; // always retry errors
    return Date.now() - (rec.ts || 0) < config.pc6CacheTtlMs;
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

// ---- PC6 refinement --------------------------------------------------------

// Tally bucket for the per-PC4 aggregate: covered / waitlist / no-service.
// Errors are not counted (they get retried), so the aggregate only ever
// reflects definitive answers.
function bucketOf(status) {
  if (status === 'covered') return 'c';
  if (status === 'waitlist') return 'w';
  if (status === 'not_found' || status === 'invalid' || status === 'nodata') return 'n';
  return null;
}

// Keep the per-PC4 tallies in one hash so the server can HGETALL the whole
// aggregate in a single call. Returns the area's counts after the update.
async function updateAgg6(pc4, oldRaw, newStatus) {
  let oldBucket = null;
  if (oldRaw) {
    try {
      oldBucket = bucketOf(JSON.parse(oldRaw).status);
    } catch {
      /* corrupt old record — treat as uncounted */
    }
  }
  const newBucket = bucketOf(newStatus);
  if (oldBucket !== newBucket) {
    if (oldBucket) await redis.hincrby(keys.agg6, `${pc4}:${oldBucket}`, -1);
    if (newBucket) await redis.hincrby(keys.agg6, `${pc4}:${newBucket}`, 1);
  }
  const [c, w, n, t] = await redis.hmget(
    keys.agg6,
    `${pc4}:c`,
    `${pc4}:w`,
    `${pc4}:n`,
    `${pc4}:t`,
  );
  return { c: Number(c) || 0, w: Number(w) || 0, n: Number(n) || 0, t: Number(t) || 0 };
}

// PC6 deltas ride the same pub/sub channel as PC4 ones; the `pc6` field is
// what tells the frontend which kind it is looking at.
function emitCoverage6(rec, agg) {
  const payload = JSON.stringify({ pc6: rec.pc6, pc4: rec.pc4, s: rec.status, agg });
  redis.publish(keys.events, payload).catch(() => {});
}

/**
 * Probe a single full postcode (PC6): find a real address in it via PDOK,
 * then ask Picnic. No postcode.tech enrichment here — the PC4 record already
 * carries city/province, and ~100 PC6s per area would drain the daily budget.
 */
async function probeOnePc6(pc6) {
  const pc4 = pc6.slice(0, 4);
  let candidates = [];
  try {
    candidates = await findAddressesInPc6(pc6, 2);
  } catch (err) {
    return { status: 'error', pc6, pc4, reason: `pdok: ${err.message}`, ts: Date.now() };
  }

  if (!candidates.length) {
    return { status: 'nodata', pc6, pc4, reason: 'no address in PC6', ts: Date.now() };
  }

  let result = null;
  let used = candidates[0];
  for (const cand of candidates) {
    const r = await checkPicnicCoverage(pc6, cand.huisnummer);
    used = cand;
    result = r;
    if (r.status === 'covered' || r.status === 'waitlist') break;
    if (r.status === 'not_found' || r.status === 'invalid') {
      await sleep(config.probeDelayMs);
      continue;
    }
    break;
  }

  return {
    status: result?.status || 'error',
    pc6,
    pc4,
    huisnummer: used.huisnummer,
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

// Refill the PC6 queue with stale full postcodes from covered/waitlist areas.
// Runs in bursts (queue target) so a cold start doesn't enumerate the whole
// country at once; the lock doubles as a scan throttle. Only ever reached when
// the PC4 queue is drained, so broad coverage always wins.
const PC6_QUEUE_TARGET = 1500;

// The same "breadth before depth" idea, one level down. Probing every PC6 in
// the country is ~460k requests; a spread sample of this many per area is ~3%
// of that and already reveals WHICH areas are mixed (the accuracy problem —
// e.g. 2461 Ter Aar vs Langeraar). Only once every area has been sampled do we
// go back and fill in the remaining postcodes.
const PC6_SAMPLE_N = 14;

// Evenly-spaced picks across the (sorted) PC6 list. Postcode letters run
// roughly with street order, so spreading the indices spreads them spatially.
function stratifiedSample(codes, n) {
  if (codes.length <= n) return [...codes];
  const step = codes.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(codes[Math.floor(i * step)]);
  return [...new Set(out)];
}

// Per-area enqueue marker: "<phase>:<ts>", phase = sample | full. It also
// spares us a ~100-GET freshness scan per area on every refill.
async function readPhase6(pc4) {
  const raw = await redis.get(keys.enq6(pc4));
  if (!raw) return null;
  const [phase, ts] = raw.split(':');
  if (Date.now() - Number(ts || 0) >= config.pc6CacheTtlMs) return null; // cycle over
  return phase;
}

async function refillQueue6() {
  const got = await redis.set(keys.fillLock6, config.proberId, 'NX', 'EX', 60);
  if (!got) return false;

  const codes = await listPc4Codes();

  // Pass 1 enqueues samples for never-sampled areas; only when none are left
  // does pass 2 enqueue the remainder of already-sampled areas.
  for (const phase of ['sample', 'full']) {
    const queued = await redis.llen(keys.queue6);
    let added = 0;
    for (const pc4 of codes) {
      if (queued + added >= PC6_QUEUE_TARGET) break;
      const covRaw = await redis.get(keys.coverage(pc4));
      if (!covRaw) continue;
      let cov;
      try {
        cov = JSON.parse(covRaw);
      } catch {
        continue;
      }
      if (cov.status !== 'covered' && cov.status !== 'waitlist') continue;

      const current = await readPhase6(pc4);
      if (phase === 'sample' ? current !== null : current !== 'sample') continue;

      let pc6codes;
      try {
        pc6codes = await listPc6InPc4(pc4);
      } catch (err) {
        console.warn(`[prober] PC6 list failed for ${pc4}: ${err.message}`);
        continue; // no marker written — retried on a later refill
      }
      await redis.hset(keys.agg6, `${pc4}:t`, pc6codes.length);

      const wanted = phase === 'sample' ? stratifiedSample(pc6codes, PC6_SAMPLE_N) : pc6codes;
      const stale = [];
      for (const pc6 of wanted) {
        if (!(await isFresh6(pc6))) stale.push(pc6);
      }
      if (stale.length) {
        await redis.rpush(keys.queue6, ...stale);
        added += stale.length;
      }
      await redis.set(keys.enq6(pc4), `${phase}:${Date.now()}`);
    }
    if (added) {
      console.log(`[prober] refilled PC6 queue with ${added} postcodes (${phase} pass)`);
      return true;
    }
  }
  return false;
}

// Claim the next unit of work. Strict priority: the PC6 detail queue is only
// touched when every PC4 area has been probed and is fresh ("match all numbers
// first"). Refills are cheap no-ops while their lock/throttle key lives.
async function nextTask() {
  let code = await redis.lpop(keys.queue);
  if (!code) {
    await refillQueue(); // empty — try to (re)fill it (one pod wins the lock)
    code = await redis.lpop(keys.queue);
  }
  if (code) return { kind: 'pc4', code };

  if (!config.pc6Enabled) return null;
  code = await redis.lpop(keys.queue6);
  if (!code) {
    await refillQueue6();
    code = await redis.lpop(keys.queue6);
  }
  return code ? { kind: 'pc6', code } : null;
}

// Register a Picnic WAF block: cool this pod down and grow the back-off.
function noteBlock() {
  proberState.blocks++;
  proberState.cooldownUntil = Date.now() + proberState.cooldownMs;
  console.warn(
    `[prober ${config.proberId}] Picnic blocked — cooling down ${Math.round(
      proberState.cooldownMs / 1000,
    )}s (block #${proberState.blocks})`,
  );
  proberState.cooldownMs = Math.min(proberState.cooldownMs * 2, COOLDOWN_MAX_MS);
}

// Probe one claimed PC4 area. Returns true when a Picnic probe was attempted
// (the caller then applies the inter-probe delay), false on a no-op or block.
async function runPc4Task(pc4) {
  // Mark in-flight so another pod won't grab the same area during a refill race.
  const claimed = await redis.set(keys.claim(pc4), config.proberId, 'NX', 'EX', config.claimTtlS);
  if (!claimed) return false;
  if (await isFresh(pc4)) {
    await redis.del(keys.claim(pc4));
    return false;
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
      noteBlock();
      return false;
    }
    const rec = { status: 'error', pc4, reason: err.message, ts: Date.now() };
    await redis.set(keys.coverage(pc4), JSON.stringify(rec));
    await redis.del(keys.claim(pc4));
    proberState.done++;
    emitCoverage(pc4, rec);
  }
  return true;
}

// Probe one claimed PC6 postcode. Same claim/back-off dance as runPc4Task,
// plus the per-PC4 aggregate bookkeeping that drives the "partial" styling.
async function runPc6Task(pc6) {
  const claimed = await redis.set(keys.claim6(pc6), config.proberId, 'NX', 'EX', config.claimTtlS);
  if (!claimed) return false;
  if (await isFresh6(pc6)) {
    await redis.del(keys.claim6(pc6));
    return false;
  }

  // The previous record (if any) is needed to move its aggregate tally.
  const oldRaw = await redis.get(keys.cov6(pc6));

  let rec;
  try {
    rec = await probeOnePc6(pc6);
    proberState.cooldownMs = COOLDOWN_BASE_MS; // healthy — relax the back-off
  } catch (err) {
    if (err instanceof PicnicBlockedError) {
      await redis.lpush(keys.queue6, pc6);
      await redis.del(keys.claim6(pc6));
      noteBlock();
      return false;
    }
    rec = { status: 'error', pc6, pc4: pc6.slice(0, 4), reason: err.message, ts: Date.now() };
  }

  await redis.set(keys.cov6(pc6), JSON.stringify(rec));
  await redis.del(keys.claim6(pc6));
  if (!oldRaw) await redis.incr(keys.cov6Count);
  const agg = await updateAgg6(rec.pc4, oldRaw, rec.status);
  proberState.lastPc4 = pc6;
  proberState.done++;
  emitCoverage6(rec, agg);
  return true;
}

async function worker() {
  while (proberState.running) {
    // This pod's egress IP is cooling down after a Picnic block.
    const wait = proberState.cooldownUntil - Date.now();
    if (wait > 0) {
      await sleep(Math.min(wait, 3000));
      continue;
    }

    const task = await nextTask();
    if (!task) {
      await sleep(config.idleWaitMs); // queues drained and everything is fresh
      continue;
    }

    const probed = task.kind === 'pc4' ? await runPc4Task(task.code) : await runPc6Task(task.code);
    if (probed) await sleep(config.probeDelayMs);
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

  // Warm CloakBrowser before workers start so a launch failure fails boot
  // (rather than every probe timing out on first launch).
  await initPicnicClient();

  await heartbeat();
  setInterval(heartbeat, config.heartbeatMs);

  console.log(
    `[prober ${config.proberId}] started, concurrency=${config.probeConcurrency}, delay=${config.probeDelayMs}ms, pc6=${config.pc6Enabled}`,
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
