import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { harness, Client, listen, close } from './harness.js';

async function bounded<T>(promise: Promise<T>, label: string, ms = 10000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const h = await harness();
const children = new Set<ChildProcessWithoutNullStreams>();
const sockets = new Set<Socket>();
const env = {
  ...process.env, DATABASE_URL: h.cfg.databaseUrl, SESSION_SECRET: h.cfg.sessionSecret,
  APP_ORIGIN: h.cfg.origin, PUBLIC_SITE_ORIGIN: h.cfg.origin, PORT: '8080',
  DEPLOYMENT_PROFILE: 'local', MYTIKAS_DEMO: '0', INGRESS_MODE: 'none',
  DISCORD_WEBHOOK_URL: '', DATABASE_TLS: 'disable',
};
function monitored(command: string, args: string[], extraEnv: Record<string, string> = {}) {
  const child = spawn(command, args, { env: { ...env, ...extraEnv }, stdio: 'pipe', detached: true });
  children.add(child);
  let output = '';
  const changes = new EventEmitter();
  child.stdout.on('data', chunk => { output += chunk.toString(); changes.emit('output'); });
  child.stderr.on('data', chunk => { output += chunk.toString(); changes.emit('output'); });
  const exited = once(child, 'exit');
  child.once('exit', () => { children.delete(child); changes.emit('output'); });
  return {
    child, exited, output: () => output,
    async prompt(text: string) {
      let notify!: () => void;
      const waiting = new Promise<void>((resolve, reject) => {
        notify = () => {
          if (output.includes(text)) resolve();
          else if (child.exitCode !== null || child.signalCode !== null) reject(new Error('Entrypoint exited before expected prompt. Captured output withheld.'));
        };
        changes.on('output', notify);
        notify();
      });
      try { await bounded(waiting, 'entrypoint prompt'); }
      finally { changes.off('output', notify); }
    },
  };
}
async function adminFlow(email: string, password: string, repeat: string, expectedMessage: string, expectedCode: number) {
  const command = `${quote(process.execPath)} --import tsx src/admin-cli.ts`;
  const terminal = monitored('script', ['--quiet', '--return', '--flush', '--echo', 'never', '--command', command, '/dev/null']);
  await terminal.prompt('First admin email: ');
  terminal.child.stdin.write(`${email}\n`);
  await terminal.prompt('Password (12–128 characters, hidden): ');
  terminal.child.stdin.write(`${password}\n`);
  await terminal.prompt('Repeat password (hidden): ');
  terminal.child.stdin.write(`${repeat}\n`);
  const [code, signal] = await bounded(terminal.exited, 'admin CLI exit');
  assert.equal(code, expectedCode);
  assert.equal(signal, null);
  assert.ok(terminal.output().includes(expectedMessage), 'Expected admin outcome message was not emitted; captured output withheld.');
  const plain = terminal.output().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  assert.ok(!plain.includes(password), 'Password was exposed in PTY output.');
  assert.ok(!plain.includes(repeat), 'Repeated password was exposed in PTY output.');
}
async function serverProcess() {
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  const origin = `http://127.0.0.1:${port}`;
  const process = monitored(globalThis.process.execPath, ['--import', 'tsx', 'src/server.ts'], { APP_ORIGIN: origin, PUBLIC_SITE_ORIGIN: origin, PORT: String(port) });
  await process.prompt(`Mytikas listening at ${origin}`);
  for (const endpoint of ['live', 'health']) {
    const response = await fetch(`${origin}/api/${endpoint}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), endpoint === 'live' ? { live: true } : { ready: true });
  }
  return { ...process, port, origin };
}
try {
  for (const [mode, extra, expected] of [
    ['config', {}, 0], ['schema', {}, 0], ['invalid', {}, 1],
    ['config', {SMTP_USER:'fixture',SMTP_PASSWORD:''}, 1],
    ['smtp', {SMTP_HOST:'127.0.0.1',SMTP_PORT:'1'}, 1],
  ] as const) {
    const check=monitored(process.execPath,['--import','tsx','src/deployment-preflight.ts',mode],extra);
    assert.equal((await bounded(check.exited,'candidate preflight'))[0],expected);
    assert(!check.output().includes(h.cfg.databaseUrl));
    if(mode==='smtp')assert.match(check.output(),/SMTP preflight failed: connection/);
  }
  await h.pool.query("UPDATE migrations SET checksum='mismatch' WHERE name=(SELECT min(name) FROM migrations)");
  const mismatch=monitored(process.execPath,['--import','tsx','src/deployment-preflight.ts','schema']);
  assert.equal((await bounded(mismatch.exited,'schema refusal'))[0],1);
  await h.pool.query("UPDATE migrations SET checksum=NULL WHERE checksum='mismatch'");
  // Restore the fixture schema checksum using the deliberately gated legacy adoption.
  const adoption=monitored(process.execPath,['--import','tsx','src/migrate.ts'],{ADOPT_MIGRATION_CHECKSUMS:'1'});
  assert.equal((await bounded(adoption.exited,'fixture checksum restoration'))[0],0);
  const nonTty = monitored(process.execPath, ['--import', 'tsx', 'src/admin-cli.ts']);
  assert.equal((await bounded(nonTty.exited, 'noninteractive admin refusal'))[0], 1);
  assert.ok(nonTty.output().includes('Run this interactive command in a terminal'));

  await h.pool.query("UPDATE users SET role='USER' WHERE role='ADMIN'");
  const password = 'Synthetic-admin-only-password-42';
  const different = 'Synthetic-admin-only-mismatch-73';
  await adminFlow('mismatch@example.test', password, different, 'Passwords did not match.', 1);
  assert.equal((await h.pool.query("SELECT 1 FROM users WHERE email='mismatch@example.test'")).rowCount, 0);
  await adminFlow('entrypoint@example.test', password, password, 'First admin created.', 0);
  const user = (await h.pool.query("SELECT role,password_hash FROM users WHERE email='entrypoint@example.test'")).rows[0];
  assert.equal(user.role, 'ADMIN');
  assert.ok(typeof user.password_hash === 'string' && user.password_hash.startsWith('$argon2id$'), 'Bootstrap must store an Argon2id hash.');
  assert.ok(user.password_hash !== password);
  const client = new Client(h.cfg.origin);
  await client.init();
  const loggedIn = await client.request('/api/auth/login', { email: 'entrypoint@example.test', password });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.data.user.role, 'ADMIN');
  assert.equal((await client.request('/api/admin/applications')).status, 200);
  await adminFlow('second@example.test', password, password, 'An admin already exists.', 1);
  assert.equal((await h.pool.query("SELECT count(*) FROM users WHERE role='ADMIN'")).rows[0].count, '1');
  assert.equal((await h.pool.query("SELECT 1 FROM users WHERE email='second@example.test'")).rowCount, 0);

  const graceful = await serverProcess();
  assert.equal(graceful.child.kill('SIGTERM'), true);
  assert.deepEqual(await bounded(graceful.exited, 'graceful web shutdown'), [0, null]);
  const held = await serverProcess();
  const socket = connect({ host: '127.0.0.1', port: held.port });
  sockets.add(socket);
  socket.on('error', () => {});
  await bounded(once(socket, 'connect'), 'held HTTP connection');
  // 100 Continue confirms Node has parsed the full headers and is retaining an
  // active request; its intentionally incomplete body cannot finish gracefully.
  const continued = new Promise<void>((resolve, reject) => {
    let response = '';
    socket.on('data', chunk => {
      response += chunk.toString();
      if (response.includes('100 Continue')) resolve();
    });
    socket.once('close', () => reject(new Error('Held request closed before shutdown test.')));
  });
  socket.write(`POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1:${held.port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n{`);
  await bounded(continued, 'held request becomes active');
  const started = Date.now();
  assert.equal(held.child.kill('SIGTERM'), true);
  const [code, signal] = await bounded(held.exited, 'web shutdown deadline', 40000);
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.ok(Date.now() - started >= 29000, 'The forced shutdown must follow the configured drain deadline.');
  assert.ok(held.output().includes('Web shutdown deadline exceeded'));
  socket.destroy();
  sockets.delete(socket);
  console.log('Entrypoints: PTY admin bootstrap/masking/mismatch/existing-admin/login, graceful web shutdown and real 30-second drain deadline passed.');
} finally {
  for (const socket of sockets) socket.destroy();
  const cleanup = [];
  for (const child of children) {
    cleanup.push(once(child, 'exit'));
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
  try { await bounded(Promise.allSettled(cleanup), 'entrypoint child cleanup', 5000); }
  finally { await h.stop(); }
}
