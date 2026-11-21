import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "./harness.js";

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
