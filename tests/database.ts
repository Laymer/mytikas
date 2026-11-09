import assert from 'node:assert/strict';
import { harness, Client } from './harness.js';
import { migrate } from '../src/migrate.js';
import { createPool } from '../src/db.js';
const h = await harness();
try {
  const client = new Client(h.cfg.origin);
  assert.equal((await client.signup('Database Summit')).status, 201);
  const before = await client.application();
  assert.ok(before.application?.id);
  await Promise.all([migrate(h.pool), migrate(h.pool)]);
  assert.deepEqual(await client.application(), before);
  const migration = (await h.pool.query('SELECT name,checksum FROM migrations ORDER BY name LIMIT 1')).rows[0];
  await h.pool.query('UPDATE migrations SET checksum=$2 WHERE name=$1', [migration.name, 'mismatch']);
  await assert.rejects(migrate(h.pool), /checksum mismatch/);
  await h.pool.query('UPDATE migrations SET checksum=NULL WHERE name=$1', [migration.name]);
  await assert.rejects(migrate(h.pool), /ADOPT_MIGRATION_CHECKSUMS/);
  process.env.ADOPT_MIGRATION_CHECKSUMS = '1';
  await migrate(h.pool);
  delete process.env.ADOPT_MIGRATION_CHECKSUMS;
  assert.equal((await h.pool.query('SELECT checksum FROM migrations WHERE name=$1', [migration.name])).rows[0].checksum, migration.checksum);
  assert.deepEqual(await client.application(), before);
  assert.throws(() => createPool(h.cfg.databaseUrl + '?sslmode=no-verify'), /URL SSL/);
  process.env.DATABASE_TLS = 'verify-full';
  const tlsPool = createPool(h.cfg.databaseUrl);
  try { await assert.rejects(tlsPool.query('SELECT 1')); } finally { await tlsPool.end(); }
  delete process.env.DATABASE_TLS;
  process.env.DATABASE_POOL_MAX = '0';
  assert.throws(() => createPool(h.cfg.databaseUrl), /positive integer/);
  delete process.env.DATABASE_POOL_MAX;
  console.log('✓ Concurrent migrations, checksum enforcement/adoption, data preservation, TLS fail closed and pool validation');
} finally { await h.stop(); }
