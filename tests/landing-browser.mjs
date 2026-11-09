import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, ['scripts/build-landing.mjs']);
const server = createServer(async (req, res) => {
  const path = req.url.replace(/^\/mytikas\//, '/');
  const file = path === '/' ? 'index.html' : path.slice(1);
  if (!/^[a-z0-9./-]+$/i.test(file) || file.includes('..')) { res.writeHead(404).end(); return; }
  try {
    const mime = { html: 'text/html', js: 'application/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml' };
    res.setHeader('Content-Type', mime[file.split('.').pop()] || 'application/octet-stream');
    res.end(await readFile(`landing-dist/${file}`));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  if (process.env.FRONTEND_COVERAGE === '1') await page.coverage.startJSCoverage({ resetOnNavigation: false });
  page.on('pageerror', error => errors.push(error.message));
  let state = 'ready';
  const measurements = [];
  await page.route('https://app.mytikas.monster/api/availability', async route => {
    assert.equal(route.request().headers().cookie, undefined);
    if (state === 'offline') return route.abort();
    await route.fulfill({ status: state === 'ready' ? 200 : 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin }, body: JSON.stringify(state === 'malformed' ? { ready: 'yes' } : { ready: state === 'ready' }) });
  });
  for (const path of ['/', '/mytikas/']) {
    await page.goto(origin + path);
    await expect(page.locator('#availability')).toContainText('Applications are available');
    await expect(page.getByRole('link', { name: 'Apply / sign in' })).toHaveAttribute('href', 'https://app.mytikas.monster/account.html');
    assert.equal(await page.locator('.hero').evaluate(el => getComputedStyle(el).backgroundImage.includes('summit.png')), true);
    state = 'unavailable';
    await page.locator('#availability-retry').click();
    await expect(page.locator('#availability')).toContainText('temporarily unavailable');
    state = 'malformed';
    await page.locator('#availability-retry').click();
    await expect(page.locator('#availability')).toContainText('availability is unknown');
    state = 'offline';
    await page.locator('#availability-retry').click();
    await expect(page.locator('#availability')).toContainText('availability is unknown');
    await page.getByText('Read the complete chronicle').click();
    await expect(page.locator('#lore')).toBeVisible();
    state = 'ready';
    if (process.env.FRONTEND_COVERAGE === '1') {
      measurements.push(...await page.coverage.stopJSCoverage());
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
    }
  }
  // Exercise the chronicle fallback with the canonical script and an empty
  // article, as needed by a landing template without pre-rendered prose.
  const html = (await readFile('landing-dist/index.html', 'utf8')).replace(/<article id="lore">[\s\S]*?<\/article>/, '<article id="lore"></article>');
  await page.route(origin + '/', route => route.fulfill({ contentType: 'text/html', body: html }), { times: 1 });
  await page.goto(origin + '/');
  await page.getByText('Read the complete chronicle').click();
  await expect(page.locator('#lore')).toContainText('The Ascent of Mytikas');
  await expect(page.locator('#lore p')).toHaveCount(10);
  assert.deepEqual(errors, []);
  if (process.env.FRONTEND_COVERAGE === '1') {
    const coverage = [...measurements, ...await page.coverage.stopJSCoverage()];
    await mkdir('coverage/raw/frontend', { recursive: true });
    await writeFile('coverage/raw/frontend/landing.json', JSON.stringify(coverage));
  }
  console.log('✓ Landing root/project paths, readiness/outage/retry, static chronicle and credential-free requests');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
