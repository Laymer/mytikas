import { $, api, node, message, date, bindForm } from "./common.js";
import { rosterNavigation } from "./roster.js";
import { link } from "./member.js";
async function render() {
  rosterNavigation(await api("/api/auth/me"));
  const q = new URLSearchParams(location.search).get("q") || "";
  const { reports, checkpoints } = await api(
      "/api/blacklist?q=" + encodeURIComponent(q),
    ),
    root = $("#workspace");
  const search = node("form"),
    label = node("label", "Character name"),
    input = node("input");
  input.name = "q";
  input.value = q;
  label.append(input);
  search.append(label, node("button", "Search"));
  root.replaceChildren(search);
  root.append(
    node(
      "p",
      checkpoints
        .map((c) => "Last imported channel message " + c.last_id)
        .join(" · ") || "Waiting for channel history.",
    ),
  );
  if (!reports.length) root.append(node("p", "No matching reports."));
  root.append(...reports.map(reportCard));
}
function reportCard(r) {
  const card = node("section", undefined, "card");
  card.append(
    node("h2", r.character_name),
    node("p", r.reason, "plain"),
    node("p", "Reported by " + r.reporter_id + " · " + date(r.reported_at)),
    link(
      "Source message",
      `https://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.message_id}`,
    ),
    node(
      "p",
      r.result
        ? "Armory · " + r.result + " · " + date(r.checked_at)
        : "Awaiting armory check",
    ),
  );
  if (r.application_id)
    card.append(
      link("Application · " + r.status, "/admin.html#" + r.application_id),
    );
  else card.append(node("p", "No matching application."));
  for (const w of r.warnings || [])
    card.append(
      node(
        "p",
        "Warning #" + w.id + " · " + (w.delivered ? "Delivered" : "Pending"),
      ),
    );
  if (r.voided_at)
    card.append(
      node(
        "p",
        "Voided by " +
          r.voided_by +
          " · " +
          date(r.voided_at) +
          " · " +
          r.correction,
      ),
    );
  else {
    const form = node("form"),
      label = node("label", "Correction reason"),
      reason = node("input"),
      submit = node("button", "Void mistaken report");
    reason.name = "reason";
    reason.required = true;
    reason.maxLength = 2000;
    submit.type = "submit";
    label.append(reason);
    form.append(label, submit);
    bindForm(form, async (data) => {
      await api("/api/blacklist/" + r.message_id + "/void", {
        reason: data.get("reason"),
      });
      await render();
    });
    card.append(form);
  }
  return card;
}
render().catch((e) => {
  $("#workspace").replaceChildren(link("Member Home", "/account.html"));
  message(e.message);
});
