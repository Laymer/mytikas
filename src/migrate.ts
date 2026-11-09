import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPool, transaction, type Pool } from "./db.js";
export async function schemaReady(pool: Pool): Promise<boolean> {
  const names = (await readdir("migrations")).filter(n => n.endsWith(".sql")).sort();
  const applied = (await pool.query("SELECT name, checksum FROM migrations")).rows;
  if (applied.length !== names.length) return false;
  for (const name of names) {
    const checksum = createHash("sha256").update(await readFile(`migrations/${name}`, "utf8")).digest("hex");
    if (!applied.some(row => row.name === name && row.checksum === checksum)) return false;
  }
  return true;
}
export async function migrate(pool: Pool) {
  await transaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(100)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await c.query("ALTER TABLE migrations ADD COLUMN IF NOT EXISTS checksum text");
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(`migrations/${name}`, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = (await c.query("SELECT checksum FROM migrations WHERE name=$1", [name])).rows[0];
      if (applied) {
        if (!applied.checksum) {
          if (process.env.ADOPT_MIGRATION_CHECKSUMS !== "1")
            throw new Error("Legacy migrations require reviewed ADOPT_MIGRATION_CHECKSUMS=1 adoption");
          await c.query("UPDATE migrations SET checksum=$2 WHERE name=$1", [name, checksum]);
        } else if (applied.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      await c.query(sql);
      await c.query("INSERT INTO migrations(name,checksum) VALUES ($1,$2)", [name, checksum]);
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
