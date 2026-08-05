import { launch } from 'cloakbrowser';

// One CloakBrowser instance per prober pod, reused across every probe.
// The stealth-modified Chromium binary is ~200MB and takes seconds to start,
// so launching per request would dominate probe time and quickly OOM the pod.
let browserPromise = null;
let contextPromise = null;

async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = launch({
    headless: true,
    locale: 'nl-NL',
    timezone: 'Europe/Amsterdam',
    // Container Chromium can't create user namespaces; --no-sandbox lets it run
    // as root inside the pod. Acceptable since we only ever POST to picnic.app.
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  }).catch((err) => {
    browserPromise = null;
    throw err;
  });
  return browserPromise;
}

async function getContext() {
  if (contextPromise) return contextPromise;
  contextPromise = (async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext();
    // Fingerprint (UA, platform, headers) comes from CloakBrowser's spoofing;
    // we only set the site-specific origin/referer the endpoint expects.
    await ctx.setExtraHTTPHeaders({
      origin: 'https://picnic.app',
      referer: 'https://picnic.app/nl/online-supermarkt/bezorging/',
    });
    return ctx;
  })().catch((err) => {
    contextPromise = null;
    throw err;
  });
  return contextPromise;
}

/** Eager warm-up so a launch failure surfaces at boot, not on the first probe. */
export async function initPicnicClient() {
  await getContext();
}

export async function closePicnicClient() {
  const ctxP = contextPromise;
  const brP = browserPromise;
  contextPromise = null;
  browserPromise = null;
  try {
    if (ctxP) (await ctxP).close();
  } catch { /* ignore */ }
  try {
    if (brP) (await brP).close();
  } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST JSON to Picnic through CloakBrowser's request context.
 * Same return shape as fetchJson: { status, body, text }.
 * Retries transient 429/5xx with exponential backoff, matching the fetch path.
 */
export async function postJson(url, jsonBody, { retries = 3, backoffMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctx = await getContext();
      const res = await ctx.request.post(url, {
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          accept: 'application/json, text/plain, */*',
        },
        data: jsonBody,
        timeout: 20000,
      });
      const status = res.status();
      if (status === 429 || status >= 500) {
        throw new Error(`HTTP ${status}`);
      }
      const text = await res.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      return { status, body, text };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(backoffMs * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}
