import { discordJson, parseReport } from "./blacklist.js";
import { createPool } from "./db.js";
const channel = process.env.DISCORD_BLACKLIST_CHANNEL_ID,
  guild = process.env.DISCORD_GUILD_ID;
if (!channel || !guild || !process.env.DISCORD_BOT_TOKEN)
  throw new Error("Configure bot, guild and channel first");
if ((await discordJson("/channels/" + channel)).guild_id !== guild)
  throw new Error("Channel guild mismatch");
const pool = createPool(process.env.DATABASE_URL!);
try {
  let after = "0",
    messages = 0,
    reports = 0;
  const keys = new Set<string>();
  for (;;) {
    const page = await discordJson(
      `/channels/${channel}/messages?after=${after}&limit=100`,
    );
    for (const m of page) {
      if (m.channel_id !== channel) throw new Error("Channel mismatch");
      if (BigInt(m.id) > BigInt(after)) after = m.id;
      messages++;
      const report = parseReport(m);
      if (report) {
        keys.add(report.key);
        reports++;
      }
    }
    if (page.length < 100) break;
  }
  const matched = await pool.query(
    "SELECT count(*)::int AS count FROM applications WHERE character_key=ANY($1::text[])",
    [[...keys]],
  );
  console.log(
    JSON.stringify({
      messages,
      reports,
      characters: keys.size,
      matchedApplications: matched.rows[0].count,
      lastId: after,
    }),
  );
} finally {
  await pool.end();
}
