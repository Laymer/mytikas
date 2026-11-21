import { config } from '../config.js';
import { createPool } from '../db.js';
import { emailTick, smtpSender } from '../email.js';
import { runLoop, tick } from '../worker.js';
import { requireDemoMode, requireDemoDataset } from './dataset.js';
import { fixtureVerifier } from './fixtures.js';

requireDemoMode();
const cfg = config(), pool = createPool(cfg.databaseUrl);
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
try {
  await requireDemoDataset(pool);
  const verify = fixtureVerifier(pool), send = smtpSender(cfg);
  await runLoop('demo', () => Promise.all([
    tick(pool, undefined, cfg.origin, verify),
    emailTick(pool, cfg, send),
  ]), controller.signal);
} finally {
  await pool.end();
}
