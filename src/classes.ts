import { randomUUID } from "node:crypto";
import {
  profileUrl,
  limitedText,
  parseProfile,
  membershipResult,
} from "./armory.js";
import { CLASSES } from "./rosters.js";
import { transaction, type Pool } from "./db.js";
export function profileClass(character: any, name: string): string | null {
  const result = membershipResult(character, name);
  if (!["MATCH", "GUILD_MISMATCH"].includes(result)) throw new Error(result);
  const value = character.class?.enum;
  return typeof value === "string"
    ? CLASSES.find((c) => c.toUpperCase() === value.toUpperCase()) || null
    : null;
}
export async function fetchClass(
  name: string,
  transport: typeof fetch = fetch,
): Promise<string | null> {
  const r = await transport(profileUrl(name), {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { Accept: "text/html" },
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error("ARMORY_UNAVAILABLE");
  }
  return profileClass(parseProfile(await limitedText(r, 2_000_000)), name);
}
export async function classTick(
  pool: Pool,
  fetcher: (name: string) => Promise<string | null> = fetchClass,
) {
  const token = randomUUID();
  const {
    rows: [job],
  } = await pool.query(
    `UPDATE class_jobs SET lease_token=$1,lease_until=now()+interval '2 minutes',attempts=attempts+1 WHERE application_id=(SELECT application_id FROM class_jobs WHERE available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    [token],
  );
  if (!job) return false;
  const {
    rows: [a],
  } = await pool.query(
    "SELECT character_name,status FROM applications WHERE id=$1",
    [job.application_id],
  );
  let klass: string | null = null,
    ok = false;
  if (a?.status === "JOINED")
    try {
      klass = await fetcher(a.character_name);
      ok = true;
    } catch {}
  await transaction(pool, async (c) => {
    // Application first, matching refresh and JOINED trigger lock order.
    const {
      rows: [current],
    } = await c.query(
      "SELECT status FROM applications WHERE id=$1 FOR UPDATE",
      [job.application_id],
    );
    if (
      !(
        await c.query(
          "SELECT 1 FROM class_jobs WHERE application_id=$1 AND lease_token=$2 FOR UPDATE",
          [job.application_id, token],
        )
      ).rowCount
    )
      return;
    if (current?.status === "JOINED")
      await c.query(
        `UPDATE applications SET armory_class=CASE WHEN $2 THEN $3 ELSE armory_class END,class_checked_at=now(),class_result=$4 WHERE id=$1`,
        [
          job.application_id,
          ok,
          klass,
          ok ? (klass ? "FOUND" : "UNKNOWN") : "UNAVAILABLE",
        ],
      );
    if (ok || current?.status !== "JOINED" || job.attempts >= 6)
      await c.query("DELETE FROM class_jobs WHERE application_id=$1", [
        job.application_id,
      ]);
    else
      await c.query(
        "UPDATE class_jobs SET lease_token=NULL,lease_until=NULL,available_at=now()+($2*interval '1 second') WHERE application_id=$1",
        [job.application_id, Math.min(3600, 60 * 2 ** job.attempts)],
      );
  });
  return true;
}
