import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createApp, hashPassword } from "../src/app.js";
import { verifyMembership } from "../src/armory.js";
import type { Config } from "../src/config.js";
export async function listen(server: Server, port = 0) {
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  return (server.address() as any).port as number;
}
export async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((ok, no) => server.close((e) => (e ? no(e) : ok())));
}
async function freePort() {
  const server = createServer(),
    port = await listen(server);
  await close(server);
  return port;
}
export const PASS = "Testing-only-password-42";
export function character(fullName: string, patch: Record<string, any> = {}) {
  const [name, surname] = fullName.split(" ");
  return {
    name,
    surname,
    region: "us",
    ruleset: { slug: "pvp", rulesetId: 1 },
    guild: { name: "Olympus Mytikas" },
    ...patch,
  };
}
export const html = (c: any) =>
  `<html><script type="text/javascript" id="character-profile-mount-initial-state">var characterProfileInitialState = ${JSON.stringify({ character: c })};</script></html>`;
export async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "mytikas-tests-")),
    port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: join(directory, "db"),
    port,
    user: "test",
    password: "isolated-test",
    persistent: true,
    authMethod: "scram-sha-256",
    postgresFlags: ["-h", "127.0.0.1"],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("mytikas_test");
  const databaseUrl = `postgres://test:isolated-test@127.0.0.1:${port}/mytikas_test`;
  let pool = createPool(databaseUrl);
  await migrate(pool);
  const profiles = new Map<
    string,
    { character?: any; status?: number; delay?: number; raw?: string }
  >();
  const discord = { status: 204, retryAfter: 0, messages: [] as any[] };
  const fixture = createServer(async (req, res) => {
    if (req.url?.startsWith("/discord")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      discord.messages.push(JSON.parse(raw));
      res.statusCode = discord.status;
      if (discord.status === 429) {
        res.setHeader("Retry-After", String(discord.retryAfter));
        res.end(JSON.stringify({ retry_after: discord.retryAfter }));
      } else res.end();
      return;
    }
    const slug = decodeURIComponent(req.url!.split("/").at(-1)!);
    const p = profiles.get(slug);
    if (p?.delay) await new Promise((ok) => setTimeout(ok, p.delay));
    res.statusCode = p?.status || 200;
    res.setHeader("Content-Type", "text/html");
    if (res.statusCode === 302)
      res.setHeader("Location", "https://example.invalid/");
    res.end(p?.raw ?? html(p?.character || character(slug.replace("-", " "))));
  });
  const fixturePort = await listen(fixture);
  const transport: typeof fetch = (input, init) => {
    const u = new URL(String(input));
    return fetch(`http://127.0.0.1:${fixturePort}${u.pathname}`, init);
  };
  const verify = (name: string) => verifyMembership(name, transport);
  const cfg: Config = {
    databaseUrl,
    sessionSecret: "test-only-secret-".repeat(4),
    origin: "http://127.0.0.1",
    port: 0,
    secureCookies: false,
    discordWebhook: `http://127.0.0.1:${fixturePort}/discord`,
  };
  let server = createServer(createApp(pool, cfg, verify));
  const appPort = await listen(server);
  cfg.origin = `http://127.0.0.1:${appPort}`;
  const hash = await hashPassword(PASS);
  const admin = (
    await pool.query(
      "INSERT INTO users(email,password_hash,role) VALUES ('admin@example.test',$1,'ADMIN') RETURNING id",
      [hash],
    )
  ).rows[0];
  const moderator = (
    await pool.query(
      "INSERT INTO users(email,password_hash,role) VALUES ('mod@example.test',$1,'MODERATOR') RETURNING id",
      [hash],
    )
  ).rows[0];
  return {
    get pool() {
      return pool;
    },
    cfg,
    verify,
    profiles,
    discord,
    admin,
    moderator,
    async restart() {
      await close(server);
      await pool.end();
      await pg.stop();
      await pg.start();
      pool = createPool(databaseUrl);
      await migrate(pool);
      server = createServer(createApp(pool, cfg, verify));
      await listen(server, appPort);
    },
    async stop() {
      await close(server);
      await close(fixture);
      await pool.end();
      await pg.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export class Client {
  cookie = "";
  csrf = "";
  constructor(public origin: string) {}
  async request(
    path: string,
    body?: any,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(this.origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: this.cookie,
        ...(body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "X-CSRF-Token": this.csrf,
              Origin: this.origin,
            }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0]!;
    const data = await response.json();
    if (data.csrfToken) this.csrf = data.csrfToken;
    return { status: response.status, data, headers: response.headers };
  }
  async init() {
    return this.request("/api/auth/me");
  }
  async login(email = "admin@example.test") {
    await this.init();
    const r = await this.request("/api/auth/login", { email, password: PASS });
    if (r.status !== 200) throw new Error(JSON.stringify(r));
    return r;
  }
  async signup(name: string, address?: string, extra = {}) {
    await this.init();
    const { data: rules } = await this.request("/api/rules");
    return this.request("/api/auth/register", {
      email: address || name.toLowerCase().replace(" ", ".") + "@example.test",
      password: PASS,
      characterName: name,
      motivation: "I enjoy playing with a thoughtful guild.",
      rulesId: rules.id,
      acceptRules: true,
      ...extra,
    });
  }
  async application() {
    return (await this.request("/api/application")).data;
  }
}
