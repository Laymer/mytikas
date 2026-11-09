import pg from "pg";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
function positive(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
export const createPool = (connectionString: string) => {
  const tls = process.env.DATABASE_TLS ?? "disable";
  if (!["disable", "verify-full"].includes(tls)) throw new Error("DATABASE_TLS must be disable or verify-full");
  // URL SSL options can override pg's explicit TLS object: reject ambiguous configuration.
  const url = new URL(connectionString);
  if ([...url.searchParams.keys()].some(key => key.startsWith("ssl")))
    throw new Error("Configure database TLS with DATABASE_TLS and DATABASE_CA_FILE, not URL SSL parameters");
  const pool = new pg.Pool({
    connectionString,
    max: positive("DATABASE_POOL_MAX", 10),
    connectionTimeoutMillis: positive("DATABASE_CONNECT_TIMEOUT_MS", 5000),
    statement_timeout: positive("DATABASE_QUERY_TIMEOUT_MS", 15000),
    ssl: tls === "verify-full" ? {
      rejectUnauthorized: true,
      ...(process.env.DATABASE_CA_FILE ? { ca: readFileSync(process.env.DATABASE_CA_FILE, "utf8") } : {}),
    } : false,
  });
  // Idle clients can fail during a database restart. Without a listener pg emits
  // an unhandled error (including its client object) and terminates the process.
  pool.on("error", () => console.error(JSON.stringify({ event: "database_idle_connection_lost" })));
  return pool;
};
export type Pool = pg.Pool;
export async function transaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
