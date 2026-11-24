import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGithubApp } from '../scripts/addon-sync-setup.mjs';

const root = fs.mkdtempSync(join(tmpdir(), 'mytikas-app-setup-'));
const file = join(root, 'integrations', 'addon-sync.json');
const keyFile = join(root, 'fixture-app.2026-10-11.private-key.pem');
const image = 'ghcr.io/mytikas-monster/mytikas-synchronizer@sha256:' + 'a'.repeat(64);
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength:2048});
const writeKey = (path, key) => fs.writeFileSync(path, key.export({format:'pem',type:'pkcs8'}), {mode:0o600});
const calls = [];
let upstreamOverride;
async function fetchImpl(url, options) {
  const {origin, pathname} = new URL(url);
  assert.equal(origin, 'https://api.github.com');
  assert.equal(options.redirect, 'error');
  calls.push(pathname);
  if (pathname === '/apps/fixture-app') {
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({id:977});
  }
  const owner = pathname.split('/')[2];
  assert.equal(pathname, '/repos/' + owner + '/OlympusMytikas/installation');
  assert.match(options.headers.Authorization, /^Bearer /);
  const [header, body, signature] = options.headers.Authorization.slice(7).split('.');
  assert.equal(JSON.parse(Buffer.from(header,'base64url')).alg, 'RS256');
  assert(verify('RSA-SHA256', Buffer.from(header + '.' + body), publicKey, Buffer.from(signature,'base64url')));
  const {iss,iat,exp} = JSON.parse(Buffer.from(body,'base64url'));
  assert.equal(iss, '977');
  const now = Math.floor(Date.now()/1000);
  assert(iat <= now && exp > now && exp <= now+600);
  const base = {id: owner==='Laymer'?10:22, app_id:977, account:{login:owner}, suspended_at:null,
    permissions:{contents:'write', pull_requests:'write', actions:'read'}};
  if (owner === 'Mytikas-Monster' && upstreamOverride instanceof Response) return upstreamOverride;
  return Response.json(owner === 'Mytikas-Monster' ? {...base, ...upstreamOverride} : base);
}
const setup = overrides => configureGithubApp({settingsFile:file, image, keyFile:'', appId:'', fetchImpl, ...overrides});
try {
  await assert.rejects(setup({image:'latest'}), /pinned/);
  await assert.rejects(setup({}), /organizations\/Mytikas-Monster\/settings\/apps\/new\?.*pull_requests=write/);
  writeKey(keyFile, privateKey);
  fs.chmodSync(keyFile,0o644);
  await assert.rejects(setup({keyFile}), /0600/);
  fs.chmodSync(keyFile,0o600);
  const arbitraryKey = join(root, 'private.pem');
  writeKey(arbitraryKey, privateKey);
  await assert.rejects(setup({keyFile:arbitraryKey}), /Set GITHUB_APP_ID/);
  await assert.rejects(setup({keyFile,appId:'foo'}), /numeric App ID/);
  const ecKey = join(root,'ec.pem');
  writeKey(ecKey, generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey);
  await assert.rejects(setup({keyFile:ecKey}), /RSA private key/);
  const saved = await setup({keyFile});
  assert.deepEqual(calls, ['/apps/fixture-app','/repos/Laymer/OlympusMytikas/installation','/repos/Mytikas-Monster/OlympusMytikas/installation']);
  assert.deepEqual(saved, { image, GITHUB_APP_ID:'977', GITHUB_FORK_INSTALLATION_ID:'10',
    GITHUB_UPSTREAM_INSTALLATION_ID:'22', GITHUB_APP_PRIVATE_KEY_FILE:keyFile });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(join(root,'integrations')).mode & 0o777, 0o700);
  const inode = fs.statSync(file).ino;
  const offline = async () => { throw new Error('No request expected for an unchanged App'); };
  assert.deepEqual(await setup({fetchImpl:offline}), saved);
  assert.equal(fs.statSync(file).ino, inode);
  const upgraded = await setup({image:image.replace('a'.repeat(64),'b'.repeat(64)), fetchImpl:offline});
  assert.equal(upgraded.GITHUB_UPSTREAM_INSTALLATION_ID, saved.GITHUB_UPSTREAM_INSTALLATION_ID);
  const cfg = fs.readFileSync(file,'utf8');
  assert.deepEqual(JSON.parse(cfg), upgraded);
  for (const [override, diagnostic] of [
    [{suspended_at:'2026-10-11'}, /inactive/], [{account:{login:'another'}}, /unexpected/],
    [{permissions:{contents:'write'}}, /permissions/], [{app_id:1},/unexpected/],
    [{id:10}, /distinct/], [new Response('private-diagnostic',{status:404}), /HTTP 404/],
  ]) {
    upstreamOverride=override;
    await assert.rejects(setup({keyFile:arbitraryKey,appId:'977'}), err => diagnostic.test(err.message) && !err.message.includes('private-diagnostic'));
    assert.equal(fs.readFileSync(file,'utf8'),cfg);
  }
  upstreamOverride=undefined;
  const rotated = await setup({keyFile:arbitraryKey,appId:'977'});
  assert.equal(rotated.GITHUB_APP_PRIVATE_KEY_FILE, arbitraryKey);
  // Registration through GitHub's manifest flow uses a generic PEM name and records its App ID separately.
  fs.unlinkSync(file);
  const registrationFile = join(root,'integrations','github-app.json');
  fs.writeFileSync(registrationFile,JSON.stringify({GITHUB_APP_ID:'977',GITHUB_APP_PRIVATE_KEY_FILE:arbitraryKey}),{mode:0o600});
  calls.length=0;
  assert.deepEqual(await setup({}),rotated);
  assert.equal(calls.length,2);
  fs.chmodSync(join(root,'integrations'), 0o755);
  await assert.rejects(setup({}), /0700/);
  console.log('Owner-only atomic settings, signed GitHub installation discovery, retry and safe credential rotation passed.');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
