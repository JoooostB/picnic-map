import express from 'express';
import path from 'path';
import { config, keys } from './config.js';
import { redis } from './redisClient.js';
import { loadGeojson, listPc4Codes, loadPc6Geojson, listPc6InPc4 } from './geojson.js';
import { ptBudgetUsed } from './sources.js';
import { bus } from './events.js';

const app = express();
app.use(express.json());

// Total number of PC4 areas (constant for a run); cached to avoid re-parsing.
let pc4Total = 0;

// --- Liveness: process-alive only, deliberately NO Redis/downstream calls ---
// A liveness endpoint that fails when a dependency is down causes restart
// storms; dependency health belongs in readiness (/api/status) instead.
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok: true, role: config.role });
});

// --- Static frontend ---
app.use(express.static(path.resolve('public')));

// --- PC4 polygons (cached server-side) ---
app.get('/api/geojson', async (_req, res) => {
  try {
    const fc = await loadGeojson();
    res.set('Cache-Control', 'public, max-age=86400').json(fc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read every coverage record from Redis via SCAN + MGET.
async function readAllCoverage() {
  const out = {};
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${keys.coveragePrefix}*`, 'COUNT', 500);
    cursor = next;
    if (batch.length) {
      const vals = await redis.mget(batch);
      batch.forEach((k, i) => {
        const pc4 = k.slice(keys.coveragePrefix.length);
        if (vals[i]) {
          try {
            out[pc4] = JSON.parse(vals[i]);
          } catch {
            /* skip corrupt */
          }
        }
      });
    }
  } while (cursor !== '0');
  return out;
}

// Per-PC4 PC6 tallies, read from the single aggregate hash the prober keeps:
// { "2461": { c, w, n, t }, ... } — counts of covered / waitlist / no-service
// PC6s plus the area's total. Drives the "partially covered" styling.
async function readAgg6() {
  const flat = await redis.hgetall(keys.agg6);
  const agg = {};
  for (const [field, val] of Object.entries(flat)) {
    const [pc4, bucket] = field.split(':');
    if (!pc4 || !bucket) continue;
    (agg[pc4] = agg[pc4] || { c: 0, w: 0, n: 0, t: 0 })[bucket] = Number(val) || 0;
  }
  return agg;
}

function slimCoverage(cov, agg = {}) {
  const slim = {};
  for (const [pc4, r] of Object.entries(cov)) {
    slim[pc4] = {
      s: r.status,
      city: r.city || null,
      municipality: r.municipality || null,
      province: r.province || null,
      postcode: r.postcode || null,
    };
    if (agg[pc4]) slim[pc4].pc6 = agg[pc4];
  }
  return slim;
}

// --- Coverage map: { "1011": {s, city, ..., pc6?: {c,w,n,t}}, ... } ---
app.get('/api/coverage', async (_req, res) => {
  try {
    const [cov, agg] = await Promise.all([readAllCoverage(), readAgg6()]);
    res.set('Cache-Control', 'no-store').json(slimCoverage(cov, agg));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PC6 detail for one PC4 area ---
const PC4_RE = /^\d{4}$/;

// Polygon geometry (CBS via PDOK, cached server-side; boundaries are stable).
app.get('/api/geojson6/:pc4', async (req, res) => {
  if (!PC4_RE.test(req.params.pc4)) return res.status(400).json({ error: 'invalid pc4' });
  try {
    const fc = await loadPc6Geojson(req.params.pc4);
    res.set('Cache-Control', 'public, max-age=86400').json(fc);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Probed statuses: { "2461NK": { s: "waitlist" }, ... } (unprobed PC6s absent).
app.get('/api/coverage6/:pc4', async (req, res) => {
  if (!PC4_RE.test(req.params.pc4)) return res.status(400).json({ error: 'invalid pc4' });
  try {
    const codes = await listPc6InPc4(req.params.pc4);
    const out = {};
    if (codes.length) {
      const vals = await redis.mget(codes.map((pc6) => keys.cov6(pc6)));
      codes.forEach((pc6, i) => {
        if (!vals[i]) return;
        try {
          out[pc6] = { s: JSON.parse(vals[i]).status };
        } catch {
          /* skip corrupt */
        }
      });
    }
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Aggregate progress across all live prober pods (cheap: a handful of heartbeat
// keys). The "rate-limited" state only shows when EVERY active prober's egress
// IP is cooling down — if one node can still reach Picnic, work continues.
async function liveStatus() {
  const ids = await redis.smembers(keys.probers);
  let probers = 0;
  let coolingDown = 0;
  let blocks = 0;
  let minCooldown = Infinity;
  let lastPc4 = null;
  let lastTs = 0;
  for (const id of ids) {
    const raw = await redis.get(keys.prober(id));
    if (!raw) {
      await redis.srem(keys.probers, id); // expired heartbeat — prune
      continue;
    }
    let p;
    try {
      p = JSON.parse(raw);
    } catch {
      continue;
    }
    probers++;
    blocks += p.blocks || 0;
    if (p.cooldownMs > 0) {
      coolingDown++;
      if (p.cooldownMs < minCooldown) minCooldown = p.cooldownMs;
    }
    if ((p.ts || 0) > lastTs) {
      lastTs = p.ts;
      lastPc4 = p.lastPc4;
    }
  }
  const cooldownMs = probers > 0 && coolingDown === probers && minCooldown !== Infinity ? minCooldown : 0;
  const [pc6Refined, pc6Queued] = await Promise.all([
    redis.get(keys.cov6Count),
    redis.llen(keys.queue6),
  ]);
  return {
    running: probers > 0,
    probers,
    coolingDown,
    total: pc4Total,
    blocks,
    lastPc4,
    cooldownMs,
    postcodeTech: { used: await ptBudgetUsed(), limit: config.postcodeTechDailyLimit },
    pc6: { enabled: config.pc6Enabled, refined: Number(pc6Refined) || 0, queued: pc6Queued },
    updatedAt: Date.now(),
  };
}

// --- Progress + stats (the server pod's READINESS probe target; it depends
// on Redis, so it must never be used for liveness — use /healthz for that) ---
app.get('/api/status', async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json(await liveStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Live updates over Server-Sent Events ---
// On connect we push a full snapshot, then stream each area the moment ANY
// prober pod probes it (delivered via Redis pub/sub), plus a status tick/second.
app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx/ingress)
  });
  res.flushHeaders?.();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const [coverage, status, agg] = await Promise.all([readAllCoverage(), liveStatus(), readAgg6()]);
    send('snapshot', { coverage: slimCoverage(coverage, agg), status });
  } catch (err) {
    send('error', { message: err.message });
  }

  const onCoverage = (delta) => send('coverage', delta);
  bus.on('coverage', onCoverage);

  const statusTimer = setInterval(async () => {
    try {
      send('status', await liveStatus());
    } catch {
      /* ignore transient errors */
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(statusTimer);
    bus.off('coverage', onCoverage);
    res.end();
  });
});

/** Start the web server: static UI, JSON API, SSE, and the cross-pod event relay. */
export async function startServer() {
  // Live coverage deltas arrive over Redis pub/sub from prober pod(s); re-emit
  // them onto the in-process bus that the SSE handler listens to.
  const sub = redis.duplicate();
  sub.on('message', (channel, message) => {
    if (channel !== keys.events) return;
    try {
      bus.emit('coverage', JSON.parse(message));
    } catch {
      /* ignore malformed */
    }
  });
  sub.subscribe(keys.events).catch((e) => console.error('[server] subscribe failed:', e.message));

  // Warm the GeoJSON cache and remember the area count for progress reporting.
  try {
    await loadGeojson();
    pc4Total = (await listPc4Codes()).length;
  } catch (e) {
    console.error('[server] geojson warmup failed:', e.message);
  }

  const server = app.listen(config.port, () => console.log(`[server] listening on :${config.port}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
  return server;
}
