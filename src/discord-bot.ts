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

// Discord returns an empty history without READ_MESSAGE_HISTORY and can redact
// message content without the privileged intent. Neither condition is an empty backlog.
export async function checkReportChannel(
  guild: string,
  channel: string,
  requireSend: boolean,
) {
  const snowflake = /^[1-9]\d{0,19}$/;
  if (!snowflake.test(guild) || !snowflake.test(channel))
    throw new Error("Use numeric Discord guild and channel IDs.");
  const channelPath = "/channels/" + channel;
  const [application, target] = await Promise.all([
    discordJson("/applications/@me"),
    discordJson(channelPath),
  ]);
  if (target.id !== channel || target.guild_id !== guild)
    throw new Error(
      "Discord reporting channel does not match the configured guild and channel.",
    );
  const messageContentFlags = (1 << 18) | (1 << 19);
  if (
    !Number.isInteger(application.flags) ||
    !(application.flags & messageContentFlags)
  )
    throw new Error(
      "Enable Message Content Intent for the Olympus Mytikas bot.",
    );
  const bot = application.bot ?? (await discordJson("/users/@me"));
  if (typeof bot.id !== "string" || !snowflake.test(bot.id))
    throw new Error("Discord did not identify the installed bot.");
  const resolved = await discordJson(
    channelPath + "/permissions/member/" + bot.id,
  );
  if (
    typeof resolved.permissions !== "string" ||
    !/^\d+$/.test(resolved.permissions)
  )
    throw new Error("Discord did not return the bot's channel permissions.");
  const permissions = BigInt(resolved.permissions);
  const required: [bigint, string][] = [
    [1n << 10n, "View Channel"],
    [1n << 16n, "Read Message History"],
  ];
  if (requireSend) required.push([1n << 11n, "Send Messages"]);
  const missing = required
    .filter(([flag]) => !(permissions & flag))
    .map(([, label]) => label);
  if (missing.length)
    throw new Error(
      "Grant the bot these permissions in the reporting channel: " +
        missing.join(", "),
    );
  return bot.id as string;
}
