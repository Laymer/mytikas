import {
  $,
  node,
  api,
  message,
  bindForm,
  action,
  rulesView,
  applicationFields,
  submissionBody,
  applicationView,
} from "./common.js";
async function render() {
  const { user } = await api("/api/auth/me"),
    root = $("#workspace");
  root.replaceChildren();
  if (!user) {
    const rules = await api("/api/rules"),
      cols = node("div", undefined, "columns"),
      login = node("section", undefined, "card"),
      signup = node("section", undefined, "card");
    login.innerHTML =
      '<h2>Continue your ascent</h2><p>Sign in to see your application.</p><form id="login"><label for="login-email">Email</label><input id="login-email" name="email" type="email" required autocomplete="username"><label for="login-password">Password</label><input id="login-password" name="password" type="password" required maxlength="128" autocomplete="current-password"><button type="submit">Sign in</button></form><p class="meta">This local prototype does not send password reset emails.</p>';
    signup.innerHTML =
      '<h2>Apply to Mytikas</h2><p>Create your account and submit your application together.</p><form id="signup"><label for="signup-email">Email</label><input id="signup-email" name="email" type="email" required maxlength="254" autocomplete="username"><label for="signup-password">Password</label><input id="signup-password" name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" aria-describedby="password-hint"><p id="password-hint" class="meta">12–128 characters.</p></form>';
    const form = $("#signup", signup);
    form.append(applicationFields(rules));
    const submit = node("button", "Create account & apply");
    submit.type = "submit";
    form.append(submit);
    bindForm($("#login", login), async (data) => {
      await api("/api/auth/login", {
        email: data.get("email"),
        password: data.get("password"),
      });
      await render();
    });
    bindForm(form, async (data) => {
      await api("/api/auth/register", {
        email: data.get("email"),
        password: data.get("password"),
        ...submissionBody(data, rules),
      });
      await render();
      message("Your application has been submitted.", true);
    });
    cols.append(login, signup);
    root.append(cols);
    return;
  }
  const bar = node("div", undefined, "toolbar");
  bar.append(node("span", `${user.email} · ${user.role}`, "meta"));
  if (["ADMIN", "MODERATOR"].includes(user.role)) {
    const link = node("a", "Admin panel ↗", "button");
    link.href = "/admin.html";
    bar.append(link);
  }
  bar.append(
    action("Sign out", async () => {
      await api("/api/auth/logout", {});
      await render();
    }),
  );
  root.append(bar);
  const data = await api("/api/application");
  if (!data.application) {
    const card = node("section", undefined, "card");
    card.append(
      node("h2", "Your staff account"),
      node(
        "p",
        "This account was created locally without a guild application. Use the admin panel to manage recruitment.",
      ),
    );
    root.append(card);
    return;
  }
  const view = applicationView(data);
  root.append(view);
  if (data.application.status === "APPROVED")
    view.append(
      action("Check now", async () => {
        await api("/api/application/check", {});
        await render();
      }),
    );
  if (data.application.status === "REOPENED") {
    const rules = await api("/api/rules"),
      card = node("section", undefined, "card"),
      form = node("form");
    card.append(node("h2", "Revise your application"));
    form.append(applicationFields(rules, data.submissions[0]));
    const submit = node("button", "Resubmit application");
    submit.type = "submit";
    form.append(submit);
    card.append(form);
    root.append(card);
    bindForm(form, async (data) => {
      await api("/api/application", submissionBody(data, rules));
      await render();
      message("Your revised application has been submitted.", true);
    });
  }
  const rules = node("details");
  rules.append(
    node("summary", "Current guild rules"),
    rulesView(await api("/api/rules")),
  );
  root.append(rules);
}
render().catch((e) => {
  message(e.message);
  $("#workspace").replaceChildren();
});
