import type { Pool } from "../db.js";

export const dataset = "mytikas-demo-v1";

export function requireDemoMode() {
  if (
    process.env.MYTIKAS_DEMO !== "1" ||
    (process.env.DEPLOYMENT_PROFILE &&
      process.env.DEPLOYMENT_PROFILE !== "demo")
  ) {
    throw new Error("Use the isolated demo deployment for this command.");
  }
}

export async function requireDemoDataset(pool: Pool) {
  const {
    rows: [tables],
  } = await pool.query(
    "SELECT to_regclass('public.demo_dataset') IS NOT NULL AND to_regclass('public.demo_fixtures') IS NOT NULL AS ready",
  );
  if (tables.ready) {
    const marker = await pool.query(
      "SELECT version FROM public.demo_dataset LIMIT 2",
    );
    if (marker.rowCount === 1 && marker.rows[0].version === dataset) return;
  }
  throw new Error(
    "Demo dataset is missing or unsupported. Run the demo setup first.",
  );
}
