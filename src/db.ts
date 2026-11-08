import pg from "pg";
import type { PoolClient } from "pg";
export const createPool = (connectionString: string) =>
  new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
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
