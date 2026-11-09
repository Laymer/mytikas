/** Preservation check against the reviewed navigation update.
 * Render the fixed reference commit and today's landing artifact in
 * the same Chromium process. Compare header/hero pixels at desktop and mobile
 * sizes. Recruitment availability copy is intentionally outside this preserved
 * region; account failure messages are checked behaviorally below.
 * The reference changes only navigation sizing, casing and responsive spacing;
 * the original hero and artwork remain unchanged.
 */
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
const baseline = "ca601ef754db6ebd5a096417d312346632a322db";
const directory = await mkdtemp(join(tmpdir(), "mytikas-visual-"));
await mkdir(join(directory, "baseline/assets"), { recursive: true });
for (const file of ["index.html", "style.css", "content.js", "assets/crest.svg", "assets/summit.png"]) {
  await writeFile(join(directory, "baseline", file), execFileSync("git", ["show", `${baseline}:public/${file}`], { maxBuffer: 16 * 1024 * 1024 }));
}
await symlink(resolve("public"), join(directory, "public"), "dir");
execFileSync(process.execPath, [resolve("scripts/build-landing.mjs")], { cwd: directory, env: { ...process.env, APP_ORIGIN: "https://app.mytikas.test" } });
const server = createServer(async (req, res) => {
  const path = req.url?.split("?")[0] || "/";
  if (path === "/api/runtime") { res.setHeader("Content-Type", "application/json"); res.end('{"mode":"normal"}'); return; }
  if (path === "/api/auth/me") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ user: null, csrfToken: "a".repeat(64) })); return; }
  if (path === "/api/rules") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: 1, prototype: true, content: "Isolated visual-test rules." })); return; }
  if (path === "/api/auth/login") { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":"Invalid credentials"}'); return; }
  const match = /^\/(baseline|current)\/(.*)$/.exec(path);
  const file = match ? match[2] || "index.html" : path.slice(1);
  if (!file || !/^[a-z0-9./-]+$/i.test(file) || file.includes("..")) { res.writeHead(404).end(); return; }
  const base = match ? join(directory, match[1] === "baseline" ? "baseline" : "landing-dist") : resolve("public");
  try {
    const mime: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
    res.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream");
    res.end(await readFile(join(base, file)));
  } catch { res.writeHead(404).end(); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: "reduce" });
  await context.route("https://app.mytikas.test/api/availability", route => route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": origin }, body: '{"ready":true}' }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mkdir("test-results/visual", { recursive: true });
  for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    const shots: Record<string, Buffer[]> = {};
    for (const version of ["baseline", "current"]) {
      await page.goto(`${origin}/${version}/`, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${version}/${name} overflows`);
      shots[version] = [];
      for (const selector of ["header", ".hero"]) {
        const section = selector === "header" ? "header" : "hero";
        shots[version]!.push(await page.locator(selector).screenshot({ animations: "disabled", path: `test-results/visual/${name}-${version}-${section}.png` }));
      }
    }
    assert.deepEqual(shots.current, shots.baseline, `${name} header/hero differs from reviewed ${baseline} design`);
    console.log(`✓ ${name}: current header/hero pixels equal reviewed ${baseline} at ${width}×${height}`);
  }
  await page.goto(`${origin}/account.html`);
  await expect(page.locator("#login")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.locator("#login-email").focus();
  await page.keyboard.type("keyboard@example.test");
  await page.keyboard.press("Tab");
  await expect(page.locator("#login-password")).toBeFocused();
  await page.keyboard.type("Incorrect-test-password");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("session has expired");
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(page.locator("#login-email")).toHaveValue("keyboard@example.test");
  await expect(page.locator("#login-password")).toHaveValue("Incorrect-test-password");
  for (const input of await page.locator("input, textarea").all()) assert.ok(await input.evaluate(element => (element as HTMLInputElement).labels?.length));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("✓ Keyboard form order, Enter submission, focused alert, preserved entries, labels and mobile overflow");
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
