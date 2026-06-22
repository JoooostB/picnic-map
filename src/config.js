// Central configuration, all overridable via environment variables.
export const config = {
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
};
