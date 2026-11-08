import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPool, transaction, type Pool } from "./db.js";
export async function migrate(pool: Pool) {
  await transaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(100)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (
        (await c.query("SELECT 1 FROM migrations WHERE name=$1", [name]))
          .rowCount
      )
        continue;
      await c.query(await readFile(`migrations/${name}`, "utf8"));
      await c.query("INSERT INTO migrations(name) VALUES ($1)", [name]);
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const pool = createPool(process.env.DATABASE_URL || "");
  try {
    await migrate(pool);
    console.log("Migrations complete.");
  } finally {
    await pool.end();
  }
}
