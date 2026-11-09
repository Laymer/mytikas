import { $, node, api, bindForm, message } from "./common.js";
async function renderEmail() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const verification = fragment.get("verify"),
    reset = fragment.get("reset");
  history.replaceState(null, "", location.pathname + location.search);
  await api("/api/auth/me");
  const root = $("#workspace"),
    mode = verification
      ? "verify"
      : reset
        ? "reset"
        : new URLSearchParams(location.search).get("mode") || "pending";
  root.replaceChildren();
  function form(title, fields, button, handler) {
    const card = node("section", undefined, "card"),
      f = node("form");
    card.append(node("h2", title));
    for (const [name, label, type, value] of fields) {
      const l = node("label", label),
        input = node("input");
      l.htmlFor = `email-${root.children.length}-${name}`;
      input.id = l.htmlFor;
      input.name = name;
      input.type = type;
      input.required = true;
      input.value = value || "";
      if (type === "password") {
        input.maxLength = 128;
        input.autocomplete =
          mode === "reset" ? "new-password" : "current-password";
        if (mode === "reset") input.minLength = 12;
      }
      f.append(l, input);
    }
    const b = node("button", button);
    b.type = "submit";
    f.append(b);
    card.append(f);
    root.append(card);
    bindForm(f, handler);
  }
  const address = sessionStorage.getItem("pending-email") || "";
  const done = async (path, body) => {
    const result = await api(path, body);
    message(result.message, true);
  };
  if (mode === "verify")
    form("Confirm your email", [], "Verify email", async () => {
      await done("/api/auth/verify-email", { token: verification });
      root
        .querySelector("section")
        .replaceChildren(node("p", "Email verified. You can now sign in."));
    });
  else if (mode === "reset")
    form(
      "Choose a new password",
      [
        ["password", "New password", "password"],
        ["confirmPassword", "Confirm new password", "password"],
      ],
      "Change password",
      async (data) => {
        await done("/api/auth/reset-password", {
          token: reset,
          ...Object.fromEntries(data),
        });
        root
          .querySelector("section")
          .replaceChildren(
            node("p", "Password changed. Sign in with your new password."),
          );
      },
    );
  else if (mode === "forgot")
    form(
      "Forgot password?",
      [["email", "Account email", "email"]],
      "Request reset email",
      (data) => done("/api/auth/forgot-password", Object.fromEntries(data)),
    );
  else {
    root.append(
      node(
        "p",
        "Check your inbox to confirm your email. Your application will enter staff review after verification. Links expire after 24 hours.",
      ),
    );
    form(
      "Resend confirmation",
      [["email", "Signup email", "email", address]],
      "Resend verification",
      (data) => done("/api/auth/resend-verification", Object.fromEntries(data)),
    );
    form(
      "Correct your signup email",
      [
        ["email", "Original email", "email", address],
        ["password", "Signup password", "password"],
        ["newEmail", "Correct email", "email"],
      ],
      "Correct email",
      async (data) => {
        await done("/api/auth/correct-pending-email", Object.fromEntries(data));
        sessionStorage.setItem("pending-email", data.get("newEmail"));
      },
    );
  }
  const link = node("a", "Return to sign in", "button");
  link.href = "/account.html";
  root.append(link);
}
const render = () => renderEmail().catch((e) => message(e.message));
window.addEventListener("hashchange", render);
render();
