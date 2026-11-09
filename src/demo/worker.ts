import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { createPool } from '../db.js';
import { emailTick, smtpSender } from '../email.js';
import { tick } from '../worker.js';
import { fixtureVerifier } from './fixtures.js';
process.env.MYTIKAS_DEMO = '1';
const cfg = config(), pool = createPool(cfg.databaseUrl);
const send=smtpSender(cfg);
let running = true;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { running = false; });
while (running) {
  try { await Promise.all([tick(pool, undefined, cfg.origin, fixtureVerifier(pool)),emailTick(pool,cfg,send)]); }
  catch { console.error('Demo worker cycle failed'); }
  if (running) await sleep(5000);
}
await pool.end();
