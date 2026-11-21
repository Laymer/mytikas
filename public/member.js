import { node, api, action, date, message } from "./common.js";
export function link(label, url) {
  const el = node("a", label);
  el.href = url;
  return el;
}
export async function memberCards(root, me, render) {
  const discord = node("section", undefined, "card");
  discord.append(node("h2", "Guild Discord"));
  root.append(discord);
  const info = await api("/api/discord");
  if (info.link) {
    discord.append(
      node("p", info.link.username + " · " + info.membership),
      node("p", "Checked " + date(info.checkedAt), "meta"),
      action("Unlink Discord", async () => {
        await api("/api/discord/unlink", {});
        await render();
      }),
    );
  } else if (info.configured) {
    discord.append(
      action("Link Discord account", async () =>
        location.assign((await api("/api/discord/link", {})).url),
      ),
    );
  } else
    discord.append(
      node("p", "Discord account linking is temporarily unavailable."),
    );
  if (info.invite && info.membership !== "confirmed")
    discord.append(link("Join the guild Discord", info.invite));
  const result = new URLSearchParams(location.search).get("discord");
  const notices = {
    linked: "Discord account linked.",
    duplicate: "That identity or account already has a Discord link.",
    cancelled: "Discord linking cancelled.",
    unavailable: "Discord is temporarily unavailable.",
  };
  if (Object.hasOwn(notices, result))
    message(notices[result], result === "linked");
  if (me.canDownloadAddon || me.user.role === "ADMIN") {
    const releases = me.canDownloadAddon ? await api("/api/addon") : [];
    const card = node("section", undefined, "card");
    card.append(
      node("h2", "Mytikas Addon"),
      link(
        releases.length
          ? "Current release · " + releases[0].version
          : me.user.role === "ADMIN" ? "Manage releases" : "View releases",
        "/addon.html",
      ),
    );
    root.append(card);
  }
}
