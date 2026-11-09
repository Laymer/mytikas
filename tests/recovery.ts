// @ts-ignore Shared SQL fixture also runs in the machine container suite.
import { recoveryFixture, recoveryRemoved } from './recovery-fixture.mjs';
import { emailTick, captureTransport } from '../src/email.js';
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
  await h.pool.query(recoveryFixture(h.cfg.emailOutboxKey));
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
    // Compare every persisted row and sequence before any request changes sessions.
    const tables=(await h.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    for(const {tablename} of tables) {
      assert.match(tablename,/^[a-z_]+$/);
      const query=`SELECT row_to_json(t) AS row FROM "${tablename}" t ORDER BY row_to_json(t)::text`;
      assert.deepEqual((await pool.query(query)).rows,(await h.pool.query(query)).rows,tablename);
    }
    const sequences="SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename";
    assert.deepEqual((await pool.query(sequences)).rows,(await h.pool.query(sequences)).rows);
    await migrate(pool);
    const capture=captureTransport(), diagnostics: string[]=[];
    const originalError=console.error;
    console.error=(message: string)=>diagnostics.push(message);
    try {
      for(const key of [undefined,'ff'.repeat(32)]) {
        await pool.query("UPDATE email_jobs SET available_at=now() WHERE status='PENDING'");
        await emailTick(pool,{...cfg,emailOutboxKey:key},capture.send);
        assert.equal(capture.messages.length,0);
      }
      assert.equal(diagnostics.length,2);
      for(const line of diagnostics)assert.deepEqual(Object.keys(JSON.parse(line)).sort(),['attempt','category','event','jobId','outcome']);
      assert(diagnostics.every(line=>JSON.parse(line).category==='payload'));
      await pool.query("UPDATE email_jobs SET available_at=now() WHERE status='PENDING'");
      await emailTick(pool,cfg,capture.send);
      assert.equal(capture.messages.length,1);
      assert.equal(capture.messages[0]!.subject,'Recovery fixture');
    } finally { console.error=originalError; }
    assert.equal((await pool.query('SELECT count(*) FROM roster_slots WHERE application_id=$1',[recoveryRemoved])).rows[0].count,'0');
    cfg.origin = `http://127.0.0.1:${await listen(server)}`;
    const restored = new Client(cfg.origin);
    assert.equal((await restored.login('recover@example.test')).status, 200);
    const after = await restored.application();
    assert.ok(after.application?.id);
    assert.deepEqual(after.application, before.application);
    assert.deepEqual(after.submissions, before.submissions);
    assert.deepEqual(after.events, before.events);
    const administrator=new Client(cfg.origin);await administrator.login();
    assert.equal((await administrator.request(`/api/admin/applications/${recoveryRemoved}/restore`,{note:'Isolated restore acceptance'})).status,200);
    assert.equal((await pool.query('SELECT count(*) FROM roster_slots WHERE application_id=$1',[recoveryRemoved])).rows[0].count,'0');
    const preserved=new Client(cfg.origin);preserved.cookie=c.cookie;
    assert.equal((await preserved.init()).data.user.email,'recover@example.test');
    const versioned=new Client(cfg.origin);
    assert.equal((await versioned.login('fixture.recovery@example.test')).status,200);
    assert.equal((await versioned.init()).data.user.email,'fixture.recovery@example.test');
    await pool.query("UPDATE users SET auth_version=auth_version+1 WHERE email='fixture.recovery@example.test'");
    assert.equal((await versioned.init()).data.user,null);
    await pool.query("UPDATE users SET auth_version=auth_version-1 WHERE email='fixture.recovery@example.test'");
    for (const table of ['users', 'rules', 'discord_jobs', 'role_events']) {
      assert.deepEqual((await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows,
        (await h.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows);
    }
  } finally { await close(server); await pool.end(); }
  // The destructive branch is exercised only against this isolated restored database.
  assert.equal(restoreBackup({ archive, database: target, replace: true, connection: h.cfg.databaseUrl }), target);
  assert.equal((await h.pool.query('SELECT count(*) FROM applications')).rows[0].count, '3');
  console.log('Private custom backup/fresh restore, overwrite guards, password login, application/rules/history and explicit replacement passed.');
} finally {
  if (target) await h.pool.query(`DROP DATABASE "${target}" WITH (FORCE)`);
  await h.stop();
  await rm(directory, { recursive: true, force: true });
}
