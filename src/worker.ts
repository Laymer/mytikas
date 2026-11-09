import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { createPool, type Pool } from "./db.js";
import { checkMembership, verifyMembership, type Verify } from "./armory.js";
import { deliverDiscord } from "./discord.js";

export async function membershipTick(pool: Pool, verify: Verify, running = () => true) {
  const { rows } = await pool.query(
    `SELECT id FROM applications WHERE status='APPROVED' AND next_check_at<=now() ORDER BY next_check_at LIMIT 20`,
  );
  for (const app of rows) {
    if (!running()) break;
    const result = await checkMembership(pool, app.id, verify, true);
    if (result !== null) console.info(JSON.stringify({ event: "membership_check", applicationId: app.id, result }));
  }
}
export async function discordTick(pool: Pool, webhook: string | undefined, origin: string, running = () => true) {
  for (let i = 0; i < 10 && running(); i++) {
    if (!(await deliverDiscord(pool, webhook, origin))) break;
  }
}
export async function cleanupTick(pool: Pool) {
  await pool.query("DELETE FROM auth_limits WHERE reset_at<now()");
  await pool.query("DELETE FROM sessions WHERE expire<now()");
}
// Retained for isolated demo and deterministic integration tests.
export async function tick(pool: Pool, webhook: string | undefined, origin: string, verify: Verify = verifyMembership) {
  await Promise.all([membershipTick(pool, verify), discordTick(pool, webhook, origin), cleanupTick(pool)]);
}

export async function runLoop(name: string, operation: () => Promise<unknown>, signal: AbortSignal, interval = 5000) {
  while (!signal.aborted) {
    try { await operation(); }
    catch { console.error(JSON.stringify({ event: "worker_cycle_failed", lane: name })); }
    if (!signal.aborted) await sleep(interval, undefined, { signal }).catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = config(), pool = createPool(cfg.databaseUrl);
  const controller = new AbortController(), id = randomUUID();
  let deadline: NodeJS.Timeout | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    deadline = setTimeout(() => {
      console.error(JSON.stringify({ event: "worker_shutdown_timeout" }));
      process.exit(1);
    }, 30000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await writeFile(process.env.WORKER_ID_FILE || "/tmp/mytikas-worker-id", id, { mode: 0o600 });
    const running = () => !controller.signal.aborted;
    await Promise.all([
      runLoop("discord", () => discordTick(pool, cfg.discordWebhook, cfg.origin, running), controller.signal),
      runLoop("armory", () => membershipTick(pool, verifyMembership, running), controller.signal),
      runLoop("maintenance", async () => {
        await pool.query("INSERT INTO worker_heartbeats(id) VALUES ($1) ON CONFLICT(id) DO UPDATE SET updated_at=now()", [id]);
        await pool.query("DELETE FROM worker_heartbeats WHERE updated_at<now()-interval '1 day'");
        await cleanupTick(pool);
      }, controller.signal, 10000),
    ]);
  } finally {
    await pool.query("DELETE FROM worker_heartbeats WHERE id=$1", [id]).catch(() => {});
    await pool.end();
    if (deadline) clearTimeout(deadline);
  }
}
