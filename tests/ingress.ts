import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { config, type Config } from '../src/config.js';
import { createApp, clientIdentity, isLoopbackIngress } from '../src/app.js';
import type { Request } from 'express';
import type { Pool } from '../src/db.js';

const saved = { ...process.env };
try {
  for (const name of ['MYTIKAS_DEMO', 'DEMO_PASSWORD', 'DEPLOYMENT_PROFILE', 'PUBLIC_SITE_ORIGIN', 'INGRESS_MODE', 'PORT', 'DISCORD_WEBHOOK_URL']) delete process.env[name];
  Object.assign(process.env, { DATABASE_URL: 'postgres://test:test@localhost/test', SESSION_SECRET: 'a'.repeat(40), APP_ORIGIN: 'http://localhost:8080' });
  assert.equal(config().ingressMode, 'none');
  process.env.PORT = '0';
  assert.throws(config, /PORT/);
  process.env.PORT = '8080';
  process.env.EMAIL_OUTBOX_KEY='12'.repeat(32);process.env.SMTP_HOST='smtp.example.test';process.env.EMAIL_FROM='guild@example.test';
  process.env.DEPLOYMENT_PROFILE = 'public';
  assert.throws(config, /HTTPS/);
  Object.assign(process.env, { APP_ORIGIN: 'https://app.mytikas.monster', PUBLIC_SITE_ORIGIN: 'https://mytikas.monster', INGRESS_MODE: 'cloudflare-loopback' });
  assert.equal(config().secureCookies, true);
  process.env.DEMO_PASSWORD = 'demo-only';
  assert.throws(config, /demo credentials/);
  delete process.env.DEMO_PASSWORD;
  process.env.MYTIKAS_DEMO = '1';
  assert.throws(config, /Demo/);
} finally { process.env = saved; }
const cfg: Config = { databaseUrl: '', sessionSecret: 'a'.repeat(40), origin: 'https://app.mytikas.monster', publicSiteOrigin: 'https://mytikas.monster', port: 8080, secureCookies: true, deploymentProfile: 'public', ingressMode: 'cloudflare-loopback' };
const request = (peer: string, header: string) => ({ socket: {remoteAddress: peer}, get: () => header }) as unknown as Request;
assert(isLoopbackIngress('::ffff:127.0.0.1'));
assert(!isLoopbackIngress('127.0.0.2'));
assert.equal(clientIdentity(request('127.0.0.1', '203.0.113.7'), cfg), '203.0.113.7');
assert.equal(clientIdentity(request('127.0.0.1', '203.0.113.8'), cfg), '203.0.113.8');
assert.equal(clientIdentity(request('192.0.2.5', '203.0.113.7'), cfg), '192.0.2.5');
assert.equal(clientIdentity(request('127.0.0.1', '1.2.3.4, 5.6.7.8'), cfg), '127.0.0.1');
assert.equal(clientIdentity(request('127.0.0.1', '203.0.113.7'), {...cfg, deploymentProfile: 'local', ingressMode: 'none'}), '127.0.0.1');
let unavailable = false;
const schema = await Promise.all((await readdir('migrations')).filter(n => n.endsWith('.sql')).sort().map(async name => ({name, checksum:createHash('sha256').update(await readFile(`migrations/${name}`)).digest('hex')})));
let incompatible = false;
const pool = { query: async () => { if (unavailable) throw new Error('private database details'); return { rows: incompatible ? [] : schema }; } } as unknown as Pool;
const application = createApp(pool, cfg);
const trust = application.get('trust proxy');
assert.equal(trust('127.0.0.1', 0), true);
assert.equal(trust('::ffff:127.0.0.1', 0), true);
assert.equal(trust('192.0.2.7', 0), false);
assert.equal(trust('127.0.0.1', 1), false);
assert.equal(createApp(pool, {...cfg, ingressMode: 'none'}).get('trust proxy'), false);
const server = createServer(application);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
try {
  let response = await fetch(origin + '/api/availability', { headers: { Origin: cfg.publicSiteOrigin! }});
  assert.deepEqual(await response.json(), {ready:true});
  assert.equal(response.headers.get('access-control-allow-origin'), cfg.publicSiteOrigin);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  response = await fetch(origin + '/api/availability', {headers:{Origin:'https://hostile.invalid'}});
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  incompatible = true;
  response = await fetch(origin + '/api/health');
  assert.equal(response.status,503);
  incompatible = false;
  unavailable = true;
  response = await fetch(origin + '/api/availability');
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(), {ready:false});
  response = await fetch(origin + '/api/live');
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{live:true});
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
console.log('Ingress/configuration contracts passed.');

// Exercise express-session against a real isolated store behind the loopback ingress.
const { harness, close, listen } = await import('./harness.js');
const h = await harness();
const secureServer = createServer(createApp(h.pool, { ...h.cfg, ...cfg, databaseUrl: h.cfg.databaseUrl }));
const securePort = await listen(secureServer);
try {
  let response = await fetch(`http://127.0.0.1:${securePort}/api/auth/me`, {headers:{'X-Forwarded-Proto':'https'}});
  const cookie = response.headers.get('set-cookie') || '';
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert(!cookie.includes('Domain='));
  response = await fetch(`http://127.0.0.1:${securePort}/api/auth/me`);
  assert.equal(response.headers.get('set-cookie'),null);
  response = await fetch(h.cfg.origin + '/api/auth/me', {headers:{'X-Forwarded-Proto':'https'}});
  assert(!response.headers.get('set-cookie')?.includes('; Secure'));
  const { csrfToken } = await response.json();
  const localCookie = response.headers.get('set-cookie')!.split(';')[0]!;
  response = await fetch(h.cfg.origin + '/api/auth/logout', {method:'POST', headers:{Cookie:localCookie, Origin:'https://hostile.invalid', 'X-CSRF-Token':csrfToken,'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,403);
} finally { await close(secureServer); await h.stop(); }
console.log('Secure cookie, local HTTP, and hostile-origin checks passed.');
