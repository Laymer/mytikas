export type Config = {
  demo?: boolean;
  databaseUrl: string;
  sessionSecret: string;
  origin: string;
  port: number;
  secureCookies: boolean;
  discordWebhook?: string;
};
export function config(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!databaseUrl || !sessionSecret || sessionSecret.length < 32)
    throw new Error(
      "Set DATABASE_URL and a SESSION_SECRET of at least 32 characters. Run npm run secrets.",
    );
  const origin = process.env.APP_ORIGIN || "http://localhost:8080";
  const u = new URL(origin);
  if (!["http:", "https:"].includes(u.protocol) || u.origin !== origin)
    throw new Error(
      "APP_ORIGIN must be a plain HTTP(S) origin without a trailing slash.",
    );
  const demo = process.env.MYTIKAS_DEMO === "1";
  const discordWebhook = demo ? undefined : process.env.DISCORD_WEBHOOK_URL || undefined;
  if (discordWebhook) {
    const w = new URL(discordWebhook);
    if (
      w.protocol !== "https:" ||
      w.hostname !== "discord.com" ||
      !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(w.pathname) ||
      w.username ||
      w.password ||
      w.search ||
      w.hash
    )
      throw new Error(
        "Use an official https://discord.com/api/webhooks/id/token URL.",
      );
  }
  return {
    demo,
    databaseUrl,
    sessionSecret,
    origin,
    port: Number(process.env.PORT || 8080),
    secureCookies: u.protocol === "https:",
    discordWebhook,
  };
}
