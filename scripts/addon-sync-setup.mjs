import * as fs from 'node:fs';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

const registration = new URL('https://github.com/organizations/Mytikas-Monster/settings/apps/new');
registration.search = new URLSearchParams({
  name: 'Mytikas Addon Synchronizer', url: 'https://app.mytikas.monster',
  public: 'true', webhook_active: 'false', contents: 'write', pull_requests: 'write', actions: 'read',
}).toString();

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    requireValue(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
      'Use a regular file owned by the rollout account with mode 0600.');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function positiveId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

function appJWT(appId, key) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iss: appId, iat: now - 60, exp: now + 540 });
  return payload + '.' + sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url');
}

async function github(fetchImpl, path, guidance, jwt) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (jwt) headers.Authorization = 'Bearer ' + jwt;
  const response = await fetchImpl('https://api.github.com' + path, {
    headers, signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(guidance + ' GitHub returned HTTP ' + response.status + '.');
  }
  return response.json();
}

async function installation(fetchImpl, owner, appId, jwt) {
  const repo = owner + '/OlympusMytikas';
  const data = await github(fetchImpl, '/repos/' + repo + '/installation',
    'Install the GitHub App on ' + repo + ' and check the local App ID and key.', jwt);
  requireValue(data.account?.login === owner && String(data.app_id) === appId &&
    data.suspended_at === null && Number.isSafeInteger(data.id) && data.id > 0,
    'GitHub returned an inactive or unexpected installation for ' + repo + '.');
  const permissions = data.permissions;
  requireValue(permissions?.contents === 'write' && (owner === 'Laymer' ||
    (permissions.pull_requests === 'write' && ['read','write'].includes(permissions.actions))),
    'Approve the required GitHub App repository permissions for ' + repo + '.');
  return String(data.id);
}

// Called inside the deployment operation lock. The key stays at its original host-local path.
export async function configureGithubApp({ image, settingsFile, keyFile = process.env.GITHUB_APP_PRIVATE_KEY_FILE,
  appId = process.env.GITHUB_APP_ID, fetchImpl = fetch }) {
  requireValue(/^ghcr\.io\/mytikas-monster\/mytikas-synchronizer@sha256:[a-f0-9]{64}$/.test(image),
    'Use the published synchronizer image pinned to its full SHA-256 digest.');
  const dir = dirname(settingsFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  requireValue(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
    'Store the integration settings under an owner-only directory (0700).');
  const exists = fs.lstatSync(settingsFile, {throwIfNoEntry:false});
  const previous = exists ? JSON.parse(readPrivate(settingsFile)) : {};
  keyFile ||= previous.GITHUB_APP_PRIVATE_KEY_FILE;
  if (!keyFile) {
    const registrationFile = join(dir, 'github-app.json');
    if (fs.lstatSync(registrationFile, {throwIfNoEntry:false})) {
      const registered = JSON.parse(readPrivate(registrationFile));
      keyFile = registered.GITHUB_APP_PRIVATE_KEY_FILE;
      appId ||= registered.GITHUB_APP_ID;
    }
  }
  if (!keyFile) throw new Error('Run node scripts/addon-sync-register.mjs on this host, or set GITHUB_APP_PRIVATE_KEY_FILE to the local App PEM path. ' +
    'For manual registration, open ' + registration + ' and install the App on OlympusMytikas under Laymer and Mytikas-Monster.');
  requireValue(typeof keyFile === 'string' && !/[\x00-\x1f$]/.test(keyFile), 'Supply a local key file path.');
  keyFile = resolve(keyFile);
  const pem = readPrivate(keyFile);
  const key = createPrivateKey({ key: pem, format: 'pem', passphrase: '' });
  requireValue(key.asymmetricKeyType === 'rsa', 'Use an RSA private key generated for the GitHub App.');
  if (!appId && keyFile === previous.GITHUB_APP_PRIVATE_KEY_FILE) appId = previous.GITHUB_APP_ID;
  if (!appId) {
    const match = /^([a-z0-9-]+)\.\d{4}-\d{2}-\d{2}\.private-key\.pem$/i.exec(basename(keyFile));
    requireValue(match, 'Set GITHUB_APP_ID to the numeric App ID shown in GitHub App settings.');
    const app = await github(fetchImpl, '/apps/' + match[1],
      'Could not discover the App ID from the filename. Set GITHUB_APP_ID explicitly.');
    appId = String(app.id);
  }
  requireValue(positiveId(appId), 'Set GITHUB_APP_ID to the numeric App ID shown in GitHub App settings.');
  let fork = previous.GITHUB_FORK_INSTALLATION_ID;
  let upstream = previous.GITHUB_UPSTREAM_INSTALLATION_ID;
  if (previous.GITHUB_APP_ID !== appId || previous.GITHUB_APP_PRIVATE_KEY_FILE !== keyFile ||
      !positiveId(fork) || !positiveId(upstream) || fork === upstream) {
    const jwt = appJWT(appId, key);
    fork = await installation(fetchImpl, 'Laymer', appId, jwt);
    upstream = await installation(fetchImpl, 'Mytikas-Monster', appId, jwt);
    requireValue(fork !== upstream, 'Expected distinct fork and organization installations.');
  } else if (previous.image === image) {
    return previous;
  }
  const settings = { image, GITHUB_APP_ID: appId, GITHUB_FORK_INSTALLATION_ID: fork,
    GITHUB_UPSTREAM_INSTALLATION_ID: upstream, GITHUB_APP_PRIVATE_KEY_FILE: keyFile };
  const temporary = settingsFile + '.' + randomUUID();
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temporary, settingsFile);
  } finally { fs.rmSync(temporary, {force:true}); }
  return settings;
}
