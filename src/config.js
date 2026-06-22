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

  // Distributed probing coordination
  heartbeatMs: 5000, // how often a prober refreshes its liveness record
  heartbeatTtlS: 15, // prober record expiry (missed ~2 beats = considered dead)
  claimTtlS: Number(process.env.CLAIM_TTL_S || 180), // max time to hold one area
  fillLockTtlS: 30, // lock while one prober refills the shared work queue
  idleWaitMs: 10000, // wait when the queue is drained and everything is fresh

  // postcode.tech is limited to 10k calls/day — keep a safety margin.
  postcodeTechDailyLimit: Number(process.env.POSTCODE_TECH_DAILY_LIMIT || 9500),

  // Picnic public check-address endpoint + headers mirrored from the HAR capture.
  picnicUrl: 'https://picnic.app/nl/rest/public-api/15/user-onboarding/check-address',
  picnicHeaders: {
    'content-type': 'application/json;charset=UTF-8',
    accept: 'application/json, text/plain, */*',
    origin: 'https://picnic.app',
    referer: 'https://picnic.app/nl/online-supermarkt/bezorging/',
    'user-agent':
      'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
  },

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

  // Distributed probing
  queue: 'pcmap:queue', // Redis list of PC4 codes waiting to be probed
  fillLock: 'pcmap:fill-lock', // only one prober refills the queue at a time
  claim: (pc4) => `pcmap:claim:${pc4}`, // in-flight marker (which pod owns it)
  events: 'pcmap:events', // pub/sub channel for live coverage deltas
  probers: 'pcmap:probers', // SET of currently-alive prober ids
  prober: (id) => `pcmap:prober:${id}`, // per-prober heartbeat record (TTL)
};
