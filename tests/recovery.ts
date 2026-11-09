import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createPool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { harness, Client, listen, close } from './harness.js';
// @ts-ignore Operational JavaScript intentionally runs without a build step.
import { restoreBackup } from '../scripts/restore.mjs';
const h = await harness();
const directory = await mkdtemp(join(tmpdir(), 'mytikas-recovery-'));
const archive = join(directory, 'backup.dump');
let target: string | undefined;
try {
  const c = new Client(h.cfg.origin);
  await c.init();
  assert.equal((await c.signup('Recovery Tester', 'recover@example.test', { motivation: 'Recovery evidence' })).status, 201);
  const before = await c.application();
  const u = new URL(h.cfg.databaseUrl);
  const dump = process.env.PG_BIN_DIR ? join(process.env.PG_BIN_DIR, 'pg_dump') : 'pg_dump';
  const fd = openSync(archive, 'wx', 0o600);
  try {
    const result = spawnSync(dump, ['-Fc'], { env: { ...process.env, PGHOST: u.hostname, PGPORT: u.port,
      PGUSER: u.username, PGPASSWORD: u.password, PGDATABASE: u.pathname.slice(1), PGSSLMODE: 'disable' },
      stdio: ['ignore', fd, 'pipe'] });
    assert.equal(result.status, 0, 'pg_dump requires PostgreSQL 18 client tools');
  } finally { closeSync(fd); }
  assert.equal((await stat(archive)).mode & 0o777, 0o600);
  assert.throws(() => openSync(archive, 'wx', 0o600), /EEXIST/);
  target = restoreBackup({ archive, connection: h.cfg.databaseUrl });
  assert.match(target!, /^mytikas_restore_/);
  assert.throws(() => restoreBackup({ archive, database: target, connection: h.cfg.databaseUrl }), /already exists/);
  assert.throws(() => restoreBackup({ archive, replace: true, connection: h.cfg.databaseUrl }), /explicit/);
  assert.throws(() => restoreBackup({ archive, database: 'postgres', replace: true, connection: h.cfg.databaseUrl }), /non-system/);
  const restoredUrl = new URL(h.cfg.databaseUrl);
  restoredUrl.pathname = `/${target}`;
  const pool = createPool(restoredUrl.href);
  const cfg = { ...h.cfg, databaseUrl: restoredUrl.href, origin: 'http://127.0.0.1' };
  const server = createServer(createApp(pool, cfg, h.verify));
  try {
    await migrate(pool);
    cfg.origin = `http://127.0.0.1:${await listen(server)}`;
    const restored = new Client(cfg.origin);
    assert.equal((await restored.login('recover@example.test')).status, 200);
    const after = await restored.application();
    assert.ok(after.application?.id);
    assert.deepEqual(after.application, before.application);
    assert.deepEqual(after.submissions, before.submissions);
    assert.deepEqual(after.events, before.events);
    for (const table of ['users', 'rules', 'discord_jobs', 'role_events']) {
      assert.deepEqual((await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows,
        (await h.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows);
    }
  } finally { await close(server); await pool.end(); }
  // The destructive branch is exercised only against this isolated restored database.
  assert.equal(restoreBackup({ archive, database: target, replace: true, connection: h.cfg.databaseUrl }), target);
  assert.equal((await h.pool.query('SELECT count(*) FROM applications')).rows[0].count, '1');
  console.log('Private custom backup/fresh restore, overwrite guards, password login, application/rules/history and explicit replacement passed.');
} finally {
  if (target) await h.pool.query(`DROP DATABASE "${target}" WITH (FORCE)`);
  await h.stop();
  await rm(directory, { recursive: true, force: true });
}
