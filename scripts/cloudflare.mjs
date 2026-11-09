import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, mkdirSync, lstatSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZONE = 'mytikas.monster';
const HOST = `app.${ZONE}`;
const NAME = 'mytikas-public';
const ID = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CONFIG = { ingress: [{ hostname: HOST, service: 'http://127.0.0.1:8080' }, { service: 'http_status:404' }] };
const fail = message => { throw new Error(message); };

export function privateRead(path, optional = false) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077)) fail('Private setup files must be regular files with permissions 600.');
    if (stat.size > 2 * 1024 * 1024) fail('Private setup file is unexpectedly large.');
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.code) fail('Cannot read private setup file; check its existence, permissions and symlinks.');
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function privateWrite(path, value) {
  // Validate existing targets and use an exclusive sibling to avoid partial writes.
  privateRead(path, true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
export function apiClient(token, fetcher = fetch) {
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token)) fail('API token file must contain only the Cloudflare API token.');
  return async (path, method = 'GET', body) => {
    if (!path.startsWith('/') || path.includes('..') || path.includes('#')) fail('Invalid Cloudflare API path.');
    let response, payload;
    try {
      response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) fail('Oversized API response.');
        chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { fail('Cloudflare request failed or returned invalid data. No automatic retry; inspect with plan before repeating apply.'); }
    if (!response.ok || payload?.success !== true) fail(`Cloudflare rejected the request (HTTP ${response.status}); check API token permissions. Response details withheld.`);
    return payload;
  };
}
async function list(api, path) {
  const results = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=50&page=${page}`);
    if (!Array.isArray(data.result)) fail('Cloudflare returned a malformed resource list.');
    results.push(...data.result);
    const pages = data.result_info?.total_pages;
    if (pages !== undefined && (!Number.isInteger(pages) || pages < 0)) fail('Malformed Cloudflare pagination.');
    if (pages !== undefined ? page >= pages : data.result.length < 50) return results;
  }
  fail('Resource listing exceeded its bound; refusing an incomplete inventory.');
}
const id = (value, regex = ID) => { if (typeof value !== 'string' || !regex.test(value)) fail('Invalid Cloudflare resource ID.'); return value; };
function configured(config) {
  return config && Array.isArray(config.ingress) && config.ingress.length === 2 &&
    config.ingress[0].hostname === HOST && config.ingress[0].service === CONFIG.ingress[0].service &&
    config.ingress[1].service === 'http_status:404' &&
    config.ingress.every(rule => Object.keys(rule).every(key => ['hostname', 'service', 'originRequest'].includes(key)) && (!rule.originRequest || Object.keys(rule.originRequest).length === 0)) &&
    !config.ingress[1].hostname && (!config.originRequest || Object.keys(config.originRequest).length === 0) &&
    (!config['warp-routing'] || config['warp-routing'].enabled === false);
}

function unconfigured(config) {
  return config == null || (typeof config === 'object' && !Array.isArray(config) &&
    Object.keys(config).every(key => ['ingress', 'originRequest', 'warp-routing'].includes(key)) &&
    (!config.ingress || (Array.isArray(config.ingress) && config.ingress.length === 0)) &&
    (!config.originRequest || Object.keys(config.originRequest).length === 0) &&
    (!config['warp-routing'] || (config['warp-routing'].enabled === false && Object.keys(config['warp-routing']).length === 1)));
}
function matchingRecord(records, target) {
  const current = records.filter(r => r.name?.replace(/\.$/, '').toLowerCase() === HOST);
  return current.length === 1 && current[0].type === 'CNAME' && current[0].content === target && current[0].proxied === true;
}

export async function setup({ command, accountId, directory = resolve(ROOT, '.public'), api, log = console.log }) {
  if (!['plan', 'apply'].includes(command)) fail('Usage: node scripts/cloudflare.mjs plan|apply [account-id]');
  if (accountId) id(accountId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077)) fail('.public must be a private directory with permissions 700, not a symlink.');
  const statePath = resolve(directory, 'cloudflare-state.json');
  const tokenPath = resolve(directory, 'tunnel-token');
  const lockPath = resolve(directory, 'cloudflare-setup.lock');
  let lock;
  try {
    if (command === 'apply') {
      try { lock = openSync(lockPath, 'wx', 0o600); }
      catch { fail('Another setup may be active. Inspect .public/cloudflare-setup.lock before retrying.'); }
    }
    const saved = privateRead(statePath, true);
    let state;
    try { state = saved ? JSON.parse(saved) : {}; } catch { fail('Invalid private Cloudflare state; review it before continuing.'); }
    if (!state || typeof state !== 'object' || Array.isArray(state)) fail('Invalid private Cloudflare state; review it before continuing.');
    if (state.accountId) id(state.accountId);
    if (accountId && state.accountId && accountId !== state.accountId) fail('Selected account conflicts with saved setup.');
    accountId ||= state.accountId;
    if (!accountId) {
      const accounts = await list(api, '/accounts');
      if (accounts.length !== 1) {
        log(JSON.stringify({ availableAccountIds: accounts.map(a => id(a.id)) }));
        fail('Select exactly one Cloudflare account by passing its account ID.');
      }
      accountId = id(accounts[0].id);
    }
    const zones = (await list(api, `/zones?name=${ZONE}&account.id=${accountId}`)).filter(z => z.name === ZONE);
    if (zones.length > 1) fail('Multiple matching zones; refusing ambiguous setup.');
    let zone = zones[0];
    if (zone && zone.account?.id !== accountId) fail('Zone belongs to a different account.');
    if (zone) id(zone.id);
    if (state.zoneId && (!zone || state.zoneId !== zone.id)) fail('Saved zone no longer matches the account inventory.');
    const tunnelBase = `/accounts/${accountId}/cfd_tunnel`;
    const tunnels = (await list(api, `${tunnelBase}?is_deleted=false&name=${NAME}`)).filter(t => t.name === NAME && !t.deleted_at);
    if (tunnels.length > 1) fail('Multiple matching tunnels; refusing ambiguous setup.');
    let tunnel = tunnels[0];
    if (tunnel) id(tunnel.id, UUID);
    if (state.tunnelId && (!tunnel || state.tunnelId !== tunnel.id)) fail('Saved tunnel no longer matches the account inventory.');
    if (tunnel && tunnel.config_src !== 'cloudflare') fail('Existing tunnel is not remotely managed.');
    let config = tunnel ? (await api(`${tunnelBase}/${tunnel.id}/configurations`)).result?.config : null;
    if (tunnel && !configured(config) && (state.tunnelId !== tunnel.id || !unconfigured(config)))
      fail('Existing tunnel configuration differs or ownership is unrecorded; refusing to replace routes. Inspect the dedicated tunnel and private state after an interrupted create.');
    let records = zone ? await list(api, `/zones/${zone.id}/dns_records`) : [];
    const atHost = records.filter(r => r.name?.replace(/\.$/, '').toLowerCase() === HOST);
    const desiredTarget = tunnel && `${tunnel.id}.cfargotunnel.com`;
    if (atHost.length && !(atHost.length === 1 && atHost[0].type === 'CNAME' && atHost[0].content === desiredTarget && atHost[0].proxied === true))
      fail('Application DNS record already exists with different settings; refusing to overwrite it.');
    const localToken = privateRead(tokenPath, true)?.trim();
    if (localToken && !tunnel) fail('A local tunnel token already exists; refusing to create a different tunnel.');
    log(JSON.stringify({ accountId, zone: ZONE, zoneStatus: zone?.status || 'not-created', tunnel: NAME,
      actions: [!zone && 'create zone (registrar delegation unchanged)', !tunnel && 'create remote tunnel', !configured(config) && 'configure loopback route and 404 fallback', !atHost.length && 'add app CNAME', 'save tunnel token privately'].filter(Boolean),
      nameservers: zone?.name_servers || [], registrarCutover: 'Requires complete old-zone inventory and DNSSEC review; never performed by this command.' }));
    if (command === 'plan') return;
    // Backup the complete current Cloudflare inventory; never label this a registrar export.
    privateWrite(resolve(directory, `cloudflare-before-${randomUUID()}.json`), JSON.stringify({ accountId, zone: zone || null, records, tunnel: tunnel ? { id: tunnel.id, config } : null }, null, 2));
    const save = () => privateWrite(statePath, JSON.stringify(state, null, 2) + '\n');
    state = { ...state, accountId }; save();
    if (!zone) {
      zone = (await api('/zones', 'POST', { account: { id: accountId }, name: ZONE, type: 'full' })).result;
      id(zone?.id);
      if (zone.name !== ZONE || zone.account?.id !== accountId) fail('Created zone identity did not match request.');
      state.zoneId = zone.id; save();
    } else { state.zoneId = zone.id; save(); }
    if (!tunnel) {
      tunnel = (await api(tunnelBase, 'POST', { name: NAME, config_src: 'cloudflare' })).result;
      id(tunnel?.id, UUID);
      state.tunnelId = tunnel.id; save();
    }
    if (!configured(config)) {
      const latest = (await api(`${tunnelBase}/${tunnel.id}/configurations`)).result?.config;
      if (!configured(latest)) {
        if (!unconfigured(latest)) fail('Tunnel configuration changed during setup; refusing to replace it.');
        await api(`${tunnelBase}/${tunnel.id}/configurations`, 'PUT', { config: CONFIG });
      }
    }
    config = (await api(`${tunnelBase}/${tunnel.id}/configurations`)).result?.config;
    if (!configured(config)) fail('Remote tunnel configuration verification failed.');
    const tunnelToken = (await api(`${tunnelBase}/${tunnel.id}/token`)).result;
    if (typeof tunnelToken !== 'string' || !/^[A-Za-z0-9_+/=-]{20,4096}$/.test(tunnelToken)) fail('Malformed tunnel token response.');
    if (localToken && localToken !== tunnelToken) fail('Existing local tunnel token differs; refusing to overwrite it.');
    privateWrite(tokenPath, `${tunnelToken}\n`);
    // Refetch before DNS mutation, including for a newly created zone.
    records = await list(api, `/zones/${zone.id}/dns_records`);
    const current = records.filter(r => r.name?.replace(/\.$/, '').toLowerCase() === HOST);
    const target = `${tunnel.id}.cfargotunnel.com`;
    if (current.length) {
      if (!(current.length === 1 && current[0].type === 'CNAME' && current[0].content === target && current[0].proxied === true)) fail('Application DNS changed during setup; refusing to overwrite it.');
    } else await api(`/zones/${zone.id}/dns_records`, 'POST', { type: 'CNAME', name: HOST, content: target, ttl: 1, proxied: true });
    const verifiedRecords = await list(api, `/zones/${zone.id}/dns_records`);
    if (!matchingRecord(verifiedRecords, target)) fail('Application DNS verification failed; inspect plan before retrying.');
    state = { accountId, zoneId: zone.id, tunnelId: tunnel.id, nameservers: zone.name_servers || [], zoneStatus: zone.status, hostname: HOST }; save();
    log('Cloudflare resources prepared. Tunnel token saved privately. Registrar nameservers, existing DNS records, Access policies, Pages binding and public services were not changed.');
    log(JSON.stringify({ nameservers: state.nameservers, zoneStatus: state.zoneStatus }));
  } finally {
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, accountId, extra] = process.argv.slice(2);
    if (extra || !['plan', 'apply'].includes(command)) fail('Usage: node scripts/cloudflare.mjs plan|apply [account-id]');
    const token = privateRead(resolve(ROOT, '.public/cloudflare-api-token')).trim();
    await setup({ command, accountId, api: apiClient(token) });
  } catch (error) {
    // Only our bounded, static errors reach the terminal; never render provider bodies or secrets.
    console.error(error.code ? 'Cloudflare setup filesystem operation failed; inspect private file permissions.' : error.message);
    process.exitCode = 1;
  }
}
