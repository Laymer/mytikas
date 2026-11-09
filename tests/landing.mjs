import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { reviewDestination, api } from '../public/common.js';
execFileSync(process.execPath, ['scripts/build-landing.mjs']);
assert.deepEqual((await readdir('landing-dist')).sort(), ['.nojekyll', 'assets', 'content.js', 'index.html', 'landing.js', 'style.css']);
const html = await readFile('landing-dist/index.html', 'utf8');
assert.equal((html.match(/https:\/\/app.mytikas.monster\/account.html/g) || []).length, 2);
assert.match(html, /Content-Security-Policy/);
assert.match(html, /id="availability-retry"/);
assert.doesNotMatch(html, /<form|runtime.js|href="\//);
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  if (match[1].startsWith('https:')) continue;
  await readFile(`landing-dist/${match[1]}`);
}
for (const invalid of ['https://evil.test/admin.html', '//evil.test', '/admin.html#<script>', '/admin.html?x=1', '/account.html', '/admin.html%23abc', '/admin.html\\evil']) assert.equal(reviewDestination(invalid), null);
assert.equal(reviewDestination('/admin.html#12345678-1234-1234-1234-123456789abc'), '/admin.html#12345678-1234-1234-1234-123456789abc');
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response('<html>tunnel error</html>', { status: 502 });
  await assert.rejects(api('/api/application', {}), e => e.uncertain && /may have been saved/.test(e.message));
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Login required' }), { status: 401 });
  await assert.rejects(api('/api/application'), /session has expired/);
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(api('/api/application'), /could not be reached/);
  const realTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = callback => realTimeout(callback, 0);
    globalThis.fetch = async (_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    await assert.rejects(api('/api/application', {}), error => error.uncertain);
  } finally { globalThis.setTimeout = realTimeout; }
} finally { globalThis.fetch = originalFetch; }
console.log('✓ Landing allowlist, links, CSP, review destinations and API failure handling');
