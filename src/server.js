import express from 'express';
import path from 'path';
import { config, keys } from './config.js';
import { redis } from './redisClient.js';
import { loadGeojson, listPc4Codes } from './geojson.js';
import { ptBudgetUsed } from './sources.js';
import { bus } from './events.js';

const app = express();
app.use(express.json());

// Total number of PC4 areas (constant for a run); cached to avoid re-parsing.
let pc4Total = 0;

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

function slimCoverage(cov) {
  const slim = {};
  for (const [pc4, r] of Object.entries(cov)) {
    slim[pc4] = {
      s: r.status,
      city: r.city || null,
      municipality: r.municipality || null,
      province: r.province || null,
      postcode: r.postcode || null,
    };
  }
  return slim;
}

// --- Coverage map: { "1011": {s, city, ...}, ... } ---
app.get('/api/coverage', async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json(slimCoverage(await readAllCoverage()));
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
  return {
    running: probers > 0,
    probers,
    coolingDown,
    total: pc4Total,
    blocks,
    lastPc4,
    cooldownMs,
    postcodeTech: { used: await ptBudgetUsed(), limit: config.postcodeTechDailyLimit },
    updatedAt: Date.now(),
  };
}

// --- Progress + stats (also the server pod's readiness probe target) ---
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
    const [coverage, status] = await Promise.all([readAllCoverage(), liveStatus()]);
    send('snapshot', { coverage: slimCoverage(coverage), status });
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
