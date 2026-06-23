import { config, keys } from './config.js';
import { redis } from './redisClient.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raised when Picnic's CloudFront WAF blocks us (HTTP 403). The prober treats
 *  this as a back-off signal rather than a per-area result. */
export class PicnicBlockedError extends Error {
  constructor(msg = 'Picnic request blocked (rate limited)') {
    super(msg);
    this.name = 'PicnicBlockedError';
  }
}

async function fetchJson(url, opts = {}, { retries = 3, backoffMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      // Retry on rate-limit / transient server errors with backoff.
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await res.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      return { status: res.status, body, text };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(backoffMs * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

/**
 * PDOK Locatieserver: find up to `n` real, existing addresses inside a PC4.
 * Returns [{ postcode, huisnummer, lat, lon, weergavenaam }]. Cached in Redis
 * because the BAG address register barely changes.
 */
export async function findAddressesInPc4(pc4, n = 3) {
  const cached = await redis.get(keys.pdokCache(pc4));
  if (cached) return JSON.parse(cached);

  const url =
    `${config.pdokUrl}?q=*&fq=type:adres&fq=postcode:${pc4}*` +
    `&rows=${n}&fl=weergavenaam,postcode,huisnummer,centroide_ll`;
  const { body } = await fetchJson(url);
  const docs = body?.response?.docs || [];
  const addresses = docs
    .map((d) => {
      const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(d.centroide_ll || '');
      return {
        postcode: d.postcode,
        huisnummer: d.huisnummer,
        lon: m ? Number(m[1]) : null,
        lat: m ? Number(m[2]) : null,
        weergavenaam: d.weergavenaam,
      };
    })
    .filter((a) => a.postcode && a.huisnummer != null);

  // Cache for 30 days (addresses are stable). Empty result cached briefly.
  await redis.set(
    keys.pdokCache(pc4),
    JSON.stringify(addresses),
    'PX',
    addresses.length ? 30 * 24 * 3600 * 1000 : 6 * 3600 * 1000,
  );
  return addresses;
}

/**
 * postcode.tech: authoritative validation + enrichment (municipality, province,
 * geo). This is the required Dutch postcode source. Daily-budgeted.
 */
export async function enrichPostcode(postcode, huisnummer) {
  const url = `https://postcode.tech/api/v1/postcode/full?postcode=${postcode}&number=${huisnummer}`;
  const { body } = await fetchJson(url, {
    headers: { Authorization: `Bearer ${config.postcodeTechToken}` },
  });
  if (body?.message) return null; // "No result for this combination."
  return {
    street: body.street,
    city: body.city,
    municipality: body.municipality,
    province: body.province,
    lat: body?.geo?.lat,
    lon: body?.geo?.lon,
  };
}

/**
 * Picnic check-address: the coverage signal.
 * Returns { status: 'covered'|'waitlist'|'not_found'|'invalid'|'error', raw }.
 */
export async function checkPicnicCoverage(postcode, huisnummer) {
  const { status, body, text } = await fetchJson(config.picnicUrl, {
    method: 'POST',
    headers: config.picnicHeaders,
    body: JSON.stringify({
      country_code: 'NL',
      postcode: String(postcode),
      house_number: String(huisnummer),
    }),
  });

  // CloudFront WAF block — back off, do not treat as a coverage result.
  if (status === 403 || (text && /Request blocked|cloudfront/i.test(text) && !body?.address)) {
    throw new PicnicBlockedError();
  }

  if (body?.error) {
    const code = body.error.code;
    if (code === 'ADDRESS_NOT_FOUND') return { status: 'not_found', raw: body };
    if (code === 'INVALID_DATA') return { status: 'invalid', raw: body };
    return { status: 'error', raw: body };
  }
  if (status === 200 && body?.address) {
    // NOTE: Picnic's `waitlist_area` is the OPPOSITE of what the name suggests.
    // Empirically (confirmed against known delivery postcodes 1423/1433 and the
    // whole Randstad core), waitlist_area=true marks an area Picnic ACTIVELY
    // serves, while false marks a not-yet-served (join-the-waitlist) area.
    return {
      status: body.waitlist_area ? 'covered' : 'waitlist',
      address: body.address,
      raw: body,
    };
  }
  return { status: 'error', raw: body };
}

// ---- postcode.tech daily budget tracking ----------------------------------

function today() {
  // UTC day bucket — good enough for a daily quota.
  return new Date().toISOString().slice(0, 10);
}

export async function ptBudgetRemaining() {
  const used = Number((await redis.get(keys.ptCounter(today()))) || 0);
  return Math.max(0, config.postcodeTechDailyLimit - used);
}

export async function ptBudgetUsed() {
  return Number((await redis.get(keys.ptCounter(today()))) || 0);
}

export async function incrPtBudget() {
  const key = keys.ptCounter(today());
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 36 * 3600); // expire after the day rolls over
  return n;
}
