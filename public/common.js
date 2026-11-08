let csrfToken;
export const $ = (s, root = document) => root.querySelector(s);
export function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
export function message(text, success = false) {
  const m = $("#message");
  m.textContent = text;
  m.hidden = !text;
  m.className = success ? "success" : "";
  if (text) m.focus();
}
export async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken || "",
          },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "The request failed.");
  if (data.csrfToken) csrfToken = data.csrfToken;
  return data;
}
export const date = (value) =>
  value ? new Date(value).toLocaleString() : "Not checked yet";
export function bindForm(form, handler) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = $("button[type=submit]", form);
    b.disabled = true;
    message("");
    try {
      await handler(new FormData(form));
    } catch (error) {
      message(error.message);
    } finally {
      b.disabled = false;
    }
  });
}
export function action(label, handler) {
  const b = node("button", label);
  b.type = "button";
  b.addEventListener("click", async () => {
    b.disabled = true;
    message("");
    try {
      await handler();
    } catch (e) {
      message(e.message);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
export function rulesView(rules) {
  const box = node("div");
  box.append(
    node(
      "p",
      `Rules version ${rules.id}${rules.prototype ? " · PROTOTYPE DRAFT" : ""}`,
      "meta",
    ),
    node("div", rules.content, "rules"),
  );
  return box;
}
export function applicationFields(rules, submission) {
  const box = node("div");
  box.innerHTML = `<label for="character">Full in-game name, including surname</label><input id="character" name="characterName" required maxlength="49" placeholder="Name Surname" autocomplete="off" aria-describedby="character-hint"><p id="character-hint" class="meta">US PvP · one main character per account. Use 2–24 letters for each name.</p><label for="motivation">Why do you want to join?</label><textarea id="motivation" name="motivation" required rows="4" aria-describedby="counter"></textarea><p id="counter" class="counter">0 / 300 characters</p><div id="current-rules"></div><label class="check"><input type="checkbox" name="acceptRules" required><span>I have read and accept the current guild rules.</span></label>`;
  $("#current-rules", box).append(rulesView(rules));
  $("#character", box).value = submission?.character_name || "";
  const motivation = $("#motivation", box);
  motivation.value = submission?.motivation || "";
  const update = () => {
    const count = [...motivation.value].length;
    $("#counter", box).textContent = `${count} / 300 characters`;
    motivation.setCustomValidity(
      count > 300 ? "Keep your motivation within 300 characters." : "",
    );
  };
  motivation.addEventListener("input", update);
  update();
  return box;
}
export function submissionBody(data, rules) {
  return {
    characterName: data.get("characterName"),
    motivation: data.get("motivation"),
    acceptRules: data.get("acceptRules") === "on",
    rulesId: rules.id,
  };
}
const descriptions = {
  SUBMITTED:
    "Your application is with the guild staff. You can view it here while it is reviewed.",
  APPROVED:
    "Approved — awaiting your in-game invitation and joining. Staff will invite you in WoW. After joining, check your membership below.",
  REJECTED:
    "Your application was declined. Staff can reopen it if corrections are needed.",
  REOPENED:
    "Staff have reopened your application. Revise it below and accept the current rules to resubmit.",
  JOINED: "Welcome to Olympus Mytikas. Your membership is confirmed.",
};
export function applicationView(data) {
  const { application: a, submissions, events } = data,
    box = node("section", undefined, "card");
  box.append(
    node("span", a.status, "tag"),
    node("h2", a.character_name),
    node("p", descriptions[a.status]),
    node("p", `Application ${a.id}`, "meta"),
  );
  if (a.joined_via)
    box.append(
      node(
        "p",
        `Joining confirmed ${a.joined_via === "MANUAL" ? "manually by staff" : "through the armory"}.`,
        "meta",
      ),
    );
  if (a.last_check_at)
    box.append(
      node(
        "p",
        `Latest membership check: ${date(a.last_check_at)} · ${(a.check_result || "").replaceAll("_", " ").toLowerCase()}`,
        "meta",
      ),
    );
  if (a.status === "APPROVED")
    box.append(
      node(
        "p",
        "Automatic checks run every 15 minutes. Check now is available once per minute. If the armory is unavailable, staff can confirm your membership manually.",
        "meta",
      ),
    );
  const history = node("details");
  history.append(node("summary", `Submission history (${submissions.length})`));
  for (const s of submissions) {
    const card = node("div", undefined, "card");
    card.append(
      node("h3", `Revision ${s.revision} · ${s.character_name}`),
      node("p", s.motivation, "plain"),
      node(
        "p",
        `Accepted ${date(s.accepted_at)} · rules version ${s.rules_id}`,
        "meta",
      ),
      node("div", s.rules_content, "rules"),
    );
    history.append(card);
  }
  box.append(history, node("h3", "Application timeline"));
  const list = node("ol", undefined, "history");
  for (const e of events) {
    const li = node("li");
    li.append(
      node(
        "div",
        `${e.to_status} · ${e.actor_email || e.actor_label} · ${e.method.toLowerCase()}`,
      ),
      node("div", date(e.created_at), "meta"),
    );
    if (e.note) li.append(node("p", e.note, "plain"));
    list.append(li);
  }
  box.append(list);
  return box;
}
