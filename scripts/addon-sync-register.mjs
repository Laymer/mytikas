import * as fs from 'node:fs';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const org = 'Mytikas-Monster';
const name = 'Mytikas Addon Synchronizer';
const homepage = 'https://app.mytikas.monster';
const permissions = { actions: 'read', contents: 'write', pull_requests: 'write' };
const targets = [
  { owner: org, account: 358716068, repo: 1466605040 },
  { owner: 'Laymer', account: 15147427, repo: 1469652372 },
];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function links(meta) {
  return targets.map(({ owner, account, repo }) => ({
    owner, url: meta.html_url + '/installations/new/permissions?' +
      new URLSearchParams({suggested_target_id: String(account), 'repository_ids[]': String(repo)}),
  }));
}

export function installationNotice(meta) {
  return links(meta).map(({ owner, url }) => 'Install on ' + owner + '/OlympusMytikas: ' + url).join('\n');
}

function readPrivate(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'Registration files must be owner-only regular files.');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function privateDirectory(path) {
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(path);
  check(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'Use an owner-only integrations directory.');
}

function syncDir(path) {
  const fd = fs.openSync(path, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function validMeta(meta, dir) {
  return /^[1-9]\d*$/.test(meta.GITHUB_APP_ID) &&
    meta.GITHUB_APP_PRIVATE_KEY_FILE === join(dir, 'github-app.pem') &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.slug) && meta.html_url === 'https://github.com/apps/' + meta.slug;
}

function validateApp(app, dir) {
  check(Number.isSafeInteger(app.id) && app.id > 0 && app.owner?.login === org &&
    app.owner?.id === targets[0].account && app.external_url?.replace(/\/$/, '') === homepage,
    'The registration does not belong to the intended organization and application.');
  check(Object.entries(permissions).every(([k,v]) => app.permissions?.[k] === v)
    && Object.entries(app.permissions).every(([k,v]) => permissions[k] === v || (k === 'metadata' && v === 'read'))
    && Array.isArray(app.events) && app.events.length === 0, 'The GitHub App permissions or events differ from the requested registration.');
  const meta = { GITHUB_APP_ID: String(app.id), GITHUB_APP_PRIVATE_KEY_FILE: join(dir,'github-app.pem'),
    slug: app.slug, html_url: app.html_url };
  check(validMeta(meta, dir), 'Unexpected GitHub App identity.');
  check(createPrivateKey({ key: app.pem, format: 'pem', passphrase: '' }).asymmetricKeyType === 'rsa', 'Expected an RSA private key.');
  return meta;
}

function recover(dir) {
  const stage = join(dir,'.github-app-registration');
  const files = ['github-app.json', 'github-app.pem'];
  if (fs.existsSync(stage)) {
    privateDirectory(stage);
    // Hard links publish completed files exclusively. A retry finishes an interrupted pair.
    for (const name of files) {
      const from = join(stage,name), to = join(dir,name);
      if (fs.lstatSync(to,{throwIfNoEntry:false})) {
        check(readPrivate(from).equals(readPrivate(to)), 'Existing GitHub App credentials differ. Resolve the registration before retrying.');
      } else {
        readPrivate(from);
        fs.linkSync(from,to);
      }
    }
    syncDir(dir);
    fs.rmSync(stage,{recursive:true});
  }
  if (!files.some(name => fs.lstatSync(join(dir,name),{throwIfNoEntry:false}))) return null;
  const meta = JSON.parse(readPrivate(join(dir,files[0])));
  check(validMeta(meta,dir), 'Existing registration metadata is incomplete.');
  check(createPrivateKey({key:readPrivate(join(dir,files[1])),format:'pem',passphrase:''}).asymmetricKeyType === 'rsa',
    'Existing GitHub App key is invalid.');
  return meta;
}

function persist(app, dir) {
  const meta = validateApp(app,dir);
  const staging = fs.mkdtempSync(join(dir,'.new-registration-'));
  try {
    const options = {flag:'wx',mode:0o600,flush:true};
    fs.writeFileSync(join(staging,'github-app.pem'), app.pem, options);
    fs.writeFileSync(join(staging,'github-app.json'), JSON.stringify(meta,null,2) + '\n', options);
    syncDir(staging);
    fs.renameSync(staging,join(dir,'.github-app-registration'));
    syncDir(dir);
  } finally { fs.rmSync(staging,{recursive:true,force:true}); }
  return recover(dir);
}

function browser(url) {
  console.log('Open this URL in a browser on the deployment host: ' + url);
  if (process.platform === 'darwin') {
    const child = spawn('/usr/bin/open',[url],{stdio:'ignore',detached:true});
    child.on('error',() => {});
    child.unref();
  }
}

const escape = value => value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');

export async function registerApp({dir=join(homedir(),'.mytikas','integrations'), onReady=browser, fetchImpl=fetch}={}) {
  privateDirectory(dir);
  const saved = recover(dir);
  if (saved) return saved;
  const state = randomBytes(32).toString('hex');
  let origin, busy = false;
  let finish, fail;
  const result = new Promise((resolve,reject) => { finish=resolve; fail=reject; });
  const server = createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if (req.method !== 'GET' || req.headers.host !== new URL(origin).host) {
      res.writeHead(403).end('Invalid local request.'); return;
    }
    let url;
    try {url = new URL(req.url,origin);} catch {res.writeHead(400).end('Invalid request.'); return;}
    if (url.pathname === '/') {
      const manifest = {name, url:homepage, description:'Review website addon submissions and publish their original release ZIP.',
        hook_attributes:{active:false}, redirect_url:origin+'/callback', public:true, default_permissions:permissions, default_events:[]};
      res.end('<!doctype html><title>Register Mytikas Addon Synchronizer</title><h1>Register Mytikas Addon Synchronizer</h1>' +
        '<p>GitHub will ask you to create this app under Mytikas-Monster. The key stays on this host.</p>' +
        '<form method="post" action="https://github.com/organizations/Mytikas-Monster/settings/apps/new?state=' + state + '">' +
        '<input type="hidden" name="manifest" value="' + escape(JSON.stringify(manifest)) + '"><button>Continue to GitHub</button></form>');
      return;
    }
    if (url.pathname !== '/callback') {res.writeHead(404).end('Unknown page.'); return;}
    const code = url.searchParams.get('code');
    if (url.searchParams.get('state') !== state || !/^[A-Za-z0-9_-]{16,256}$/.test(code || '')) {
      res.writeHead(403).end('The GitHub callback does not match this registration.'); return;
    }
    if (busy) {res.writeHead(409).end('Registration exchange in progress.'); return;}
    busy=true;
    try {
      const response = await fetchImpl('https://api.github.com/app-manifests/' + code + '/conversions', {
        method:'POST', headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
        redirect:'error', signal:AbortSignal.timeout(20000),
      });
      check(response.status === 201, 'GitHub could not exchange the registration code (HTTP ' + response.status + ').');
      const meta = persist(await response.json(),dir);
      res.end('<!doctype html><title>Install Mytikas Addon Synchronizer</title><h1>App registered</h1>' +
        '<p>Complete each installation with only the OlympusMytikas repository selected.</p>' +
        links(meta).map(({owner,url}) => '<p><a target="_blank" rel="noopener noreferrer" href="' + escape(url) + '">Install on ' + owner + '/OlympusMytikas</a></p>').join(''));
      finish(meta);
    } catch {
      // Errors from HTTP and cryptography libraries can contain callback URLs or private input.
      res.writeHead(502).end('Registration exchange failed. Retry this callback. If GitHub consumed the code, use the registered app settings to generate a replacement key.');
    } finally {busy=false;}
  });
  const timer = setTimeout(() => fail(new Error('GitHub registration expired. Inspect the organization app settings before starting again.')),60*60*1000);
  try {
    await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    origin='http://127.0.0.1:' + server.address().port;
    await onReady(origin);
    return await result;
  } finally {clearTimeout(timer);server.close();}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  registerApp().then(meta => console.log(installationNotice(meta))).catch(error => {
    console.error(error instanceof SyntaxError ? 'Invalid saved GitHub App metadata.' : error.message);
    process.exitCode=1;
  });
}
