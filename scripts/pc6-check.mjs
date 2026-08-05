// One-off sanity check for the PC6 refinement path: resolve a real address in
// each given full postcode via PDOK, then ask Picnic for its coverage.
//   docker compose run --rm --no-deps --entrypoint node app scripts/pc6-check.mjs 2461BA 2461NK
import { findAddressesInPc6, checkPicnicCoverage } from '../src/sources.js';
import { redis } from '../src/redisClient.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codes = process.argv.slice(2);

for (const pc6 of codes) {
  try {
    const [addr] = await findAddressesInPc6(pc6, 1);
    if (!addr) {
      console.log(`${pc6}: no address found`);
      continue;
    }
    const r = await checkPicnicCoverage(pc6, addr.huisnummer);
    console.log(`${pc6} (${addr.weergavenaam}) -> ${r.status}`);
  } catch (err) {
    console.log(`${pc6}: ${err.name}: ${err.message}`);
  }
  await sleep(1500);
}

await redis.quit();
