// Headless screenshots of the map UI, for verifying rendering changes.
// Run via the zenika/alpine-chrome:with-puppeteer image on the compose network:
//   docker run --rm --network picnic-map_default -v "$PWD/scripts:/s:ro" \
//     -v "$PWD/shots:/out" --entrypoint node zenika/alpine-chrome:with-puppeteer /s/shoot.mjs
import puppeteer from 'puppeteer';

const BASE = process.env.BASE_URL || 'http://app:3000';
const OUT = process.env.OUT_DIR || '/out';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium-browser',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });

const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));

// The page holds an SSE stream open, so networkidle never fires — wait on the
// DOM signals that actually mean "the map has data".
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('.leaflet-overlay-pane path', { timeout: 60000 });
await page.waitForFunction(() => document.getElementById('cntCovered').textContent !== '0', {
  timeout: 60000,
});
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${OUT}/overview.png` });

// Zoom to the 2461 (Ter Aar / Langeraar) area to exercise the PC6 detail layer.
// `map` is a top-level const in a classic script: global lexical scope, not window.
await page.evaluate(() => map.setView([52.18, 4.71], 12));
await new Promise((r) => setTimeout(r, 6000));
await page.screenshot({ path: `${OUT}/detail-2461.png` });

const stripes = await page.evaluate(() => ({
  pattern: !!document.querySelector('#partialStripes'),
  legend: document.getElementById('cntPartial')?.parentElement?.textContent?.trim(),
  partialCount: document.getElementById('cntPartial')?.textContent,
  detailLayers: document.querySelectorAll('.leaflet-overlay-pane path').length,
}));
console.log(JSON.stringify(stripes));
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'no console errors');

await browser.close();
