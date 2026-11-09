import { readFile } from "node:fs/promises";
import { createPool } from "./db.js";
const pool = createPool(process.env.DATABASE_URL || "");
try {
  const id = (await readFile(process.env.WORKER_ID_FILE || "/tmp/mytikas-worker-id", "utf8")).trim();
  const result = await pool.query("SELECT 1 FROM worker_heartbeats WHERE id=$1 AND updated_at>now()-interval '45 seconds'", [id]);
  process.exitCode = result.rowCount === 1 ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
