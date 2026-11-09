import { randomUUID } from "node:crypto";
import type { Pool } from "./db.js";
import type { PoolClient } from "pg";
import { limitedText } from "./armory.js";
export type DiscordSubmission = {
  id: string;
  application_id: string;
  revision: number;
  character_name: string;
  motivation: string;
  rules_id: number;
  accepted_at: Date | string;
};
// Escape Markdown and neutralize mentions, including text displayed outside Discord clients.
const discordText = (value: string, limit: number) =>
  value.replace(/[\\`*_{}\[\]()<>~|>#]/g, "\\$&").replace(/@/g, "@\u200b").slice(0, limit);
export function discordPayload(submission: DiscordSubmission, origin: string) {
  const review = new URL(`/admin.html#${encodeURIComponent(submission.application_id)}`, origin).href;
  return {
    content: `Guild application: ${discordText(submission.character_name, 200)}\nReference: ${submission.application_id}\n${review}`,
    embeds: [{
      title: "Application submission",
      fields: [
        { name: "Motivation", value: discordText(submission.motivation, 1000) || "—" },
        { name: "Submission", value: `${submission.id} · revision ${submission.revision}` },
        { name: "Rules accepted", value: `Version ${submission.rules_id} · ${new Date(submission.accepted_at).toISOString()}` },
      ],
    }],
    allowed_mentions: { parse: [] },
  };
}
export async function deliverDiscord(
  pool: Pool,
  webhook: string | undefined,
  origin: string,
) {
  if (!webhook) return false;
  const connection = await pool.connect();
  let locked = false;
  try {
    locked = (
      await connection.query("SELECT pg_try_advisory_lock(3) AS locked")
    ).rows[0].locked;
    if (!locked) return false;
    const {
      rows: [state],
    } = await connection.query(
      "SELECT not_before>now() AS paused FROM discord_delivery_state WHERE id=1",
    );
    if (state.paused) return false;
    return await deliverOne(connection, webhook, origin);
  } finally {
    try {
      if (locked) await connection.query("SELECT pg_advisory_unlock(3)");
    } finally {
      connection.release();
    }
  }
}
async function deliverOne(pool: PoolClient, webhook: string, origin: string) {
  await pool.query(
    `UPDATE discord_jobs SET status='FAILED',last_error='RETRIES_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE status='PENDING' AND attempts>=8 AND (lease_until IS NULL OR lease_until<now())`,
  );
  const token = randomUUID();
  const {
    rows: [job],
  } = await pool.query(
    `UPDATE discord_jobs SET lease_token=$1, lease_until=now()+interval '1 minute', attempts=attempts+1 WHERE id=(
 SELECT id FROM discord_jobs WHERE status='PENDING' AND attempts<8 AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    [token],
  );
  if (!job) return false;
  const {
    rows: [submission],
  } = await pool.query(
    "SELECT id,application_id,revision,character_name,motivation,rules_id,accepted_at FROM submissions WHERE id=$1",
    [job.submission_id],
  );
  let status = "PENDING",
    error: string | null = null,
    delay = Math.min(3600, 15 * 2 ** (job.attempts - 1));
  let rateLimited = false;
  try {
    const url = new URL(webhook);
    url.searchParams.set("wait", "true");
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        discordPayload(submission, origin),
      ),
    });
    if (response.ok) {
      status = "DELIVERED";
      if (response.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(response.headers.get("x-ratelimit-reset-after"));
        if (Number.isFinite(reset) && reset > 0) {
          rateLimited = true;
          delay = reset;
        }
      }
      await response.body?.cancel();
    } else if (response.status === 429) {
      rateLimited = true;
      error = "HTTP_429";
      let retry = Number(response.headers.get("retry-after")) || 0;
      try {
        retry = Math.max(
          retry,
          Number(JSON.parse(await limitedText(response, 16000)).retry_after) ||
            0,
        );
      } catch {
        /* Keep bounded backoff when response is malformed. */
      }
      delay = Math.max(delay, Number.isFinite(retry) ? retry : 0);
    } else {
      error = `HTTP_${response.status}`;
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408
      )
        status = "FAILED";
      await response.body?.cancel();
    }
  } catch {
    error = "DELIVERY_UNAVAILABLE";
  }
  if (job.attempts >= 8 && status === "PENDING") status = "FAILED";
  await pool.query(
    `UPDATE discord_jobs SET status=$3,last_error=$4,available_at=now()+($5 * interval '1 second'), lease_token=NULL,lease_until=NULL,
 delivered_at=CASE WHEN $3='DELIVERED' THEN now() ELSE NULL END WHERE id=$1 AND lease_token=$2`,
    [job.id, token, status, error, delay],
  );
  console.info(JSON.stringify({ event: "discord_delivery", jobId: job.id, submissionId: job.submission_id, status, error, attempt: job.attempts }));
  if (rateLimited) {
    await pool.query(
      `UPDATE discord_delivery_state SET not_before=now()+($1 * interval '1 second') WHERE id=1`,
      [delay],
    );
    await pool.query(
      `UPDATE discord_jobs SET available_at=GREATEST(available_at, now()+($1 * interval '1 second')) WHERE status='PENDING'`,
      [delay],
    );
  }
  return true;
}
