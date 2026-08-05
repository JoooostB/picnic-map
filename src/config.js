import os from 'os';

// Central configuration, all overridable via environment variables.
export const config = {
  // Process role — one image, two jobs:
  //   'server' = web UI + API + SSE (no probing)
  //   'prober' = rate-limited probing worker only (run as a DaemonSet to
  //              spread Picnic calls over each node's egress IP)
  //   'all'    = both in one process (default; used by docker-compose / dev)
  role: (process.env.APP_ROLE || 'all').toLowerCase(),

  // Stable id for this prober pod (k8s sets HOSTNAME to the pod name).
  proberId: process.env.HOSTNAME || os.hostname() || `prober-${process.pid}`,

  port: Number(process.env.PORT || 3000),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  postcodeTechToken: process.env.POSTCODE_TECH_API_TOKEN || '',

  // PC4 ("postcodegebieden") polygon source — simplified WGS84 GeoJSON.
  pc4GeojsonUrl: 'https://cartomap.github.io/nl/wgs84/postcode4_2020.geojson',

  // Probing behaviour
  probeEnabled: (process.env.PROBE_ENABLED || 'true') === 'true',
  probeConcurrency: Number(process.env.PROBE_CONCURRENCY || 2),
  probeDelayMs: Number(process.env.PROBE_DELAY_MS || 300),

  // Re-probe entries older than this (ms). Default 14 days.
  cacheTtlMs: Number(process.env.CACHE_TTL_MS || 14 * 24 * 60 * 60 * 1000),

  // PC6 refinement: after the PC4 sweep is complete, probe every full postcode
  // (PC6, e.g. 2461NK) inside covered/waitlist PC4 areas for a detailed view.
  // A full PC6 pass is ~460k probes, so it re-runs on a slower cycle (30 days).
  pc6Enabled: (process.env.PC6_REFINE_ENABLED || 'true') === 'true',
  pc6CacheTtlMs: Number(process.env.PC6_CACHE_TTL_MS || 30 * 24 * 60 * 60 * 1000),

  // CBS PC6 polygons via PDOK WFS (CC-BY 4.0, free, no key). Filtered per PC4
  // prefix so we only ever fetch geometry for areas that get refined.
  pc6WfsUrl: 'https://service.pdok.nl/cbs/postcode6/2023/wfs/v1_0',

  // Distributed probing coordination
  heartbeatMs: 5000, // how often a prober refreshes its liveness record
  heartbeatTtlS: 15, // prober record expiry (missed ~2 beats = considered dead)
  claimTtlS: Number(process.env.CLAIM_TTL_S || 180), // max time to hold one area
  fillLockTtlS: 30, // lock while one prober refills the shared work queue
  idleWaitMs: 10000, // wait when the queue is drained and everything is fresh

  // postcode.tech is limited to 10k calls/day — keep a safety margin.
  postcodeTechDailyLimit: Number(process.env.POSTCODE_TECH_DAILY_LIMIT || 9500),

  // Picnic public check-address endpoint. Request is issued by picnicClient via
  // CloakBrowser; UA/platform headers are set by the stealth browser itself.
  picnicUrl: 'https://picnic.app/nl/rest/public-api/15/user-onboarding/check-address',

  // PDOK Locatieserver — free, no key. Used only to discover a real, existing
  // (postcode + house number) inside each PC4 so we have a valid probe address.
  pdokUrl: 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free',
};

// Redis key helpers
export const keys = {
  geojson: 'pcmap:geojson:pc4',
  coverage: (pc4) => `pcmap:cov:${pc4}`,
  coveragePrefix: 'pcmap:cov:',
  ptCounter: (day) => `pcmap:pt:count:${day}`,
  pdokCache: (pc4) => `pcmap:pdok:${pc4}`,

  // PC6 refinement
  cov6: (pc6) => `pcmap:cov6:${pc6}`, // per-PC6 coverage record
  agg6: 'pcmap:agg6', // HASH: `${pc4}:c|w|n` = probed counts, `${pc4}:t` = total PC6
  pc6Geo: (pc4) => `pcmap:geo6:${pc4}`, // slimmed PC6 polygon FeatureCollection
  pc6List: (pc4) => `pcmap:pc6list:${pc4}`, // JSON array of PC6 codes in a PC4
  pdok6: (pc6) => `pcmap:pdok6:${pc6}`, // cached candidate addresses per PC6
  enq6: (pc4) => `pcmap:enq6:${pc4}`, // ts of last full enqueue of an area's PC6s
  cov6Count: 'pcmap:stats:cov6', // running count of distinct PC6s probed

  // Distributed probing
  queue: 'pcmap:queue', // Redis list of PC4 codes waiting to be probed
  queue6: 'pcmap:queue6', // Redis list of PC6 codes (only drained when queue is empty)
  fillLock: 'pcmap:fill-lock', // only one prober refills the queue at a time
  fillLock6: 'pcmap:fill-lock6', // ditto for the PC6 queue (also throttles scans)
  claim: (pc4) => `pcmap:claim:${pc4}`, // in-flight marker (which pod owns it)
  claim6: (pc6) => `pcmap:claim6:${pc6}`, // in-flight marker for a PC6 probe
  events: 'pcmap:events', // pub/sub channel for live coverage deltas
  probers: 'pcmap:probers', // SET of currently-alive prober ids
  prober: (id) => `pcmap:prober:${id}`, // per-prober heartbeat record (TTL)
};
