import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { createPool, type Pool } from "./db.js";
import { checkMembership, verifyMembership, type Verify } from "./armory.js";
import { deliverDiscord } from "./discord.js";
export async function tick(
  pool: Pool,
  webhook: string | undefined,
  origin: string,
  verify: Verify = verifyMembership,
) {
  const { rows } = await pool.query(
    `SELECT id FROM applications WHERE status='APPROVED' AND next_check_at<=now() ORDER BY next_check_at LIMIT 20`,
  );
  for (const app of rows) await checkMembership(pool, app.id, verify, true);
  for (
    let i = 0;
    i < 10 && (await deliverDiscord(pool, webhook, origin));
    i++
  ) {
    /* Drain bounded batch. */
  }
  await pool.query("DELETE FROM auth_limits WHERE reset_at<now()");
  await pool.query("DELETE FROM sessions WHERE expire<now()");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const cfg = config(),
    pool = createPool(cfg.databaseUrl);
  let running = true;
  process.on("SIGTERM", () => {
    running = false;
  });
  process.on("SIGINT", () => {
    running = false;
  });
  console.log(
    `Worker running; Discord ${cfg.discordWebhook ? "enabled" : "disabled"}.`,
  );
  while (running) {
    try {
      await tick(pool, cfg.discordWebhook, cfg.origin);
    } catch {
      console.error("Worker cycle failed; retrying on next cycle.");
    }
    if (running) await sleep(5000);
  }
  await pool.end();
}
