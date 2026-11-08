import { config } from '../config.js';
import { createPool } from '../db.js';
import { createApp } from '../app.js';
import { fixtureVerifier } from './fixtures.js';
process.env.MYTIKAS_DEMO = '1';
const cfg = config(), pool = createPool(cfg.databaseUrl);
const server = createApp(pool, cfg, fixtureVerifier(pool)).listen(cfg.port, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { void pool.end(); }));
