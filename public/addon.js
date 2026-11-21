import { $, api, node, message, date } from "./common.js";
import { rosterNavigation } from "./roster.js";
import { link } from "./member.js";
async function render() {
  rosterNavigation(await api("/api/auth/me"));
  const releases = await api("/api/addon"),
    root = $("#workspace");
  root.replaceChildren();
  if (!releases.length)
    root.append(node("p", "Waiting for the first verified release."));
  for (const [index, r] of releases.entries()) {
    const card = node("section", undefined, "card");
    card.append(
      node("h2", (index === 0 ? "Current release · " : "Version ") + r.version),
      node("p", date(r.published_at), "meta"),
      node("p", r.notes, "plain"),
      link(
        "Download OlympusMytikas-" + r.version + ".zip",
        "/api/addon/" + r.version,
      ),
      node("p", "SHA-256 " + r.sha256, "checksum"),
    );
    root.append(card);
  }
}
render().catch((e) => {
  $("#workspace").replaceChildren(link("Member Home", "/account.html"));
  message(e.message);
});
