import type { PoolClient } from "pg";
import { transaction, type Pool } from "./db.js";
import { HttpError, normalize } from "./validation.js";
import { assertRole, clearRosterSlots } from "./applications.js";
import { profileUrl, verifyMembership, type Verify } from "./armory.js";

export const moderationLock = "SELECT pg_advisory_xact_lock(3)";
export async function blocked(c: PoolClient, key: string) {
  return !!(
    await c.query(
      "SELECT 1 FROM blacklist_reports WHERE character_key=$1 AND voided_at IS NULL LIMIT 1",
      [key],
    )
  ).rowCount;
}
export function parseReport(m: any) {
  if (
    m.author?.bot ||
    !m.author?.id ||
    m.webhook_id ||
    m.message_snapshots?.length ||
    typeof m.content !== "string"
  )
    return;
  const lines: string[] = m.content.split(/\r?\n/);
  if (
    lines.length !== 3 ||
    !["Name: ", "Surname: ", "Reason: "].every((label, i) =>
      lines[i]?.startsWith(label),
    )
  )
    return;
  const [first, last, reason] = lines.map((line) =>
    line.slice(line.indexOf(": ") + 2).trim(),
  );
  if (!first || !last || !reason || /[`]/.test(m.content)) return;
  const name = first + " " + last;
  return { name, key: normalize(name), reason };
}
export async function importReport(
  c: PoolClient,
  m: any,
  guild: string,
  channel: string,
) {
  const r = parseReport(m);
  if (!r || m.channel_id !== channel || (m.guild_id && m.guild_id !== guild))
    return;
  await c.query(moderationLock);
  const added = await c.query(
    `INSERT INTO blacklist_reports(message_id,guild_id,channel_id,reporter_id,reported_at,character_name,character_key,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [m.id, guild, channel, m.author.id, m.timestamp, r.name, r.key, r.reason],
  );
  if (!added.rowCount) return;
  const a = (
    await c.query(
      "SELECT id,status FROM applications WHERE character_key=$1 FOR UPDATE",
      [r.key],
    )
  ).rows[0];
  if (!a || a.status === "BLACKLISTED") return;
  await clearRosterSlots(c, a.id);
  await c.query(
    `UPDATE applications SET status='BLACKLISTED',updated_at=now(),next_check_at=NULL,
    check_result=CASE WHEN check_token IS NULL THEN check_result ELSE 'CANCELLED' END,
    check_token=NULL,check_started_at=NULL,joined_via=NULL WHERE id=$1`,
    [a.id],
  );
  await c.query(
    "INSERT INTO events(application_id,from_status,to_status,method) VALUES($1,$2,'BLACKLISTED','BLACKLIST')",
    [a.id, a.status],
  );
}
export async function voidReport(
  pool: Pool,
  id: string,
  actor: string,
  reason: string,
) {
  if (!reason.trim() || reason.length > 2000)
    throw new HttpError(
      400,
      "Enter a correction reason (up to 2000 characters).",
    );
  await transaction(pool, async (c) => {
    await c.query(moderationLock);
    await assertRole(c, actor, true);
    const report = (
      await c.query(
        `UPDATE blacklist_reports SET voided_at=now(),voided_by=$2,correction=$3
      WHERE message_id=$1 AND voided_at IS NULL RETURNING character_key`,
        [id, actor, reason.trim()],
      )
    ).rows[0];
    if (!report) throw new HttpError(409, "Report is no longer active.");
    if (await blocked(c, report.character_key)) return;
    const a = (
      await c.query(
        `UPDATE applications a SET updated_at=now(),
      status=CASE WHEN u.email_verified_at IS NULL AND NOT u.activation_exempt THEN 'PENDING_EMAIL' ELSE 'SUBMITTED' END
      FROM users u WHERE a.user_id=u.id AND a.character_key=$1 AND a.status='BLACKLISTED' RETURNING a.id,a.status`,
        [report.character_key],
      )
    ).rows[0];
    if (a)
      await c.query(
        "INSERT INTO events(application_id,actor_id,from_status,to_status,method) VALUES($1,$2,'BLACKLISTED',$3,'CORRECTION')",
        [a.id, actor, a.status],
      );
  });
}
export async function discordBot(path: string, init: RequestInit = {}) {
  const res = await fetch("https://discord.com/api/v10" + path, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(12000),
    headers: {
      Authorization: "Bot " + process.env.DISCORD_BOT_TOKEN,
      "Content-Type": "application/json",
    },
  });
  return res;
}
export async function discordJson(path: string, init?: RequestInit) {
  const response = await discordBot(path, init);
  if (!response.ok) throw new Error("Discord unavailable: " + response.status);
  return response.json();
}
export async function reportsTick(pool: Pool) {
  const guild = process.env.DISCORD_GUILD_ID,
    channel = process.env.DISCORD_BLACKLIST_CHANNEL_ID;
  if (!guild || !channel || !process.env.DISCORD_BOT_TOKEN) return;
  if ((await discordJson("/channels/" + channel)).guild_id !== guild)
    throw new Error("Blacklist channel guild mismatch");
  const cursor =
    (
      await pool.query(
        "SELECT last_id FROM blacklist_checkpoint WHERE channel_id=$1",
        [channel],
      )
    ).rows[0]?.last_id ?? "0";
  const messages = await discordJson(
    `/channels/${channel}/messages?limit=100&after=${cursor}`,
  );
  if (!messages.length) return;
  messages.sort((a: any, b: any) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  await transaction(pool, async (c) => {
    await c.query(moderationLock);
    for (const msg of messages) await importReport(c, msg, guild, channel);
    await c.query(
      `INSERT INTO blacklist_checkpoint VALUES($1,$2) ON CONFLICT(channel_id) DO UPDATE SET last_id=excluded.last_id
      WHERE blacklist_checkpoint.last_id::numeric<excluded.last_id::numeric`,
      [channel, messages.at(-1).id],
    );
  });
}
export async function scanTick(pool: Pool, verify: Verify = verifyMembership) {
  const due = (
    await pool.query(`SELECT DISTINCT ON(r.character_key) r.character_key,r.character_name,
    ((now() AT TIME ZONE 'Europe/Budapest')-interval '3 hours')::date::text AS day
    FROM blacklist_reports r LEFT JOIN blacklist_checks c USING(character_key)
    WHERE r.voided_at IS NULL AND (c.scan_day IS NULL OR c.scan_day<((now() AT TIME ZONE 'Europe/Budapest')-interval '3 hours')::date)
    ORDER BY r.character_key,r.reported_at LIMIT 5`)
  ).rows;
  for (const row of due) {
    const result = await verify(row.character_name);
    await transaction(pool, async (c) => {
      await c.query(moderationLock);
      if (!(await blocked(c, row.character_key))) return;
      const old = (
        await c.query(
          "SELECT present,scan_day::text AS day FROM blacklist_checks WHERE character_key=$1",
          [row.character_key],
        )
      ).rows[0];
      if (old && old.day >= row.day) return;
      const present =
        result === "MATCH" || (!!old?.present && result !== "GUILD_MISMATCH");
      await c.query(
        `INSERT INTO blacklist_checks(character_key,scan_day,result,present) VALUES($1,$2,$3,$4)
        ON CONFLICT(character_key) DO UPDATE SET scan_day=excluded.scan_day,checked_at=now(),result=excluded.result,present=excluded.present`,
        [row.character_key, row.day, result, present],
      );
      if (present && !old?.present)
        await c.query(
          "INSERT INTO blacklist_warnings(character_key,character_name) VALUES($1,$2)",
          [row.character_key, row.character_name],
        );
    });
  }
}
export async function warningTick(pool: Pool, origin: string) {
  const channel = process.env.DISCORD_BLACKLIST_CHANNEL_ID;
  if (!channel || !process.env.DISCORD_BOT_TOKEN) return;
  const channelPath = "/channels/" + channel;
  if (
    (await discordJson(channelPath)).guild_id !== process.env.DISCORD_GUILD_ID
  )
    throw new Error("Blacklist guild mismatch");
  const job = (
    await pool.query(`SELECT w.* FROM blacklist_warnings w WHERE delivered_id IS NULL AND EXISTS
    (SELECT 1 FROM blacklist_reports r WHERE r.character_key=w.character_key AND voided_at IS NULL) ORDER BY id LIMIT 1`)
  ).rows[0];
  if (!job) return;
  const path = channelPath + "/messages",
    marker = "Guild presence #" + job.id;
  if (job.after_id === null) {
    const latest = await discordJson(path + "?limit=1");
    await pool.query(
      "UPDATE blacklist_warnings SET after_id=$2 WHERE id=$1 AND after_id IS NULL",
      [job.id, latest[0]?.id ?? "0"],
    );
    return;
  }
  const bot = await discordJson("/users/@me");
  let after = job.after_id,
    sent;
  do {
    const page = await discordJson(path + "?after=" + after + "&limit=100");
    sent = page.find(
      (m: any) => m.author.id === bot.id && m.content.split("\n")[0] === marker,
    );
    if (sent || page.length < 100) break;
    after = page.reduce(
      (a: string, m: any) => (BigInt(a) > BigInt(m.id) ? a : m.id),
      after,
    );
  } while (true);
  sent ??= await discordJson(path, {
    method: "POST",
    body: JSON.stringify({
      content: [
        marker,
        job.character_name,
        profileUrl(job.character_name),
        origin + "/blacklist.html?q=" + encodeURIComponent(job.character_name),
      ].join("\n"),
      nonce: "bl-" + job.id,
      enforce_nonce: true,
      allowed_mentions: { parse: [] },
    }),
  });
  await pool.query(
    "UPDATE blacklist_warnings SET delivered_id=$2 WHERE id=$1",
    [job.id, sent.id],
  );
}
