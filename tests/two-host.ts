/** Two real HTTPS hosts, with a freshly generated CA and a leaf public-key pin.
 * Chromium trusts only that test leaf using --ignore-certificate-errors-spki-list.
 * We never set ignoreHTTPSErrors or globally disable certificate verification.
 * OpenSSL independently verifies both SAN names against the generated CA.
 */
import { chromium, expect, type Browser } from "@playwright/test";
import { createServer as httpsServer, type Server as HttpsServer } from "node:https";
import { createServer, request, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { harness, listen, close, PASS } from "./harness.js";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
const directory = await mkdtemp(join(tmpdir(), "mytikas-two-host-"));
const h = await harness();
let browser: Browser | undefined;
const servers: Array<Server | HttpsServer> = [];
try {
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: ["pipe", "pipe", "pipe"] });
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Mytikas isolated test CA", "-addext", "basicConstraints=critical,CA:TRUE");
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=app.mytikas.test");
  await writeFile(join(directory, "leaf.ext"), "subjectAltName=DNS:app.mytikas.test,DNS:landing.mytikas.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "leaf.ext");
  for (const hostname of ["app.mytikas.test", "landing.mytikas.test"]) openssl("verify", "-CAfile", "ca.pem", "-verify_hostname", hostname, "leaf.pem");
  const publicKey = openssl("x509", "-in", "leaf.pem", "-pubkey", "-noout");
  const der = execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], { input: publicKey });
  const pin = createHash("sha256").update(der).digest("base64");
  const tls = { key: await readFile(join(directory, "leaf.key")), cert: await readFile(join(directory, "leaf.pem")) };
  const cfg: Config = { ...h.cfg, deploymentProfile: "public", ingressMode: "cloudflare-loopback", secureCookies: true, discordWebhook: undefined };
  const backend = createServer(createApp(h.pool, cfg, h.verify));
  servers.push(backend);
  const backendPort = await listen(backend);
  const ingress = httpsServer(tls, (req, res) => {
    const upstream = request({ hostname: "127.0.0.1", port: backendPort, path: req.url, method: req.method, headers: { ...req.headers, "x-forwarded-proto": "https", "cf-connecting-ip": "203.0.113.14" } }, response => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    });
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  servers.push(ingress);
  const appPort = await listen(ingress);
  cfg.origin = `https://app.mytikas.test:${appPort}`;
  const landingCookies: string[] = [];
  const landing = httpsServer(tls, async (req, res) => {
    if (req.headers.cookie) landingCookies.push(req.headers.cookie);
    const path = req.url === "/" ? "index.html" : req.url?.slice(1) || "";
    if (!/^[a-z0-9./-]+$/i.test(path) || path.includes("..")) { res.writeHead(404).end(); return; }
    try {
      const mime: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
      res.setHeader("Content-Type", mime[extname(path)] || "application/octet-stream");
      res.end(await readFile(join(directory, "landing-dist", path)));
    } catch { res.writeHead(404).end(); }
  });
  servers.push(landing);
  const landingPort = await listen(landing);
  cfg.publicSiteOrigin = `https://landing.mytikas.test:${landingPort}`;
  await symlink(resolve("public"), join(directory, "public"), "dir");
  execFileSync(process.execPath, [resolve("scripts/build-landing.mjs")], { cwd: directory, env: { ...process.env, APP_ORIGIN: cfg.origin } });
  browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${pin}`, "--host-resolver-rules=MAP app.mytikas.test 127.0.0.1,MAP landing.mytikas.test 127.0.0.1", "--no-proxy-server"] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let availabilityRequests = 0;
  page.on("request", req => {
    if (req.url().endsWith("/api/availability")) {
      availabilityRequests++;
      assert.equal(req.headers().cookie, undefined);
    }
  });
  const availabilityResponse = page.waitForResponse(response => response.url().endsWith("/api/availability"));
  await page.goto(cfg.publicSiteOrigin);
  await expect(page.locator("#availability")).toContainText("Applications are available");
  const availabilityHeaders = (await availabilityResponse).headers();
  assert.equal(availabilityHeaders["access-control-allow-origin"], cfg.publicSiteOrigin);
  assert.equal(availabilityHeaders["access-control-allow-credentials"], undefined);
  assert.equal(availabilityHeaders["cache-control"], "no-store");
  assert.equal((await h.pool.query("SELECT count(*) FROM sessions")).rows[0].count, "0");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.getByRole("link", { name: "Apply / sign in" }).click();
  await expect(page).toHaveURL(`${cfg.origin}/account.html`);
  await page.getByLabel("Email", { exact: true }).nth(1).fill("https-applicant@example.test");
  await page.locator("#signup-password").fill(PASS);
  await page.getByLabel("Full in-game name").fill("Secure Summit");
  await page.getByLabel("Why do you want to join?").fill("Joining through two real HTTPS hosts.");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account & apply" }).click();
  await expect(page.locator(".tag")).toHaveText("SUBMITTED");
  const cookie = (await context.cookies()).find(cookie => cookie.name === "mytikas.sid");
  assert.ok(cookie);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "Lax");
  assert.equal(cookie.domain, "app.mytikas.test");
  await expect(page.getByRole("link", { name: "The summit", exact: true })).toHaveAttribute("href", cfg.publicSiteOrigin);
  await page.getByRole("link", { name: "The summit", exact: true }).click();
  await expect(page.locator("#availability")).toContainText("Applications are available");
  assert.deepEqual(landingCookies, []);
  assert.ok(availabilityRequests >= 2);
  await page.getByRole("link", { name: "Apply / sign in" }).click();
  await expect(page.locator(".tag")).toHaveText("SUBMITTED");
  const application = (await h.pool.query("SELECT id FROM applications WHERE character_name='Secure Summit'")).rows[0];
  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  staff.on("pageerror", error => errors.push(error.message));
  await staff.goto(`${cfg.origin}/admin.html#${application.id}`);
  await staff.getByRole("link", { name: "Go to your account" }).click();
  await staff.locator("#login-email").fill("admin@example.test");
  await staff.locator("#login-password").fill(PASS);
  await staff.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(staff).toHaveURL(`${cfg.origin}/admin.html#${application.id}`);
  await expect(staff.locator("#detail .tag")).toHaveText("SUBMITTED");
  await staff.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(staff.locator("#detail .tag")).toHaveText("APPROVED");
  await page.reload();
  await expect(page.locator(".tag")).toHaveText("APPROVED");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#signup")).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const input of await page.locator("input, textarea").all()) {
    assert.ok(await input.evaluate(element => (element as HTMLInputElement).labels?.length));
  }
  // A certificate with a different public key remains untrusted in this browser.
  const untrusted = httpsServer({ key: await readFile(join(directory, "ca.key")), cert: await readFile(join(directory, "ca.pem")) }, (_req, res) => res.end("unexpected"));
  servers.push(untrusted);
  const untrustedPort = await listen(untrusted);
  const probe = await context.newPage();
  await assert.rejects(probe.goto(`https://app.mytikas.test:${untrustedPort}`), /ERR_CERT_/);
  await probe.close();
  assert.deepEqual(errors, []);
  console.log("✓ Two HTTPS hosts: pinned test certificate, anonymous CORS availability, secure host-only cookies, registration, persisted session, staff login return/decision, keyboard and mobile layout");
} finally {
  await browser?.close();
  for (const server of servers.reverse()) await close(server);
  await h.stop();
  await rm(directory, { recursive: true, force: true });
}
