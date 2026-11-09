import {
  $,
  node,
  api,
  message,
  date,
  bindForm,
  action,
  rulesView,
  applicationView,
  reviewDestination,
} from "./common.js";
let user,
  offset = 0,
  filter = "PENDING";
async function render() {
  ({ user } = await api("/api/auth/me"));
  const root = $("#workspace");
  root.replaceChildren();
  if (!user || !["ADMIN", "MODERATOR"].includes(user.role)) {
    root.append(
      node("p", "Sign in with a staff account to open the admin panel."),
    );
    const a = node("a", "Go to your account", "button");
    const destination = reviewDestination(location.pathname + location.hash);
    a.href = "/account.html" + (destination ? `?returnTo=${encodeURIComponent(destination)}` : "");
    root.append(a);
    return;
  }
  const bar = node("div", undefined, "toolbar");
  bar.append(
    node("span", `${user.email} · ${user.role}`, "meta"),
    action("Refresh queue", async () => {
      await loadQueue();
      if (location.hash) await loadDetail(location.hash.slice(1));
    }),
  );
  root.append(bar);
  const columns = node("div", undefined, "columns"),
    queue = node("section", undefined, "card"),
    detail = node("div");
  detail.id = "detail";
  queue.innerHTML =
    '<h2>Applications</h2><label for="status-filter">Show applications</label><select id="status-filter"><option value="PENDING">Pending queue</option><option value="ALL">All applications</option><option>SUBMITTED</option><option>APPROVED</option><option>REJECTED</option><option>REOPENED</option><option>JOINED</option></select><p id="notifications" class="meta"></p><div id="queue"></div><div id="paging" class="toolbar"></div>';
  columns.append(queue, detail);
  root.append(columns);
  $("#status-filter").value = filter;
  $("#status-filter").addEventListener("change", () => {
    filter = $("#status-filter").value;
    offset = 0;
    loadQueue().catch((e) => message(e.message));
  });
  if (user.role === "ADMIN") await adminTools(root);
  await loadQueue();
  if (location.hash) await loadDetail(location.hash.slice(1));
  else
    detail.append(
      node(
        "p",
        "Select an application to review its submission and history.",
        "empty",
      ),
    );
}
async function loadQueue() {
  const data = await api(
    `/api/admin/applications?status=${filter}&offset=${offset}`,
  );
  $("#notifications").textContent =
    `Discord notifications: ${data.notificationsEnabled ? "enabled" : "disabled (no webhook configured)"}`;
  const list = $("#queue");
  list.replaceChildren();
  if (!data.applications.length)
    list.append(node("p", "No applications in this view.", "empty"));
  for (const a of data.applications) {
    const link = node("a", undefined, "app-row");
    link.href = `#${a.id}`;
    link.append(
      node("strong", a.character_name),
      node("span", a.status, "tag"),
      node("span", `Revision ${a.revision}`, "meta"),
      node("div", date(a.updated_at), "meta"),
    );
    link.addEventListener("click", (e) => {
      e.preventDefault();
      history.replaceState(null, "", `#${a.id}`);
      loadDetail(a.id).catch((e) => message(e.message));
    });
    list.append(link);
  }
  const paging = $("#paging");
  paging.replaceChildren();
  if (offset > 0)
    paging.append(
      action("Previous", async () => {
        offset = Math.max(0, offset - 50);
        await loadQueue();
      }),
    );
  if (data.hasMore)
    paging.append(
      action("Next", async () => {
        offset += 50;
        await loadQueue();
      }),
    );
}
async function loadDetail(id) {
  const data = await api(`/api/admin/applications/${encodeURIComponent(id)}`),
    root = $("#detail"),
    view = applicationView(data);
  root.replaceChildren(view);
  view.append(
    node("p", `Account: ${data.account.email}`, "meta"),
    node(
      "p",
      "Verify character ownership during review or the in-game invitation. Armory matching confirms membership only.",
      "meta",
    ),
  );
  const label = node("label", "Review note (visible to applicant)");
  label.htmlFor = "review-note";
  const note = node("textarea");
  note.id = "review-note";
  note.maxLength = 1000;
  note.rows = 2;
  view.append(label, note);
  const actions = node("div", undefined, "actions");
  const available = {
    SUBMITTED: [
      ["approve", "Approve"],
      ["reject", "Reject"],
    ],
    APPROVED: [
      ["check", "Check now"],
      ["join", "Mark as joined"],
      ["reject", "Reject"],
    ],
    REJECTED: [["reopen", "Reopen"]],
    REOPENED: [],
    JOINED: [],
  };
  for (const [key, title] of available[data.application.status])
    actions.append(
      action(title, async () => {
        await api(`/api/admin/applications/${id}/${key}`, { note: note.value });
        await loadDetail(id);
        await loadQueue();
        message("Application updated.", true);
      }),
    );
  view.append(actions);
  const deliveries = node("details");
  deliveries.append(node("summary", "Submission notifications"));
  for (const j of data.notifications)
    deliveries.append(
      node(
        "p",
        `${j.status} · ${j.attempts} attempt(s)${j.last_error ? " · " + j.last_error : ""}`,
        "meta",
      ),
    );
  view.append(deliveries);
}
async function adminTools(root) {
  const tools = node("details");
  tools.append(node("summary", "Admin tools · rules and account roles"));
  const columns = node("div", undefined, "columns"),
    rules = node("section", undefined, "card"),
    users = node("section", undefined, "card");
  const current = await api("/api/rules");
  rules.innerHTML =
    '<h2>Publish guild rules</h2><p>Publishing creates a new version. Existing submissions retain their accepted rules.</p><div id="published-rules"></div><form id="rules-form"><label for="rules-content">New rules (plain text)</label><textarea id="rules-content" name="content" required maxlength="20000" rows="12"></textarea><button type="submit">Publish new version</button></form>';
  $("#published-rules", rules).append(rulesView(current));
  $("#rules-content", rules).value = current.content;
  bindForm($("#rules-form", rules), async (form) => {
    const updated = await api("/api/admin/rules", {
      content: form.get("content"),
    });
    $("#published-rules").replaceChildren(rulesView(updated));
    message(`Rules version ${updated.id} published.`, true);
  });
  users.innerHTML =
    '<h2>Account roles</h2><form id="user-search"><label for="user-query">Find accounts by email</label><input id="user-query" name="q" type="search"><button type="submit">Find accounts</button></form><p class="meta">Showing up to 50 matches. The last admin cannot be demoted.</p><div id="users"></div>';
  bindForm($("#user-search", users), async (data) => {
    const result = await api(
        `/api/admin/users?q=${encodeURIComponent(data.get("q"))}`,
      ),
      list = $("#users");
    list.replaceChildren();
    if (!result.users.length) list.append(node("p", "No matching accounts."));
    for (const u of result.users) {
      const row = node("div", undefined, "user-row"),
        form = node("form"),
        label = node("label", u.email),
        select = node("select");
      select.id = `role-${u.id}`;
      select.name = "role";
      label.htmlFor = select.id;
      for (const role of ["USER", "MODERATOR", "ADMIN"]) {
        const opt = node("option", role);
        opt.value = role;
        select.append(opt);
      }
      select.value = u.role;
      const button = node("button", "Save role");
      button.type = "submit";
      form.append(label, select, button);
      row.append(form);
      list.append(row);
      bindForm(form, async (data) => {
        await api(`/api/admin/users/${u.id}/role`, { role: data.get("role") });
        message("Account role updated.", true);
        if (u.id === user.id) await render();
      });
    }
  });
  columns.append(rules, users);
  tools.append(columns);
  root.append(tools);
}
render().catch((e) => {
  message(e.message);
});
