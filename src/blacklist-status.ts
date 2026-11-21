import type { Pool } from "./db.js";

// Each worker heartbeat records which configuration checks passed at that instant.
// Only these fixed names are persisted; the credentials and Discord IDs stay private.
const configuration = "blacklist-configuration";
const settings = [
  ["bot token", "DISCORD_BOT_TOKEN"],
  ["guild ID", "DISCORD_GUILD_ID"],
  ["blacklist channel ID", "DISCORD_BLACKLIST_CHANNEL_ID"],
] as const;
const polled = configuration + "/polled";

export async function reportBlacklistConfiguration(
  pool: Pool,
  hasPolled: boolean,
  env = process.env,
) {
  const checks = [configuration];
  for (const [label, key] of settings) {
    if (env[key]) checks.push(configuration + "/" + label);
  }
  if (hasPolled) checks.push(polled);
  await pool.query(
    `INSERT INTO integration_health(lane,succeeded_at)
     SELECT unnest($1::text[]),statement_timestamp()
     ON CONFLICT(lane) DO UPDATE SET succeeded_at=excluded.succeeded_at
       WHERE integration_health.succeeded_at < excluded.succeeded_at`,
    [checks],
  );
}

export async function blacklistBotStatus(pool: Pool) {
  const result = await pool.query(
    `
    SELECT h.lane, h.succeeded_at,
      h.succeeded_at=c.succeeded_at AS current_report,
      h.succeeded_at>now()-interval '45 seconds' AS recent_heartbeat,
      h.succeeded_at>now()-interval '15 minutes' AS recent_sync
    FROM integration_health h LEFT JOIN integration_health c ON c.lane=$1
    WHERE h.lane=$1 OR h.lane LIKE $1||'/%' OR h.lane='blacklist-history'`,
    [configuration],
  );
  const lanes = new Map(result.rows.map((row) => [row.lane, row]));
  const config = lanes.get(configuration);
  const history = lanes.get("blacklist-history");
  const missing = settings
    .filter(
      ([label]) => !lanes.get(configuration + "/" + label)?.current_report,
    )
    .map(([label]) => label);
  const lastSyncAt = history?.succeeded_at ?? null;
  if (!config?.recent_heartbeat)
    return { state: "worker-unavailable", missing: [], lastSyncAt };
  if (missing.length)
    return { state: "missing-configuration", missing, lastSyncAt };
  if (!lanes.get(polled)?.current_report || !history)
    return { state: "awaiting-first-sync", missing: [], lastSyncAt };
  return {
    state: history.recent_sync ? "syncing" : "stale",
    missing: [],
    lastSyncAt,
  };
}
