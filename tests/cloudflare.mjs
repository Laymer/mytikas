import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, apiClient, privateRead } from '../scripts/cloudflare.mjs';

const ACCOUNT = 'a'.repeat(32), ZONE = 'b'.repeat(32);
const TUNNEL = '12345678-abcd-1234-abcd-123456789abc';
const TOKEN = 'synthetic_tunnel_token_for_tests_only';
const API_TOKEN = 'synthetic_api_token_for_tests_only';
const HOST = 'app.mytikas.monster';
const CONFIG = { ingress: [{ hostname: HOST, service: 'http://127.0.0.1:8080' }, { service: 'http_status:404' }] };
const zone = () => ({ id: ZONE, name: 'mytikas.monster', account: { id: ACCOUNT }, status: 'pending', name_servers: ['a.ns.example.test', 'b.ns.example.test'] });
const tunnel = () => ({ id: TUNNEL, name: 'mytikas-public', config_src: 'cloudflare', deleted_at: null });
const appRecord = () => ({ id: 'app-record', type: 'CNAME', name: HOST, content: `${TUNNEL}.cfargotunnel.com`, proxied: true });
const originalRecords = () => [
  { id: 'apex', type: 'A', name: 'mytikas.monster', content: '192.0.2.1', proxied: false },
  { id: 'www', type: 'CNAME', name: 'www.mytikas.monster', content: 'example.github.io', proxied: false },
  { id: 'mail', type: 'MX', name: 'mytikas.monster', content: 'mail.example.test', priority: 10 },
  { id: 'verification', type: 'TXT', name: '_github-pages-challenge-Laymer.mytikas.monster', content: 'synthetic-verification' },
];
const clone = value => structuredClone(value);
function provider(options = {}) {
  const state = { zone: options.zone === undefined ? zone() : clone(options.zone), tunnel: options.tunnel === undefined ? null : clone(options.tunnel),
    config: clone(options.config ?? null), records: clone(options.records ?? originalRecords()), token: options.token ?? TOKEN };
  const calls = [];
  const api = async (path, method = 'GET', body) => {
    const url = new URL(path, 'https://fixture.invalid');
    const call = { path, route: url.pathname, page: Number(url.searchParams.get('page')), method, body: clone(body) };
    calls.push(call);
    const intercepted = await options.intercept?.(call, state);
    if (intercepted !== undefined) return intercepted;
    const list = result => ({ result, result_info: { total_pages: 1 } });
    if (method === 'GET' && call.route === '/accounts') return list([{ id: ACCOUNT }]);
    if (method === 'GET' && call.route === '/zones') return list(state.zone ? [clone(state.zone)] : []);
    if (method === 'POST' && call.route === '/zones') { assert.equal(state.zone, null); state.zone = zone(); return { result: clone(state.zone) }; }
    if (call.route === `/accounts/${ACCOUNT}/cfd_tunnel`) {
      if (method === 'GET') return list(state.tunnel ? [clone(state.tunnel)] : []);
      if (method === 'POST') { assert.equal(state.tunnel, null); state.tunnel = tunnel(); return { result: clone(state.tunnel) }; }
    }
    if (call.route === `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`) {
      if (method === 'PUT') state.config = clone(body.config);
      return { result: { config: clone(state.config) } };
    }
    if (method === 'GET' && call.route === `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/token`) return { result: state.token };
    if (call.route === `/zones/${ZONE}/dns_records`) {
      if (method === 'GET') return list(clone(state.records));
      if (method === 'POST') { state.records.push({ id: 'new-record', ...clone(body) }); return { result: clone(state.records.at(-1)) }; }
    }
    throw new Error('Unexpected fake API request.');
  };
  return { state, calls, api, mutations: () => calls.filter(c => c.method !== 'GET') };
}
const root = await mkdtemp(join(tmpdir(), 'mytikas-cloudflare-tests-'));
let count = 0;
async function scenario(name, fn) {
  const directory = join(root, String(++count));
  await mkdir(directory, { mode: 0o700 });
  const logs = [];
  const run = (fake, command = 'apply', extra = {}) => setup({ command, directory, api: fake.api, log: line => logs.push(line), ...extra });
  await fn({ directory, logs, run });
  assert.ok(!logs.join('\n').includes(TOKEN));
  assert.ok(!logs.join('\n').includes(API_TOKEN));
  console.log(`✓ Cloudflare fixture: ${name}`);
}
const put = (directory, file, value) => writeFile(join(directory, file), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
try {
  await scenario('create resources, preserve complete DNS inventory and repeat safely', async ({ directory, run }) => {
    const fake = provider({ zone: null });
    const previous = clone(fake.state.records);
    await run(fake);
    assert.deepEqual(fake.state.records.slice(0, previous.length), previous);
    assert.deepEqual(fake.state.config, CONFIG);
    assert.equal(fake.state.records.at(-1).name, HOST);
    assert.equal(fake.state.records.at(-1).proxied, true);
    assert.equal(privateRead(join(directory, 'tunnel-token')), `${TOKEN}\n`);
    const state = JSON.parse(privateRead(join(directory, 'cloudflare-state.json')));
    assert.equal(state.accountId, ACCOUNT); assert.equal(state.zoneId, ZONE); assert.equal(state.tunnelId, TUNNEL);
    const mutationCount = fake.mutations().length;
    assert.equal(mutationCount, 4, 'Only zone, tunnel, route and app DNS are created');
    await run(fake);
    assert.equal(fake.mutations().length, mutationCount, 'Repeated apply does not mutate Cloudflare');
    const files = await readdir(directory);
    assert.equal(files.filter(f => f.startsWith('cloudflare-before-')).length, 2);
    assert.ok(!files.some(f => f.includes('.tmp') || f.endsWith('.lock')));
    for (const file of files) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const snapshots = await Promise.all(files.filter(f => f.startsWith('cloudflare-before-')).map(async f => JSON.parse(await readFile(join(directory, f), 'utf8'))));
    assert.ok(snapshots.some(s => s.zone === null && JSON.stringify(s.records) === '[]'));
    assert.ok(snapshots.some(s => s.records.some(r => r.type === 'MX')));
  });
  await scenario('plan is read-only and existing records remain unchanged', async ({ directory, run }) => {
    const fake = provider({ tunnel: tunnel(), config: CONFIG, records: [...originalRecords(), appRecord()] });
    await put(directory, 'tunnel-token', `${TOKEN}\n`);
    const stateBefore = clone(fake.state);
    const filesBefore = await readdir(directory);
    await run(fake, 'plan');
    assert.equal(fake.mutations().length, 0); assert.deepEqual(fake.state, stateBefore);
    assert.deepEqual(await readdir(directory), filesBefore);
    assert.equal(privateRead(join(directory, 'tunnel-token')), `${TOKEN}\n`);
  });
  await scenario('existing apex/mail/verification records are backed up before app addition', async ({ directory, run }) => {
    const fake = provider();
    const records = clone(fake.state.records);
    await run(fake);
    const snapshotFile = (await readdir(directory)).find(f => f.startsWith('cloudflare-before-'));
    assert.deepEqual(JSON.parse(await readFile(join(directory, snapshotFile), 'utf8')).records, records);
    assert.deepEqual(fake.state.records.slice(0, records.length), records);
    assert.ok(fake.mutations().every(c => ['POST', 'PUT'].includes(c.method)));
  });
  await scenario('resume after tunnel creation but before route configuration', async ({ directory, run }) => {
    let failOnce = true;
    const fake = provider({ intercept(call) { if (call.method === 'PUT' && failOnce) { failOnce = false; throw new Error('Simulated interruption'); } } });
    await assert.rejects(run(fake), /Simulated interruption/);
    assert.equal(JSON.parse(privateRead(join(directory, 'cloudflare-state.json'))).tunnelId, TUNNEL);
    assert.ok(!(await readdir(directory)).includes('cloudflare-setup.lock'));
    await run(fake);
    assert.equal(fake.calls.filter(c => c.method === 'POST' && c.route.endsWith('cfd_tunnel')).length, 1);
    assert.equal(fake.state.records.filter(r => r.name === HOST).length, 1);
  });
  await scenario('resume after saving token but before DNS addition', async ({ directory, run }) => {
    let failOnce = true;
    const fake = provider({ intercept(call) { if (call.method === 'POST' && call.route.endsWith('dns_records') && failOnce) { failOnce = false; throw new Error('Simulated DNS interruption'); } } });
    await assert.rejects(run(fake), /Simulated DNS interruption/);
    assert.equal(privateRead(join(directory, 'tunnel-token')), `${TOKEN}\n`);
    await run(fake);
    assert.equal(fake.state.records.filter(r => r.name === HOST).length, 1);
    assert.equal(fake.calls.filter(c => c.method === 'POST' && c.route.endsWith('cfd_tunnel')).length, 1);
  });
  for (const [name, options, saved, expected] of [
    ['conflicting app record', { records: [...originalRecords(), { ...appRecord(), type: 'A', content: '192.0.2.9' }] }, null, /DNS record already exists/],
    ['unproxied app record', { tunnel: tunnel(), config: CONFIG, records: [ { ...appRecord(), proxied: false } ] }, null, /DNS record already exists/],
    ['different tunnel route', { tunnel: tunnel(), config: { ingress: [{ hostname: 'private.example.test', service: 'http://private:80' }] } }, null, /configuration differs/],
    ['local managed tunnel', { tunnel: { ...tunnel(), config_src: 'local' } }, null, /not remotely managed/],
    ['unexpected origin settings', { tunnel: tunnel(), config: { ...CONFIG, originRequest: { noTLSVerify: true } } }, null, /configuration differs/],
    ['WARP routing enabled', { tunnel: tunnel(), config: { ...CONFIG, 'warp-routing': { enabled: true } } }, null, /configuration differs/],
    ['zone account mismatch', { zone: { ...zone(), account: { id: 'c'.repeat(32) } } }, null, /different account/],
    ['saved zone disappeared', { zone: null }, { accountId: ACCOUNT, zoneId: ZONE }, /Saved zone/],
    ['saved tunnel disappeared', {}, { accountId: ACCOUNT, tunnelId: TUNNEL }, /Saved tunnel/],
  ]) await scenario(name, async ({ directory, run }) => {
    const fake = provider(options); if (saved) await put(directory, 'cloudflare-state.json', saved);
    await assert.rejects(run(fake), expected); assert.equal(fake.mutations().length, 0);
  });
  await scenario('local token refuses a new or different tunnel', async ({ directory, run }) => {
    await put(directory, 'tunnel-token', TOKEN);
    const fresh = provider(); await assert.rejects(run(fresh), /local tunnel token already exists/); assert.equal(fresh.mutations().length, 0);
    const existing = provider({ tunnel: tunnel(), config: CONFIG, token: 'different_synthetic_tunnel_token' });
    await assert.rejects(run(existing), /local tunnel token differs/); assert.equal(existing.mutations().length, 0);
    assert.equal(privateRead(join(directory, 'tunnel-token')), TOKEN);
  });
  await scenario('DNS conflict introduced during apply is preserved', async ({ run }) => {
    let inventories = 0;
    const fake = provider({ tunnel: tunnel(), config: CONFIG, intercept(call, state) {
      if (call.method === 'GET' && call.route.endsWith('dns_records') && ++inventories === 2) state.records.push({ ...appRecord(), content: 'other.example.test' });
    } });
    await assert.rejects(run(fake), /DNS changed during setup/);
    assert.equal(fake.mutations().length, 0);
    assert.equal(fake.state.records.at(-1).content, 'other.example.test');
  });
  await scenario('locks, account selection and invalid saved state fail closed', async ({ directory, run, logs }) => {
    const fake = provider();
    await put(directory, 'cloudflare-setup.lock', 'existing-lock');
    await assert.rejects(run(fake), /Another setup/);
    assert.equal(privateRead(join(directory, 'cloudflare-setup.lock')), 'existing-lock');
    await rm(join(directory, 'cloudflare-setup.lock'));
    await put(directory, 'cloudflare-state.json', '{');
    await assert.rejects(run(fake), /Invalid private Cloudflare state/);
    await put(directory, 'cloudflare-state.json', { accountId: ACCOUNT });
    await assert.rejects(run(fake, 'apply', { accountId: 'c'.repeat(32) }), /Selected account conflicts/);
    await rm(join(directory, 'cloudflare-state.json'));
    const multiple = provider({ intercept(c) { if (c.route === '/accounts') return { result: [{ id: ACCOUNT }, { id: 'c'.repeat(32) }] }; } });
    await assert.rejects(run(multiple), /Select exactly one/); assert.ok(logs.some(l => l.includes('availableAccountIds')));
    await run(fake, 'plan', { accountId: ACCOUNT });
    await assert.rejects(run(fake, 'destroy'), /Usage:/);
    await assert.rejects(run(fake, 'plan', { accountId: '../secret' }), /resource ID/);
    assert.equal(fake.mutations().length, 0);
  });
  await scenario('pagination across account pages is complete and bounded', async ({ run }) => {
    const paged = provider({ intercept(c) { if (c.route === '/accounts') return { result: c.page === 1 ? [] : [{ id: ACCOUNT }], result_info: { total_pages: 2 } }; } });
    await run(paged, 'plan'); assert.equal(paged.calls.filter(c => c.route === '/accounts').length, 2);
    for (const info of [-1, 1.5, '2']) {
      const invalid = provider({ intercept(c) { if (c.route === '/accounts') return { result: [], result_info: { total_pages: info } }; } });
      await assert.rejects(run(invalid, 'plan'), /pagination/);
    }
    const malformed = provider({ intercept(c) { if (c.route === '/accounts') return { result: {} }; } });
    await assert.rejects(run(malformed, 'plan'), /malformed resource list/);
    const forever = provider({ intercept(c) { if (c.route === '/accounts') return { result: Array.from({ length: 50 }, () => ({ id: ACCOUNT })) }; } });
    await assert.rejects(run(forever, 'plan'), /exceeded its bound/); assert.equal(forever.calls.length, 100);
  });
  await scenario('duplicate remote resources and bad provider identities are rejected', async ({ run }) => {
    for (const [route, result, message] of [
      ['/zones', [zone(), zone()], /Multiple matching zones/],
      [`/accounts/${ACCOUNT}/cfd_tunnel`, [tunnel(), tunnel()], /Multiple matching tunnels/],
      ['/accounts', [{ id: 'bad' }], /resource ID/],
      ['/zones', [{ ...zone(), id: 'bad' }], /resource ID/],
      [`/accounts/${ACCOUNT}/cfd_tunnel`, [{ ...tunnel(), id: 'bad' }], /resource ID/],
    ]) {
      const fake = provider({ intercept(c) { if (c.route === route) return { result }; } });
      await assert.rejects(run(fake, 'plan'), message); assert.equal(fake.mutations().length, 0);
    }
  });
  await scenario('invalid creation/config/token responses stop before DNS', async ({ run }) => {
    const wrongZone = provider({ zone: null, intercept(c) { if (c.method === 'POST' && c.route === '/zones') return { result: { ...zone(), name: 'wrong.test' } }; } });
    await assert.rejects(run(wrongZone), /Created zone identity/);
    const wrongTunnel = provider({ intercept(c) { if (c.method === 'POST' && c.route.endsWith('cfd_tunnel')) return { result: { id: 'invalid' } }; } });
    await assert.rejects(run(wrongTunnel), /resource ID/);
  });
  await scenario('configuration verification refuses failed provider update', async ({ run }) => {
    const fake = provider({ intercept(c) { if (c.method === 'PUT') return { result: {} }; } });
    await assert.rejects(run(fake), /configuration verification failed/);
    assert.ok(!fake.calls.some(c => c.method === 'POST' && c.route.endsWith('dns_records')));
  });
  await scenario('malformed tunnel token never reaches disk', async ({ directory, run }) => {
    const fake = provider({ tunnel: tunnel(), config: CONFIG, token: 'not a token' });
    await assert.rejects(run(fake), /Malformed tunnel token/);
    assert.equal(privateRead(join(directory, 'tunnel-token'), true), null);
  });
  await scenario('malformed saved JSON values are refused without API access', async ({ directory, run }) => {
    for (const value of ['null', '[]', '"text"', '42', 'true']) {
      await put(directory, 'cloudflare-state.json', value);
      const fake = provider();
      await assert.rejects(run(fake), /Invalid private Cloudflare state/);
      assert.equal(fake.calls.length, 0);
    }
  });
  await scenario('owned empty tunnel resume never discards nonempty origin or WARP settings', async ({ directory, run }) => {
    await put(directory, 'cloudflare-state.json', { accountId: ACCOUNT, zoneId: ZONE, tunnelId: TUNNEL });
    for (const config of [
      { ingress: [], 'warp-routing': { enabled: true } },
      { ingress: [], originRequest: { noTLSVerify: true } },
      { ingress: [], unexpected: 'setting' },
    ]) {
      const fake = provider({ tunnel: tunnel(), config });
      await assert.rejects(run(fake), /configuration differs/);
      assert.equal(fake.mutations().length, 0);
    }
    const empty = provider({ tunnel: tunnel(), config: { ingress: [] } });
    await run(empty);
    assert.deepEqual(empty.state.config, CONFIG);
  });
  await scenario('unknown ownership after lost create response fails safely', async ({ run }) => {
    const fake = provider({ tunnel: tunnel(), config: null });
    await assert.rejects(run(fake), /ownership is unrecorded/);
    assert.equal(fake.mutations().length, 0);
  });
  await scenario('DNS mutation is verified by a fresh inventory', async ({ run }) => {
    const fake = provider({ tunnel: tunnel(), config: CONFIG, intercept(c) {
      if (c.method === 'POST' && c.route.endsWith('dns_records')) return { result: appRecord() };
    } });
    await assert.rejects(run(fake), /DNS verification failed/);
    assert.equal(fake.calls.filter(c => c.method === 'POST' && c.route.endsWith('dns_records')).length, 1);
    assert.equal(fake.calls.at(-1).method, 'GET');
  });
  await scenario('concurrent tunnel edits are refused immediately before PUT', async ({ directory, run }) => {
    await put(directory, 'cloudflare-state.json', { accountId: ACCOUNT, zoneId: ZONE, tunnelId: TUNNEL });
    let reads = 0;
    const fake = provider({ tunnel: tunnel(), config: { ingress: [] }, intercept(c, state) {
      if (c.method === 'GET' && c.route.endsWith('configurations') && ++reads === 2)
        state.config = { ingress: [{ hostname: 'changed.example.test', service: 'http://private:80' }] };
    } });
    await assert.rejects(run(fake), /Tunnel configuration changed during setup/);
    assert.equal(fake.mutations().length, 0);
    assert.equal(fake.state.config.ingress[0].hostname, 'changed.example.test');
  });
  await scenario('concurrent desired tunnel configuration is accepted without rewriting it', async ({ directory, run }) => {
    await put(directory, 'cloudflare-state.json', { accountId: ACCOUNT, zoneId: ZONE, tunnelId: TUNNEL });
    let reads = 0;
    const fake = provider({ tunnel: tunnel(), config: { ingress: [] }, intercept(c, state) {
      if (c.method === 'GET' && c.route.endsWith('configurations') && ++reads === 2) state.config = clone(CONFIG);
    } });
    await run(fake);
    assert.equal(fake.calls.filter(c => c.method === 'PUT').length, 0);
    assert.deepEqual(fake.state.config, CONFIG);
  });
  await scenario('private filesystem validation rejects unsafe files and symlinks', async ({ directory, run }) => {
    const file = join(directory, 'private');
    await writeFile(file, 'private-fixture', { mode: 0o600 }); assert.equal(privateRead(file), 'private-fixture');
    assert.equal(privateRead(join(directory, 'absent'), true), null);
    assert.throws(() => privateRead(join(directory, 'absent')), /Cannot read private/);
    await chmod(file, 0o644); assert.throws(() => privateRead(file), /permissions 600/); await chmod(file, 0o600);
    await symlink(file, join(directory, 'link')); assert.throws(() => privateRead(join(directory, 'link')), /Cannot read private/);
    assert.throws(() => privateRead(directory), /regular files/);
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1)); assert.throws(() => privateRead(file), /unexpectedly large/);
    await chmod(directory, 0o755); await assert.rejects(run(provider(), 'plan'), /private directory/); await chmod(directory, 0o700);
    const target = join(directory, 'real'); await mkdir(target, { mode: 0o700 });
    const link = join(directory, 'directory-link'); await symlink(target, link);
    await assert.rejects(run(provider(), 'plan', { directory: link }), /private directory/);
  });

  for (const token of ['', 'short', 'token with whitespace that is long', 'x'.repeat(513)]) assert.throws(() => apiClient(token), /API token file/);
  const requests = [];
  const api = apiClient(API_TOKEN, async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ success: true, result: { id: ACCOUNT } }), { status: 200 });
  });
  assert.deepEqual((await api('/accounts', 'POST', { test: true })).result, { id: ACCOUNT });
  assert.equal(requests[0].url, 'https://api.cloudflare.com/client/v4/accounts');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${API_TOKEN}`);
  assert.equal(requests[0].options.redirect, 'error'); assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(requests[0].options.body, JSON.stringify({ test: true }));
  await api('/accounts'); assert.ok(!Object.hasOwn(requests[1].options, 'body'));
  for (const path of ['https://evil.test', '/../../secret', '/accounts#fragment']) await assert.rejects(api(path), /Invalid Cloudflare API path/);
  const secret = 'PROVIDER_RESPONSE_SECRET_NEVER_DISPLAY';
  const failures = [
    async () => { throw new Error(secret); },
    async () => new Response(secret, { status: 200 }),
    async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1), { status: 200 }),
    async () => new Response(JSON.stringify({ success: false, errors: [secret] }), { status: 403 }),
    async () => new Response(JSON.stringify({ success: false, errors: [secret] }), { status: 200 }),
    async () => new Response(JSON.stringify({ success: true, errors: [secret] }), { status: 500 }),
    async () => ({ ok: true, status: 200, body: null }),
  ];
  for (const fetcher of failures) {
    let calls = 0;
    const client = apiClient(API_TOKEN, (...args) => { calls++; return fetcher(...args); });
    await assert.rejects(client('/accounts'), error => {
      assert.ok(!error.message.includes(secret)); assert.ok(!error.message.includes(API_TOKEN));
      assert.match(error.message, /Cloudflare request failed|Cloudflare rejected/); return true;
    });
    assert.equal(calls, 1, 'Ambiguous API failure must never retry automatically');
  }
  // Invalid CLI arguments are rejected before reading the user's private token.
  for (const args of [['invalid'], ['plan', ACCOUNT, 'unexpected']]) {
    const cli = spawnSync(process.execPath, ['scripts/cloudflare.mjs', ...args], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Usage:/);
    assert.ok(!cli.stderr.includes(API_TOKEN));
  }
  console.log(`Cloudflare automation: ${count} isolated setup scenarios plus API transport/redaction guards passed; no live API requests.`);
} finally { await rm(root, { recursive: true, force: true }); }
