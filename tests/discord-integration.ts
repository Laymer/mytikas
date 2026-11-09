import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { harness, Client } from "./harness.js";
import { deliverDiscord } from "../src/discord.js";
import { membershipTick, discordTick } from "../src/worker.js";
const h = await harness();
try {
  const client = new Client(h.cfg.origin);
  await client.init();
  assert.equal((await client.signup("Notify Tester", "notify@example.test", { motivation: "Original motivation @everyone" })).status, 201);
  const original = (await client.application()).submissions[0];
  // The mutable application is deliberately changed before its queued notification delivers.
  await h.pool.query("UPDATE applications SET character_name='Changed Later',revision=2,status='APPROVED',next_check_at=now() WHERE id=$1", [original.application_id]);
  let unblock!: () => void;
  let started!: () => void;
  const checking = new Promise<void>((resolve) => { started = resolve; });
  const slow = new Promise<string>((resolve) => { unblock = () => resolve("UNAVAILABLE"); });
  const armory = membershipTick(h.pool, () => { started(); return slow; });
  await checking;
  await discordTick(h.pool, h.cfg.discordWebhook, h.cfg.origin);
  assert.equal(h.discord.messages.length, 1, "Notification completes while Armory remains pending");
  const message = h.discord.messages[0];
  assert.ok(message.content.includes("Notify Tester"));
  assert.ok(!message.content.includes("Changed Later"));
  assert.ok(!JSON.stringify(message).includes("notify@example.test"));
  assert.equal(message.embeds[0].fields[0].value, "Original motivation @\u200beveryone");
  assert.ok(message.embeds[0].fields[1].value.includes(original.id));
  assert.ok(message.embeds[0].fields[1].value.includes("revision 1"));
  unblock();
  await armory;
  assert.equal(await deliverDiscord(h.pool, h.cfg.discordWebhook, h.cfg.origin), false);
  const worker = randomUUID();
  await h.pool.query("INSERT INTO worker_heartbeats(id) VALUES ($1)", [worker]);
  assert.equal((await h.pool.query("SELECT 1 FROM worker_heartbeats WHERE id=$1 AND updated_at>now()-interval '45 seconds'", [worker])).rowCount, 1);
  await h.pool.query("UPDATE worker_heartbeats SET updated_at=now()-interval '1 minute' WHERE id=$1", [worker]);
  assert.equal((await h.pool.query("SELECT 1 FROM worker_heartbeats WHERE id=$1 AND updated_at>now()-interval '45 seconds'", [worker])).rowCount, 0);
  const directory = await mkdtemp(join(tmpdir(), "mytikas-worker-test-"));
  const env = { ...process.env, DATABASE_URL: h.cfg.databaseUrl, SESSION_SECRET: h.cfg.sessionSecret,
    APP_ORIGIN: h.cfg.origin, DEPLOYMENT_PROFILE: "local", INGRESS_MODE: "none", MYTIKAS_DEMO: "0",
    DISCORD_WEBHOOK_URL: "", WORKER_ID_FILE: join(directory, "id") };
  // Exercise the missing identity-file failure deterministically, rather than
  // depending on whether health polling wins the worker startup race.
  const missingHealth = spawn(process.execPath, ["--import", "tsx", "src/worker-health.ts"], { env, stdio: "ignore" });
  assert.equal((await once(missingHealth, "exit"))[0], 1);
  const workerProcess = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { env, stdio: "ignore" });
  const exited = once(workerProcess, "exit");
  try {
    let healthy = false;
    for (let i = 0; i < 30 && !healthy; i++) {
      const health = spawn(process.execPath, ["--import", "tsx", "src/worker-health.ts"], { env, stdio: "ignore" });
      healthy = (await once(health, "exit"))[0] === 0;
      if (!healthy) await sleep(100);
    }
    assert.ok(healthy, "Running worker has a process-specific heartbeat");
    workerProcess.kill("SIGTERM");
    const result = await Promise.race([exited, sleep(5000).then(() => { throw new Error("Worker failed to drain"); })]);
    assert.equal(result[0], 0);
    const health = spawn(process.execPath, ["--import", "tsx", "src/worker-health.ts"], { env, stdio: "ignore" });
    assert.equal((await once(health, "exit"))[0], 1, "Stopped worker is unhealthy");
  } finally {
    if (workerProcess.exitCode === null) workerProcess.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
  console.log("Immutable Discord delivery, independent scheduling, heartbeat and SIGTERM integration passed.");
} finally { await h.stop(); }
