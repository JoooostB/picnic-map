// Single entrypoint for the whole image — behaviour is selected by APP_ROLE:
//   server | prober | all (default)
// This keeps one image/build for both the web server and the DaemonSet probers.
import { config } from './config.js';
import { startServer } from './server.js';
import { startProber, startHealthServer } from './prober.js';

const role = config.role;
console.log(`[boot] starting role=${role} id=${config.proberId}`);

if (role === 'server' || role === 'all') {
  startServer().catch((e) => console.error('[boot] server failed:', e));
}

if (role === 'prober' || role === 'all') {
  // In 'all' mode the web server already provides HTTP; prober-only pods need
  // their own minimal health endpoint for k8s probes.
  if (role === 'prober') startHealthServer();
  if (config.probeEnabled) {
    startProber().catch((e) => console.error('[boot] prober failed:', e));
  }
}

if (!['server', 'prober', 'all'].includes(role)) {
  console.error(`[boot] unknown APP_ROLE "${role}" — use server | prober | all`);
  process.exit(1);
}
