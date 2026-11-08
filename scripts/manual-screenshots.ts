// Capture the running demo. No account or application data is changed.
import { chromium, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
const origin = 'http://localhost:8081';
const password = (await readFile('.env.demo', 'utf8')).match(/^DEMO_PASSWORD=(.+)$/m)?.[1];
if (!password) throw new Error('Run ./mytikas.sh demo up first.');
await mkdir('docs/images', { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  async function capture(name: string, fullPage = true) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `docs/images/${name}.png`, fullPage });
  }
  async function login(address: string) {
    await context.clearCookies();
    await page.goto(`${origin}/account.html`);
    await page.locator('#login-email').fill(`${address}@demo.test`);
    await page.locator('#login-password').fill(password!);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  }
  await page.goto(origin);
  await expect(page.locator('.demo-banner')).toBeVisible();
  await capture('01-home', false);
  await page.goto(`${origin}/account.html`);
  await expect(page.locator('#signup')).toBeVisible();
  await capture('02-sign-in-and-apply');
  await login('submitted');
  await expect(page.locator('.tag')).toHaveText('SUBMITTED');
  await capture('03-submitted');
  await login('admin');
  await page.getByRole('link', { name: 'Admin panel' }).click();
  await page.locator('#queue a').filter({ hasText: 'Demo Submitted' }).click();
  await expect(page.locator('#detail .tag')).toHaveText('SUBMITTED');
  await page.getByLabel('Review note').fill('Good fit for our evening groups.');
  await capture('04-staff-review');
  await login('reopened');
  await expect(page.locator('.tag')).toHaveText('REOPENED');
  await capture('05-revise-application');
  await login('resubmitted');
  await page.getByText('Submission history (2)', { exact: true }).click();
  await expect(page.getByText('DEMO RULES v1', { exact: false })).toBeVisible();
  await capture('06-submission-history');
  await login('armory');
  await expect(page.locator('.tag')).toHaveText('JOINED');
  await capture('07-joined');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Captured 7 manual screenshots from the running demo; no data changed.');
} finally {
  await browser.close();
}
