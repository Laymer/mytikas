import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  existsSync,
  readdirSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { blacklistHost } from "../scripts/blacklist-host.mjs";

const guild = "1234",
  channel = "5678",
  fixtureToken = "fixture$token";
const counts = {
  messages: 9,
  reports: 4,
  characters: 3,
  matchedApplications: 2,
  lastId: "100",
};
const pinned = {
  DISCORD_BOT_TOKEN: fixtureToken,
  DISCORD_GUILD_ID: guild,
  DISCORD_BLACKLIST_CHANNEL_ID: channel,
};
const settingsFile = (path, value) =>
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

async function fixture(test) {
  const home = mkdtempSync(join(tmpdir(), "mytikas-blacklist-"));
  try {
    const root = join(home, "deployment"),
      db = {
        image: "fixture-postgres",
        volumes: ["retained:/var/lib/postgresql/data"],
      };
    const compose = join(root, "compose.json"),
      secret = join(home, "integrations", "member-home.json");
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(join(home, "integrations"), { mode: 0o700 });
    const env = {
      MEMBERSHIP_DECISIONS_PAUSED: "1",
      DATABASE_URL: "fixture-db-url",
      SMTP_PASSWORD: "literal$$mail",
    };
    const original = JSON.stringify({
      services: {
        app: {
          environment: { ...env, DISCORD_CLIENT_SECRET: "fixture-oauth" },
        },
        worker: {
          environment: { ...env, ADDON_RELEASE_TOKEN: "fixture-addon" },
        },
        db,
        tunnel: { network_mode: "service:app" },
      },
      volumes: { retained: { external: true } },
    });
    writeFileSync(compose, original, { mode: 0o600 });
    settingsFile(secret, {
      ...pinned,
      DISCORD_CLIENT_SECRET: "unused",
      ADDON_RELEASE_TOKEN: "unused",
    });
    const state = {
      phase: "active",
      context: "fixture-context",
      active: { root, compose, project: "fixture-project" },
    };
    const commands = [];
    const mock = {
      state,
      home,
      env: { PATH: "/fixture" },
      endpoint: "unix:///fixture/docker.sock",
      channels: [{ id: channel, type: 0, guild_id: guild, name: "blacklist" }],
      output: { ...counts, privateContent: "must never be printed" },
      publicChecks: 0,
      discoveries: 0,
      failHealth: 0,
      runtimeOverride: {},
      run(exe, args) {
        assert.equal(exe, "docker");
        assert.deepEqual(args, ["context", "inspect", "fixture-context"]);
        return JSON.stringify([
          { Endpoints: { docker: { Host: this.endpoint } } },
        ]);
      },
      dc(d, args, options) {
        assert.equal(d, state.active);
        commands.push(args);
        assert.ok(!args.includes(fixtureToken));
        assert.ok(!args.includes(guild));
        assert.ok(!args.includes(channel));
        assert.ok(!args.includes("db"));
        assert.ok(!args.includes("down"));
        if (args.includes("dist/blacklist-preview.js")) {
          assert.deepEqual(args, [
            "exec",
            "-T",
            "-e",
            "DISCORD_GUILD_ID",
            "-e",
            "DISCORD_BOT_TOKEN",
            "-e",
            "DISCORD_BLACKLIST_CHANNEL_ID",
            "worker",
            "node",
            "dist/blacklist-preview.js",
          ]);
          assert.deepEqual(options.env, { PATH: "/fixture", ...pinned });
          return JSON.stringify(this.output);
        }
        if (args.includes("dist/worker-health.js") && this.failHealth > 0) {
          this.failHealth--;
          throw Error("fixture worker not healthy");
        }
        return "";
      },
      id(d, name) {
        assert.equal(d, state.active);
        return name;
      },
      inspect(id) {
        const environment = {
          ...JSON.parse(readFileSync(compose)).services[id].environment,
          ...this.runtimeOverride[id],
        };
        return {
          Config: {
            Env: Object.entries(environment).map(
              ([k, v]) => k + "=" + v.replaceAll("$$", "$"),
            ),
          },
        };
      },
      publicCheck() {
        this.publicChecks++;
      },
      async fetcher(url, options) {
        this.discoveries++;
        assert.equal(url, "https://discord.com/api/v10/guilds/1234/channels");
        assert.equal(options.redirect, "error");
        assert.equal(options.headers.Authorization, "Bot " + fixtureToken);
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.method ?? "GET", "GET");
        return Response.json(this.channels);
      },
    };
    const call = (mode) =>
      blacklistHost(mode, home, () => mock, mock.fetcher.bind(mock));
    await test({
      home,
      root,
      compose,
      secret,
      original,
      commands,
      mock,
      call,
      db,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

await fixture(async ({ call, compose, original, root, commands, mock }) => {
  assert.deepEqual(await call("preview"), {
    status: "preview",
    channelId: channel,
    ...counts,
  });
  assert.equal(mock.discoveries, 0);
  assert.equal(commands.length, 1);
  assert.equal(readFileSync(compose, "utf8"), original);
  assert.deepEqual(readdirSync(root), ["compose.json"]);
});
await fixture(async ({ secret, mock, call, commands }) => {
  const { DISCORD_BLACKLIST_CHANNEL_ID: ignored, ...onlyGuild } = pinned;
  settingsFile(secret, onlyGuild);
  mock.channels.push(
    { id: "22", type: 2, name: "blacklist", guild_id: guild },
    { id: "33", type: 0, name: "Blacklist", guild_id: guild },
    { id: "44", type: 0, name: "blacklist", guild_id: "999" },
  );
  assert.deepEqual(await call("preview"), {
    status: "preview",
    channelId: channel,
    ...counts,
  });
  mock.channels.push({ id: "99", type: 5, name: "blacklist", guild_id: guild });
  await assert.rejects(call("preview"), /exactly one/);
  mock.channels = [];
  await assert.rejects(call("preview"), /exactly one/);
  assert.equal(mock.discoveries, 3);
  assert.equal(commands.length, 1);
});
await fixture(async ({ home, secret, mock, call, commands }) => {
  mkdirSync(join(home, "operation.lock"));
  await assert.rejects(call("enable"), /holds the machine lock/);
  rmSync(join(home, "operation.lock"), { recursive: true });
  mock.state.phase = "handed-off";
  await assert.rejects(call("enable"), /active managed/);
  mock.state.phase = "active";
  mock.endpoint = "ssh://fixture-remote";
  await assert.rejects(call("enable"), /local managed/);
  mock.endpoint = "unix:///fixture";
  chmodSync(secret, 0o644);
  await assert.rejects(call("preview"), /600/);
  chmodSync(secret, 0o600);
  renameSync(secret, secret + ".original");
  symlinkSync(secret + ".original", secret);
  await assert.rejects(call("preview"), { code: "ELOOP" });
  rmSync(secret);
  for (const [key, bad] of [
    ["DISCORD_BOT_TOKEN", ""],
    ["DISCORD_GUILD_ID", "123/456"],
    ["DISCORD_BLACKLIST_CHANNEL_ID", "general"],
  ]) {
    settingsFile(secret, { ...pinned, [key]: bad });
    await assert.rejects(call("enable"), new RegExp(key));
  }
  assert.equal(commands.length, 0);
});
await fixture(async ({ home, mock, call, compose, original, root }) => {
  mock.output = { ...counts, characters: -1 };
  await assert.rejects(call("enable"), /invalid counts/);
  mock.output = { ...counts, lastId: fixtureToken };
  await assert.rejects(call("enable"), /invalid message checkpoint/);
  mock.output = counts;
  mock.runtimeOverride.worker = { MEMBERSHIP_DECISIONS_PAUSED: "0" };
  await assert.rejects(call("enable"), /Pause membership/);
  assert.equal(readFileSync(compose, "utf8"), original);
  delete mock.runtimeOverride.worker;
  const config = JSON.parse(original);
  config.services.app.environment.MEMBERSHIP_DECISIONS_PAUSED = "0";
  settingsFile(compose, config);
  mock.runtimeOverride.app = { MEMBERSHIP_DECISIONS_PAUSED: "1" };
  await assert.rejects(call("enable"), /Pause membership/);
  assert.deepEqual(readdirSync(root), ["compose.json"]);
  assert.ok(!existsSync(join(home, "operation.lock")));
});
await fixture(async ({ root, compose, original, commands, mock, call }) => {
  assert.deepEqual(await call("enable"), {
    status: "enabled",
    channelId: channel,
    ...counts,
  });
  const expected = JSON.parse(original),
    escaped = fixtureToken.replaceAll("$", () => "$$");
  Object.assign(expected.services.app.environment, {
    DISCORD_GUILD_ID: guild,
    DISCORD_BOT_TOKEN: escaped,
  });
  Object.assign(expected.services.worker.environment, {
    ...pinned,
    DISCORD_BOT_TOKEN: escaped,
  });
  assert.deepEqual(JSON.parse(readFileSync(compose)), expected);
  const backup = readdirSync(root).find((n) =>
    n.startsWith("compose-before-blacklist-"),
  );
  assert.equal(statSync(join(root, backup)).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(root, backup), "utf8"), original);
  assert.equal(statSync(compose).mode & 0o777, 0o600);
  assert.deepEqual(commands.slice(1), [
    ["config", "--quiet"],
    ["rm", "--stop", "--force", "tunnel"],
    [
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "180",
      "app",
      "worker",
    ],
    ["exec", "-T", "worker", "node", "dist/worker-health.js"],
    ["up", "-d", "--no-deps", "--force-recreate", "tunnel"],
  ]);
  assert.equal(mock.publicChecks, 1);
  const before = commands.length;
  await call("enable");
  assert.equal(commands.length, before + 1);
  assert.equal(mock.publicChecks, 1);
  assert.equal(readdirSync(root).length, 2);
});
await fixture(async ({ root, compose, original, mock, call }) => {
  mock.failHealth = 1;
  await assert.rejects(
    call("enable"),
    /previous Compose configuration was restored/,
  );
  assert.equal(readFileSync(compose, "utf8"), original);
  assert.equal(mock.publicChecks, 1);
  assert.ok(!existsSync(join(root, ".blacklist-enable-pending.json")));
});
await fixture(async ({ root, compose, original, secret, mock, call }) => {
  mock.failHealth = 2;
  await assert.rejects(call("enable"), /fixture worker not healthy/);
  const marker = join(root, ".blacklist-enable-pending.json");
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  await assert.rejects(call("preview"), /interrupted enable/);
  settingsFile(compose, { manuallyEdited: true });
  await assert.rejects(call("enable"), /deployment changed/);
  assert.deepEqual(JSON.parse(readFileSync(compose)), { manuallyEdited: true });
  writeFileSync(compose, original);
  rmSync(secret);
  assert.deepEqual(await call("enable"), { status: "restored" });
  assert.equal(readFileSync(compose, "utf8"), original);
  assert.ok(!existsSync(marker));
});
// Malformed private data and unknown exceptions must never make it into CLI output.
const invalid = mkdtempSync(join(tmpdir(), "mytikas-blacklist-cli-"));
try {
  mkdirSync(join(invalid, ".mytikas"), { mode: 0o700 });
  writeFileSync(join(invalid, ".mytikas", "machine.json"), fixtureToken);
  const r = spawnSync(
    process.execPath,
    ["scripts/blacklist-host.mjs", "preview"],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: invalid, USERPROFILE: invalid },
    },
  );
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /Managed blacklist operation failed/);
  assert.ok(!r.stderr.includes(fixtureToken));
} finally {
  rmSync(invalid, { recursive: true, force: true });
}
console.log("Managed blacklist preview, activation and recovery tests passed.");
