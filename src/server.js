import express from 'express';
import path from 'path';
import { config, keys } from './config.js';
import { redis } from './redisClient.js';
import { loadGeojson } from './geojson.js';
import { startProber, proberState } from './prober.js';
import { ptBudgetUsed } from './sources.js';
import { bus } from './events.js';

const app = express();
app.use(express.json());

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
    const [next, batch] = await redis.scan(
      cursor,
      'MATCH',
      `${keys.coveragePrefix}*`,
      'COUNT',
      500,
    );
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

// --- Coverage map: { "1011": {status, city, ...}, ... } ---
app.get('/api/coverage', async (_req, res) => {
  try {
    const cov = await readAllCoverage();
    // Slim payload: drop bulky fields the map doesn't need.
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
    res.set('Cache-Control', 'no-store').json(slim);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Progress + stats ---
app.get('/api/status', async (_req, res) => {
  try {
    const cov = await readAllCoverage();
    const counts = { covered: 0, waitlist: 0, not_found: 0, invalid: 0, nodata: 0, error: 0 };
    for (const r of Object.values(cov)) {
      counts[r.status] = (counts[r.status] || 0) + 1;
    }
    const probed = Object.keys(cov).length;
    res.set('Cache-Control', 'no-store').json({
      running: proberState.running,
      paused: proberState.paused,
      total: proberState.total,
      done: proberState.done,
      probed,
      counts,
      lastPc4: proberState.lastPc4,
      blocks: proberState.blocks,
      cooldownMs: Math.max(0, proberState.cooldownUntil - Date.now()),
      postcodeTech: { used: await ptBudgetUsed(), limit: config.postcodeTechDailyLimit },
      updatedAt: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight progress payload (no Redis scan — safe to push every second).
// Counts are derived client-side from the coverage map it already holds.
async function liveStatus() {
  return {
    running: proberState.running,
    paused: proberState.paused,
    total: proberState.total,
    done: proberState.done,
    blocks: proberState.blocks,
    lastPc4: proberState.lastPc4,
    cooldownMs: Math.max(0, proberState.cooldownUntil - Date.now()),
    postcodeTech: { used: await ptBudgetUsed(), limit: config.postcodeTechDailyLimit },
    updatedAt: Date.now(),
  };
}

// --- Live updates over Server-Sent Events ---
// On connect we push a full snapshot, then stream each area the moment the
// prober probes it, plus a lightweight status tick once a second.
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
    // Slim the snapshot to the same shape as the streamed deltas.
    const slim = {};
    for (const [pc4, r] of Object.entries(coverage)) {
      slim[pc4] = {
        s: r.status,
        city: r.city || null,
        municipality: r.municipality || null,
        province: r.province || null,
        postcode: r.postcode || null,
      };
    }
    send('snapshot', { coverage: slim, status });
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

// --- Manual control: (re)start a probing sweep ---
app.post('/api/probe/start', async (_req, res) => {
  startProber().catch((e) => console.error(e));
  res.json({ ok: true, running: proberState.running });
});

const server = app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
  // Warm the GeoJSON cache, then begin probing automatically.
  loadGeojson()
    .then(() => {
      if (config.probeEnabled) return startProber();
    })
    .catch((e) => console.error('[startup]', e));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
