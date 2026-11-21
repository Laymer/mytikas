import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, harness } from "./harness.js";

import { reportBlacklistConfiguration } from "../src/blacklist-status.js";

const h = await harness();
const directory = await mkdtemp(join(tmpdir(), "mytikas-integration-health-"));
const id = randomUUID();
const idFile = join(directory, "worker-id");
const moderation = {
  DISCORD_BOT_TOKEN: "fixture",
  DISCORD_GUILD_ID: "123",
  DISCORD_BLACKLIST_CHANNEL_ID: "456",
};
const enabled = { ...moderation, ADDON_RELEASE_TOKEN: "fixture" };
function health(integrations: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/worker-health.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: h.cfg.databaseUrl,
        WORKER_ID_FILE: idFile,
        DISCORD_BOT_TOKEN: "",
        DISCORD_GUILD_ID: "",
        DISCORD_BLACKLIST_CHANNEL_ID: "",
        ADDON_RELEASE_TOKEN: "",
        ...integrations,
      },
      encoding: "utf8",
      timeout: 8000,
    },
  );
  assert.equal(result.error, undefined);
  return result.status;
}
try {
  const visitor = new Client(h.cfg.origin);
  assert.equal((await visitor.request("/api/blacklist")).status, 401);
  await visitor.login("mod@example.test");
  assert.equal((await visitor.request("/api/blacklist")).status, 403);
  const admin = new Client(h.cfg.origin);
  await admin.login();
  const status = async () => (await admin.request("/api/blacklist")).data.bot;
  assert.deepEqual(await status(), {
    state: "worker-unavailable",
    missing: [],
    lastSyncAt: null,
  });
  await reportBlacklistConfiguration(h.pool, false, {
    DISCORD_GUILD_ID: "123",
  });
  assert.deepEqual(await status(), {
    state: "missing-configuration",
    missing: ["bot token", "blacklist channel ID"],
    lastSyncAt: null,
  });
  await reportBlacklistConfiguration(h.pool, false, moderation);
  assert.equal((await status()).state, "awaiting-first-sync");
  await writeFile(idFile, id);
  await h.pool.query("INSERT INTO worker_heartbeats(id) VALUES($1)", [id]);
  assert.equal(health(), 1);
  await h.pool.query(
    "INSERT INTO integration_health VALUES('blacklist-armory',now())",
  );
  assert.equal(health(), 0);
  assert.equal(health({ ADDON_RELEASE_TOKEN: "fixture" }), 1);
  await h.pool.query(
    "INSERT INTO integration_health VALUES('addon',now()),('blacklist-history',now())",
  );
  await reportBlacklistConfiguration(h.pool, true, moderation);
  assert.equal((await status()).state, "syncing");
  assert.ok(Date.parse((await status()).lastSyncAt));
  await h.pool.query(
    "UPDATE integration_health SET succeeded_at=now()-interval '16 minutes' WHERE lane='blacklist-history'",
  );
  assert.equal((await status()).state, "stale");
  await reportBlacklistConfiguration(h.pool, false, moderation);
  assert.equal(
    (await status()).state,
    "awaiting-first-sync",
    "restarted worker waits for its own first poll",
  );
  await h.pool.query(
    "UPDATE integration_health SET succeeded_at=now() WHERE lane='blacklist-history'",
  );
  await reportBlacklistConfiguration(h.pool, false, {
    DISCORD_BOT_TOKEN: "example-secret",
  });
  const incomplete = await status();
  assert.deepEqual(incomplete.missing, ["guild ID", "blacklist channel ID"]);
  assert.ok(!JSON.stringify(incomplete).includes("example-secret"));
  await h.pool.query(
    "UPDATE integration_health SET succeeded_at=now()-interval '1 minute' WHERE lane='blacklist-configuration'",
  );
  assert.equal((await status()).state, "worker-unavailable");
  assert.equal(health(enabled), 1);
  await h.pool.query(
    "INSERT INTO integration_health VALUES('blacklist-warnings',now())",
  );
  assert.equal(health(enabled), 0);
  for (const missing of Object.keys(moderation)) {
    assert.equal(
      health({ ...enabled, [missing]: "" }),
      1,
      "missing " + missing,
    );
  }
  for (const lane of [
    "addon",
    "blacklist-history",
    "blacklist-warnings",
    "blacklist-armory",
  ]) {
    await h.pool.query(
      "UPDATE integration_health SET succeeded_at=now()-interval '16 minutes' WHERE lane=$1",
      [lane],
    );
    assert.equal(health(enabled), 1, "stale " + lane);
    await h.pool.query(
      "UPDATE integration_health SET succeeded_at=now() WHERE lane=$1",
      [lane],
    );
  }
  await h.pool.query(
    "UPDATE worker_heartbeats SET updated_at=now()-interval '1 minute' WHERE id=$1",
    [id],
  );
  assert.equal(health(enabled), 1);
  console.log(
    "Worker probe rejects incomplete configuration, stale integrations and an expired process heartbeat.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
  await h.stop();
}
