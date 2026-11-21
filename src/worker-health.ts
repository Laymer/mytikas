import { readFile } from "node:fs/promises";
import { createPool } from "./db.js";
const pool = createPool(process.env.DATABASE_URL || "");
try {
  const id = (await readFile(process.env.WORKER_ID_FILE || "/tmp/mytikas-worker-id", "utf8")).trim();
  const result = await pool.query("SELECT 1 FROM worker_heartbeats WHERE id=$1 AND updated_at>now()-interval '45 seconds'", [id]);
  const required = ["blacklist-armory"];
  if (process.env.ADDON_RELEASE_TOKEN) required.push("addon");
  if (process.env.DISCORD_BOT_TOKEN) required.push("blacklist-history","blacklist-warnings");
  const lanes = await pool.query("SELECT lane FROM integration_health WHERE lane=ANY($1) AND succeeded_at>now()-interval '15 minutes'",[required]);
  process.exitCode = result.rowCount === 1 && lanes.rowCount === required.length ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
