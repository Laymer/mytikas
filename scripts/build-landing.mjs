import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const origin = process.env.APP_ORIGIN || 'https://app.mytikas.monster';
const url = new URL(origin);
if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('APP_ORIGIN must be a bare HTTPS origin');
const output = resolve('landing-dist');
await rm(output, { recursive: true, force: true });
await mkdir(`${output}/assets`, { recursive: true });
for (const file of ['style.css', 'content.js', 'landing.js', 'assets/crest.svg', 'assets/summit.png']) {
  await copyFile(`public/${file}`, `${output}/${file}`);
}
const csp = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ${origin}; base-uri 'none'; form-action 'none'`;
let html = await readFile('public/index.html', 'utf8');
html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="application-origin" content="${origin}">`)
  .replaceAll('href="/account.html"', `href="${origin}/account.html"`)
  .replace('content="/assets/summit.png"', 'content="assets/summit.png"')
  .replace('<script src="/runtime.js"></script>', '<script src="landing.js"></script>')
  .replace('</div></section></main>', '<p class="muted" id="availability" role="status">Application availability is unknown. This prototype runs while the guild laptop is online.</p><button class="button" id="availability-retry" type="button">Check availability</button></div></section></main>');
await writeFile(`${output}/index.html`, html);
await writeFile(`${output}/.nojekyll`, '');
console.log('Landing artifact built in landing-dist (explicit public file allowlist).');
