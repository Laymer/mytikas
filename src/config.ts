export type Config = {
  demo?: boolean;
  deploymentProfile?: "local" | "public" | "cloud" | "demo";
  publicSiteOrigin?: string;
  ingressMode?: "none" | "cloudflare-loopback" | "proxy-loopback";
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
  const deploymentProfile = process.env.DEPLOYMENT_PROFILE || (demo ? "demo" : "local");
  if (!["local", "public", "cloud", "demo"].includes(deploymentProfile))
    throw new Error("Invalid DEPLOYMENT_PROFILE.");
  if ((deploymentProfile === "demo") !== demo)
    throw new Error("Demo mode requires the demo deployment profile exclusively.");
  if (["public", "cloud"].includes(deploymentProfile) && process.env.DEMO_PASSWORD)
    throw new Error("Public deployments must not contain demo credentials.");
  const publicSiteOrigin = process.env.PUBLIC_SITE_ORIGIN || origin;
  const publicUrl = new URL(publicSiteOrigin);
  if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.origin !== publicSiteOrigin)
    throw new Error("PUBLIC_SITE_ORIGIN must be a plain HTTP(S) origin.");
  const ingressMode = process.env.INGRESS_MODE || "none";
  if (!["none", "cloudflare-loopback", "proxy-loopback"].includes(ingressMode))
    throw new Error("Invalid INGRESS_MODE.");
  if (ingressMode === "cloudflare-loopback" && deploymentProfile !== "public")
    throw new Error("Cloudflare ingress requires the public profile.");
  if (["local", "demo"].includes(deploymentProfile) && ingressMode !== "none")
    throw new Error("Local and demo profiles must not trust ingress headers.");
  if (["public", "cloud"].includes(deploymentProfile) &&
      (u.protocol !== "https:" || publicUrl.protocol !== "https:" || ingressMode === "none"))
    throw new Error("Public and cloud profiles require HTTPS origins and explicit ingress.");
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535.");
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
    deploymentProfile: deploymentProfile as Config["deploymentProfile"],
    publicSiteOrigin,
    ingressMode: ingressMode as Config["ingressMode"],
    databaseUrl,
    sessionSecret,
    origin,
    port,
    secureCookies: u.protocol === "https:",
    discordWebhook,
  };
}
