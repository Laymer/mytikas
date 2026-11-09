import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createPool } from '../src/db.js';
import { deliverDiscord } from '../src/discord.js';
import { harness, Client, listen, close } from './harness.js';

async function bounded<T>(promise: Promise<T>, label: string, ms = 10000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function barrier() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

// A genuine short-lived delivery process lets the parent kill a worker after the
// remote fixture has accepted its request but before the database acknowledgement.
if (process.argv.includes('--deliver-one')) {
  const pool = createPool(process.env.RACE_DATABASE_URL!);
  try { await deliverDiscord(pool, process.env.RACE_WEBHOOK, process.env.RACE_ORIGIN!); }
  finally { await pool.end(); }
} else {
  const h = await harness();
  const competitor = createPool(h.cfg.databaseUrl);
  const messages: unknown[] = [];
  let gate: { arrived: ReturnType<typeof barrier>; reply: ReturnType<typeof barrier> } | undefined;
  const children = new Set<ChildProcess>();
  const pending: Promise<unknown>[] = [];
  const fixture = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      messages.push(JSON.parse(raw));
      const current = gate;
      current?.arrived.release();
      if (current) await current.reply.promise;
      if (!res.destroyed) { res.statusCode = 204; res.end(); }
    } catch { if (!res.destroyed) { res.statusCode = 500; res.end(); } }
  });
  const webhook = `http://127.0.0.1:${await listen(fixture)}/discord`;
  const makeJob = async (name: string) => {
    const applicant = new Client(h.cfg.origin);
    assert.equal((await applicant.signup(name)).status, 201);
    const { application, submissions } = await applicant.application();
    const result = await h.pool.query('SELECT * FROM discord_jobs WHERE submission_id=$1', [submissions[0].id]);
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].status, 'PENDING');
    return { id: result.rows[0].id as string, application, submission: submissions[0] };
  };
  const jobState = async (id: string) => (await h.pool.query('SELECT * FROM discord_jobs WHERE id=$1', [id])).rows[0];
  const childDelivery = () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/worker-races.ts', '--deliver-one'], {
      env: { ...process.env, RACE_DATABASE_URL: h.cfg.databaseUrl, RACE_WEBHOOK: webhook, RACE_ORIGIN: h.cfg.origin },
      stdio: 'ignore',
    });
    children.add(child);
    const exit = once(child, 'exit');
    child.once('exit', () => children.delete(child));
    return { child, exit };
  };
  try {
    const overlapping = await makeJob('Overlap Worker');
    gate = { arrived: barrier(), reply: barrier() };
    const first = deliverDiscord(h.pool, webhook, h.cfg.origin);
    pending.push(first);
    await bounded(gate.arrived.promise, 'first worker reaches Discord');
    assert.equal((await jobState(overlapping.id)).attempts, 1);
    assert.equal(await bounded(deliverDiscord(competitor, webhook, h.cfg.origin), 'competing worker exits'), false);
    assert.equal(messages.length, 1, 'Advisory lock prevents simultaneous duplicate delivery');
    assert.equal((await jobState(overlapping.id)).attempts, 1, 'Losing worker does not increment attempts');
    gate.reply.release();
    await bounded(first, 'first worker acknowledges');
    gate = undefined;
    assert.equal((await jobState(overlapping.id)).status, 'DELIVERED');
    assert.equal(await deliverDiscord(competitor, webhook, h.cfg.origin), false);
    assert.equal(messages.length, 1, 'Acknowledged jobs are not delivered again');

    const leased = await makeJob('Leased Worker');
    const oldToken = randomUUID();
    await h.pool.query("UPDATE discord_jobs SET attempts=1,lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1", [leased.id, oldToken]);
    assert.equal(await deliverDiscord(competitor, webhook, h.cfg.origin), false, 'Live lease is respected');
    assert.equal(messages.length, 1);
    await h.pool.query("UPDATE discord_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [leased.id]);
    assert.equal(await deliverDiscord(competitor, webhook, h.cfg.origin), true, 'Expired lease is reclaimed');
    const reclaimed = await jobState(leased.id);
    assert.equal(reclaimed.status, 'DELIVERED');
    assert.equal(reclaimed.attempts, 2);
    assert.equal(reclaimed.lease_token, null);
    assert.equal(reclaimed.lease_until, null);
    assert.ok(reclaimed.delivered_at);

    const crashed = await makeJob('Crash Worker');
    gate = { arrived: barrier(), reply: barrier() };
    const original = childDelivery();
    await bounded(gate.arrived.promise, 'crashing worker reaches accepted-request boundary');
    const accepted = messages.at(-1);
    const claimed = await jobState(crashed.id);
    assert.equal(claimed.status, 'PENDING');
    assert.equal(claimed.attempts, 1);
    assert.ok(claimed.lease_token);
    assert.equal(claimed.delivered_at, null);
    assert.equal(original.child.kill('SIGKILL'), true);
    const [code, signal] = await bounded(original.exit, 'crashed worker exits');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    gate.reply.release();
    gate = undefined;
    // A blocking acquisition is a deterministic barrier for PostgreSQL observing
    // the crashed connection closing and releasing its session advisory lock.
    const lock = await h.pool.connect();
    try {
      await bounded(lock.query('SELECT pg_advisory_lock(3)'), 'crashed connection releases lock');
      await lock.query('SELECT pg_advisory_unlock(3)');
    } finally { lock.release(); }
    assert.equal(await deliverDiscord(competitor, webhook, h.cfg.origin), false, 'Restart must wait for the crashed lease to expire');
    assert.equal(messages.length, 3);
    await h.pool.query("UPDATE discord_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [crashed.id]);
    const restarted = childDelivery();
    const [restartCode, restartSignal] = await bounded(restarted.exit, 'fresh delivery process recovers expired job');
    assert.equal(restartCode, 0);
    assert.equal(restartSignal, null);
    assert.equal(messages.length, 4, 'Accepted but unacknowledged requests may be delivered twice');
    assert.deepEqual(messages.at(-1), accepted, 'Crash retry retains the same immutable submission reference and payload');
    const recovered = await jobState(crashed.id);
    assert.equal(recovered.status, 'DELIVERED');
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.lease_token, null);
    assert.ok(recovered.delivered_at);
    assert.equal(await deliverDiscord(competitor, webhook, h.cfg.origin), false);
    console.log('Worker races: overlapping claims, live/expired leases, SIGKILL recovery and at-least-once immutable delivery passed (local fixtures only).');
  } finally {
    gate?.reply.release();
    for (const child of children) child.kill('SIGKILL');
    await Promise.allSettled(pending);
    await close(fixture);
    await competitor.end();
    await h.stop();
  }
}
