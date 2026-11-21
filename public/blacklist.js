import { $, api, node, message, date, bindForm } from "./common.js";
import { rosterNavigation } from "./roster.js";
import { link } from "./member.js";

async function render() {
  rosterNavigation(await api("/api/auth/me"));
  const q = new URLSearchParams(location.search).get("q") || "";
  const { reports, checkpoints, bot } = await api("/api/blacklist?q=" + encodeURIComponent(q));

  const tools = node("div", undefined, "blacklist-tools");
  const search = node("form", undefined, "blacklist-search");
  search.setAttribute("role", "search");
  const label = node("label", "Character name");
  const input = node("input");
  input.type = "search";
  input.name = "q";
  input.maxLength = 200;
  input.value = q;
  label.append(input);
  search.append(label, node("button", "Search"));
  tools.append(botStatus(bot, checkpoints), search);

  const region = node("div", undefined, "report-scroll");
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", "Report history");
  region.tabIndex = 0;
  const table = node("table");
  table.createCaption().textContent = "Blacklist reports";
  const headers = table.createTHead().insertRow();
  for (const title of ["Character", "Report", "Guild checks", "Moderation"]) {
    const th = node("th", title);
    th.scope = "col";
    headers.append(th);
  }
  const body = table.createTBody();
  for (const report of reports) body.append(reportRow(report));
  if (!reports.length) {
    const empty = body.insertRow().insertCell();
    empty.colSpan = headers.cells.length;
    empty.className = "empty";
    empty.textContent = q ? "No matching reports." : "No reports imported.";
  }
  region.append(table);
  $("#workspace").replaceChildren(tools, region);
}

function botStatus(bot, checkpoints) {
  const descriptions = {
    "worker-unavailable": "Waiting for a current worker status report.",
    "missing-configuration":
      "Configure the " + new Intl.ListFormat("en").format(bot.missing) + " on the worker to read Discord history.",
    "awaiting-first-sync": "Waiting for the worker’s first successful Discord history check.",
    syncing: "Discord history checks are current.",
    stale: "Discord history checks are overdue. Review the worker and its channel permissions.",
  };
  const status = node("section", undefined, "blacklist-bot");
  const heading = node("h2", "Discord bot");
  heading.id = "bot-heading";
  status.setAttribute("aria-labelledby", heading.id);
  status.append(heading, node("p", descriptions[bot.state]));
  if (bot.lastSyncAt)
    status.append(node("p", "Last successful Discord history check · " + date(bot.lastSyncAt), "meta"));
  for (const checkpoint of checkpoints)
    status.append(node("p", "Last processed channel message " + checkpoint.last_id, "meta"));
  return status;
}

function reportRow(r) {
  const row = node("tr");
  const character = node("th");
  character.scope = "row";
  character.id = "report-" + r.message_id;
  character.tabIndex = -1;
  character.setAttribute("aria-label", r.character_name);
  character.append(
    node("span", r.character_name, "report-name"),
    r.application_id
      ? link("Application · " + r.status, "/admin.html#" + r.application_id)
      : node("span", "No matching application.", "meta"),
  );
  const report = node("td");
  report.append(
    node("p", r.reason, "plain"),
    node("p", "Reported by " + r.reporter_id + " · " + date(r.reported_at), "meta"),
    link("Source message", `https://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.message_id}`),
  );
  const checks = node("td");
  checks.append(node("p", r.result ? "Armory · " + r.result + " · " + date(r.checked_at) : "Awaiting armory check"));
  for (const w of r.warnings || [])
    checks.append(node("p", "Warning #" + w.id + " · " + (w.delivered ? "Delivered" : w.withdrawn ? "Withdrawn" : "Pending"), "meta"));

  const moderation = node("td");
  if (r.voided_at) {
    moderation.append(
      node("span", "Voided", "report-state"),
      node("p", r.correction, "plain"),
      node("p", "Voided by " + r.voided_by + " · " + date(r.voided_at), "meta"),
    );
  } else {
    moderation.append(node("span", "Active", "report-state"), correctionForm(r.message_id));
  }
  row.append(character, report, checks, moderation);
  return row;
}

function correctionForm(messageId) {
  const details = node("details");
  const form = node("form");
  const label = node("label", "Correction reason");
  const reason = node("input");
  reason.name = "reason";
  reason.required = true;
  reason.maxLength = 2000;
  const submit = node("button", "Void mistaken report");
  submit.type = "submit";
  label.append(reason);
  form.append(label, submit);
  bindForm(form, async (data) => {
    await api("/api/blacklist/" + messageId + "/void", { reason: data.get("reason") });
    await render();
    document.getElementById("report-" + messageId)?.focus();
  });
  details.append(node("summary", "Void report"), form);
  return details;
}

render().catch((e) => {
  $("#workspace").replaceChildren(link("Member Home", "/account.html"));
  message(e.message);
});
