import { checkReportChannel, discordJson } from "./discord-bot.js";
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
  if (!first || !last || !reason || m.content.includes("```")) return;
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
    await c.query(
      "UPDATE blacklist_warnings SET withdrawn_at=now() WHERE character_key=$1 AND delivered_id IS NULL AND withdrawn_at IS NULL",
      [report.character_key],
    );
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
export async function historyPage(guild: string, channel: string, after: string) {
  const page = await discordJson(
    `/channels/${channel}/messages?limit=100&after=${after}`,
  );
  return orderedMessages(page, guild, channel, after, 100);
}
function orderedMessages(page: unknown, guild: string, channel: string, after: string, limit: number) {
  if (!Array.isArray(page) || page.length > limit)
    throw new Error("Invalid Discord history page");
  const cursor = BigInt(after);
  const ids = new Set<string>();
  for (const message of page) {
    if (message?.channel_id !== channel ||
        (message.guild_id !== undefined && message.guild_id !== guild))
      throw new Error("Discord history source mismatch");
    const id = message.id;
    if (typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id) ||
        BigInt(id) <= cursor || ids.has(id))
      throw new Error("Invalid Discord history cursor");
    ids.add(id);
  }
  return page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}
export async function reportsTick(pool: Pool) {
  const guild = process.env.DISCORD_GUILD_ID,
    channel = process.env.DISCORD_BLACKLIST_CHANNEL_ID;
  if (!guild || !channel || !process.env.DISCORD_BOT_TOKEN) return;
  await checkReportChannel(guild, channel, false);
  const cursor =
    (
      await pool.query(
        "SELECT last_id FROM blacklist_checkpoint WHERE channel_id=$1",
        [channel],
      )
    ).rows[0]?.last_id ?? "0";
  const messages = await historyPage(guild, channel, cursor);
  if (!messages.length) return;
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
      // A corrected, undelivered warning can be replaced only after a fresh positive check.
      if (result === "MATCH")
        await c.query(
          `INSERT INTO blacklist_warnings(character_key,character_name) SELECT $1,$2
          WHERE NOT $3::boolean OR (SELECT withdrawn_at IS NOT NULL AND delivered_id IS NULL AND after_id IS NULL
            FROM blacklist_warnings WHERE character_key=$1 ORDER BY id DESC LIMIT 1)`,
          [row.character_key, row.character_name, !!old?.present],
        );
    });
  }
}
export async function warningTick(pool: Pool, origin: string) {
  const channel = process.env.DISCORD_BLACKLIST_CHANNEL_ID, guild = process.env.DISCORD_GUILD_ID;
  if (!guild || !channel || !process.env.DISCORD_BOT_TOKEN) return;
  await transaction(pool, async (c) => {
    const lock = await c.query(
      "SELECT pg_try_advisory_xact_lock(4) AS acquired",
    );
    if (!lock.rows[0].acquired) return;
    await deliverWarning(c, guild, channel, origin);
  });
}
async function deliverWarning(c: PoolClient, guild: string, channel: string, origin: string) {
  const channelPath = "/channels/" + channel;
  const botId = await checkReportChannel(guild, channel, true);
  const job = (
    await c.query(`SELECT w.* FROM blacklist_warnings w WHERE delivered_id IS NULL AND
    ((withdrawn_at IS NOT NULL AND after_id IS NOT NULL) OR (withdrawn_at IS NULL AND EXISTS
    (SELECT 1 FROM blacklist_reports r WHERE r.character_key=w.character_key AND voided_at IS NULL)))
    ORDER BY id LIMIT 1`)
  ).rows[0];
  if (!job) return;
  const path = channelPath + "/messages",
    marker = "Guild presence #" + job.id;
  if (job.after_id === null) {
    const latest = orderedMessages(await discordJson(path + "?limit=1"), guild, channel, "0", 1);
    await c.query(
      "UPDATE blacklist_warnings SET after_id=$2 WHERE id=$1 AND after_id IS NULL AND withdrawn_at IS NULL",
      [job.id, latest[0]?.id ?? "0"],
    );
    return;
  }
  const page = await historyPage(guild, channel, job.after_id);
  if (page.some(m => typeof m.author?.id !== "string" || typeof m.content !== "string"))
    throw new Error("Invalid Discord warning history");
  const matches = (m: any) =>
    m.author?.id === botId && typeof m.content === "string" && m.content.split("\n")[0] === marker;
  let sent = page.find(matches);
  if (!sent && page.length === 100) {
    // Persist one verified page per transaction so a restart resumes from its last message.
    await c.query(
      "UPDATE blacklist_warnings SET after_id=$2 WHERE id=$1",
      [job.id, page.at(-1).id],
    );
    return;
  }
  if (!sent) {
    // A correction can finish during history reads. Lock only for the final decision and send.
    const current = await c.query("SELECT withdrawn_at FROM blacklist_warnings WHERE id=$1 FOR UPDATE", [job.id]);
    if (current.rows[0].withdrawn_at) {
      await c.query("UPDATE blacklist_warnings SET after_id=NULL WHERE id=$1", [job.id]);
      return;
    }
    const receipt = await discordJson(path, {
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
    [sent] = orderedMessages([receipt], guild, channel, job.after_id, 1);
    if (!matches(sent)) throw new Error("Invalid Discord warning receipt");
  }
  await c.query("UPDATE blacklist_warnings SET delivered_id=$2 WHERE id=$1", [
    job.id,
    sent.id,
  ]);
}
