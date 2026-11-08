import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { harness, PASS } from './harness.js';
import { seed } from '../src/demo/seed.js';
import { fixtureVerifier } from '../src/demo/fixtures.js';
import { checkMembership } from '../src/armory.js';
import { transition } from '../src/applications.js';
import { tick } from '../src/worker.js';
const h = await harness();
const originalFetch = globalThis.fetch;
let liveCalls = 0;
globalThis.fetch = async () => { liveCalls++; throw new Error('Unexpected live request'); };
try {
  await assert.rejects(seed(h.pool,PASS), /populated/);
  assert.equal((await h.pool.query("SELECT to_regclass('demo_dataset') AS t")).rows[0].t,null);
  await h.pool.query('DELETE FROM users');
  // Force a mid-seed error, then prove all inserted data and DDL rolled back.
  await h.pool.query(`CREATE FUNCTION fail_demo_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.email='reopened@demo.test' THEN RAISE EXCEPTION 'injected seed failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_demo BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION fail_demo_seed()`);
  await assert.rejects(seed(h.pool,PASS),/injected seed failure/);
  assert.equal((await h.pool.query('SELECT count(*) FROM users')).rows[0].count,'0');
  assert.equal((await h.pool.query('SELECT count(*) FROM rules')).rows[0].count,'1');
  await h.pool.query('DROP TRIGGER fail_demo ON users; DROP FUNCTION fail_demo_seed()');
  await seed(h.pool,PASS);
  const users = (await h.pool.query('SELECT * FROM users')).rows;
  assert.equal(users.length,9);
  for (const user of users) assert(await argon2.verify(user.password_hash,PASS));
  assert.equal(users.filter(u=>u.role==='ADMIN').length,1);
  assert.equal(users.filter(u=>u.role==='MODERATOR').length,1);
  assert.equal((await h.pool.query('SELECT count(*) FROM submissions')).rows[0].count,'8');
  assert.equal((await h.pool.query("SELECT count(DISTINCT rules_id) FROM submissions")).rows[0].count,'2');
  assert.equal((await h.pool.query("SELECT count(*) FROM discord_jobs WHERE status<>'DISABLED'")).rows[0].count,'0');
  for (const app of (await h.pool.query('SELECT * FROM applications')).rows) {
    const events = (await h.pool.query('SELECT * FROM events WHERE application_id=$1 ORDER BY id',[app.id])).rows;
    let status = null;
    for (const event of events) { assert.equal(event.from_status,status); status=event.to_status; }
    assert.equal(status,app.status);
    assert.equal((await h.pool.query('SELECT max(revision) AS r FROM submissions WHERE application_id=$1',[app.id])).rows[0].r,app.revision);
  }
  const verify = fixtureVerifier(h.pool);
  assert.equal(await verify('Unknown Person'),'PROFILE_NOT_FOUND');
  assert.equal(await verify('Demo Submitted'),'MATCH');
  assert.equal(await verify('Demo Approved'),'GUILD_MISMATCH');
  for (const [state,result] of [['missing','PROFILE_NOT_FOUND'],['unavailable','UNAVAILABLE'],['outsider','GUILD_MISMATCH'],['member','MATCH']]) {
    await h.pool.query("UPDATE demo_fixtures SET state=$1 WHERE character_key='demo approved'",[state]);
    assert.equal(await verify('Demo Approved'),result);
  }
  const approved = (await h.pool.query("SELECT * FROM applications WHERE character_key='demo approved'")).rows[0];
  await h.pool.query("UPDATE demo_fixtures SET state='outsider' WHERE character_key='demo approved'");
  assert.equal(await checkMembership(h.pool,approved.id,verify),'GUILD_MISMATCH');
  await assert.rejects(checkMembership(h.pool,approved.id,verify),/last minute/);
  const admin = users.find(u=>u.role==='ADMIN')!;
  const submitted = (await h.pool.query("SELECT id FROM applications WHERE character_key='demo submitted'")).rows[0];
  await transition(h.pool,submitted.id,'approve',admin.id);
  await tick(h.pool,undefined,h.cfg.origin,verify);
  assert.equal((await h.pool.query('SELECT status FROM applications WHERE id=$1',[submitted.id])).rows[0].status,'JOINED');
  await seed(h.pool,PASS);
  assert.equal((await h.pool.query('SELECT status FROM applications WHERE id=$1',[submitted.id])).rows[0].status,'JOINED');
  assert.equal((await h.pool.query('SELECT count(*) FROM users')).rows[0].count,'9');
  assert.equal(h.discord.messages.length,0);
  assert.equal(liveCalls,0);
  console.log('✓ Demo atomicity, repeatability, passwords/roles, history, fixtures, cooldown, automatic joining and disabled Discord');
} finally { globalThis.fetch = originalFetch; await h.stop(); }
