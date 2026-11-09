import { chromium, firefox, webkit, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { harness, Client, PASS, mailToken } from "./harness.js";
const h = await harness(),
  engine = process.env.BROWSER || "chromium";
const coverage: any[] = [];
const collect = process.env.FRONTEND_COVERAGE === "1";
const browser = await { chromium, firefox, webkit }[
  engine as "chromium"
].launch();
try {
  const admin = new Client(h.cfg.origin),
    member = new Client(h.cfg.origin);
  await admin.login();
  await member.signup("Roster Summit");
  const id = (await member.application()).application.id;
  await admin.request(`/api/admin/applications/${id}/approve`, {});
  await admin.request(`/api/admin/applications/${id}/join`, {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (collect)
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const checkpoint = async () => {
    if (collect) {
      coverage.push(...(await page.coverage.stopJSCoverage()));
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
    }
  };
  await checkpoint();
  await page.goto(h.cfg.origin + "/account.html");
  await page.locator("#login-email").fill("admin@example.test");
  await page.locator("#login-password").fill(PASS);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Raid Roster", exact: true }),
  ).toBeVisible();
  await checkpoint();
  await page.getByRole("link", { name: "Admin panel" }).click();
  await page.getByText("Edit Raid Rosters", { exact: true }).click();
  const first = page.locator(".roster-cell").first();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Member", { exact: true }).selectOption(id);
  await page.getByLabel("Role", { exact: true }).selectOption("HEALER");
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await expect(first).toContainText("Roster Summit");
  await expect(first).toBeFocused();
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.locator("#message")).toHaveText("Roster saved.");
  // A second admin changes the server while this page retains its draft/revision.
  const roster = (await admin.request("/api/rosters")).data.rosters[0];
  roster.slots[1].role = "TANK";
  await admin.request("/api/admin/rosters/10", roster);
  await first.click();
  await page.getByLabel("Role", { exact: true }).selectOption("DPS");
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.locator("#message")).toContainText("draft is preserved");
  await expect(first).toContainText("DPS");
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .first()
    .click();
  await expect(first).toContainText("HEALER");
  await first.click();await page.keyboard.press("Escape");await expect(first).toBeFocused();
  await first.click();await page.getByRole("button",{name:"Cancel slot edit"}).click();await expect(first).toBeFocused();
  await first.click();await page.getByLabel("Role",{exact:true}).selectOption("DPS");await page.getByRole("button",{name:"Apply to draft"}).click();
  await page.getByLabel("Roster Summit",{exact:true}).selectOption("Mage");await page.getByRole("button",{name:"Save class"}).click();
  await expect(first).toContainText("Mage");await expect(first).toContainText("DPS");
  await page.getByRole("button",{name:"Refresh armory class",exact:true}).click();await expect(page.locator("#message")).toContainText("Class refresh queued");
  await page.getByLabel("Roster Summit",{exact:true}).selectOption("");await page.getByRole("button",{name:"Save class"}).click();await expect(first).toContainText("Unknown class");
  await page.getByRole("button",{name:"Cancel",exact:true}).first().click();await expect(first).toContainText("HEALER");
  await checkpoint();
  await page.getByRole("link", { name: "Raid Roster", exact: true }).click();
  await expect(page.locator(".roster-cell")).toHaveCount(70);
  await expect(page.locator("button.roster-cell")).toHaveCount(0);
  assert.ok(
    await page
      .locator(".roster-scroll")
      .first()
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await checkpoint();
  await page.goto(h.cfg.origin + "/account.html");
  await page.getByRole("button", { name: "Sign out" }).click();
  await h.pool.query(
    "UPDATE email_limits SET last_at=now()-interval '61 seconds'",
  );
  await checkpoint();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.getByLabel("Account email").fill("roster.summit@example.test");
  await page.getByRole("button", { name: "Request reset email" }).click();
  await expect(page.locator("#message")).toContainText(
    "If the address is eligible",
  );
  const token = await mailToken(h.pool, "roster.summit@example.test", "reset");
  await checkpoint();
  await page.goto(h.cfg.origin + "/email.html#reset=" + token);
  await expect(
    page.getByRole("button", { name: "Change password" }),
  ).toBeVisible();
  await expect(page).toHaveURL(h.cfg.origin + "/email.html");
  const changed = "Browser-reset-password-123";
  await page.getByLabel("New password", { exact: true }).fill(changed);
  await page.getByLabel("Confirm new password").fill(changed);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.locator("#message")).toContainText("Password changed");
  await checkpoint();
  await page.getByRole("link", { name: "Return to sign in" }).click();
  await page.locator("#login-email").fill("roster.summit@example.test");
  await page.locator("#login-password").fill(changed);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Raid Roster", exact: true }),
  ).toBeVisible();
  await checkpoint();
  await page.getByRole("link", { name: "Raid Roster", exact: true }).click();
  await expect(page.locator("button.roster-cell")).toHaveCount(0);
  // Removal revokes read-only access on the next page request.
  await admin.request(`/api/admin/applications/${id}/remove`, {
    note: "Browser access revocation",
  });
  await checkpoint();
  await page.goto(h.cfg.origin + "/roster.html");
  await expect(page.locator("#message")).toContainText(
    "confirmed guild membership",
  );
  await checkpoint();
  await page.goto(h.cfg.origin + "/account.html");
  await page.getByRole("button", { name: "Sign out" }).click();
  await checkpoint();
  await page.goto(h.cfg.origin + "/roster.html");
  await expect(page.locator("#message")).toContainText("Sign in");
  // Pending-email screens preserve the application while replacing delivery links.
  const pending = new Client(h.cfg.origin);
  await pending.init();
  const rules = (await pending.request("/api/rules")).data;
  await pending.request("/api/auth/register", {
    email: "browser.pending@example.test",
    password: PASS,
    characterName: "Pending Browser",
    motivation: "Browser confirmation",
    rulesId: rules.id,
    acceptRules: true,
  });
  await h.pool.query("DELETE FROM email_limits");
  await checkpoint();
  await page.goto(h.cfg.origin + "/email.html");
  await page
    .getByLabel("Signup email", { exact: true })
    .fill("browser.pending@example.test");
  await page.getByRole("button", { name: "Resend verification" }).click();
  await expect(page.locator("#message")).toContainText(
    "If the address is eligible",
  );
  const oldToken = await mailToken(h.pool, "browser.pending@example.test");
  await h.pool.query("DELETE FROM email_limits");
  await page.getByLabel("Original email").fill("browser.pending@example.test");
  await page.getByLabel("Signup password").fill(PASS);
  await page
    .getByLabel("Correct email", { exact: true })
    .fill("correct.browser@example.test");
  await page
    .getByRole("button", { name: "Correct email", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await h.pool.query(
            "SELECT count(*) FROM users WHERE email='correct.browser@example.test'",
          )
        ).rows[0].count,
    )
    .toBe("1");
  await checkpoint();
  await page.goto(h.cfg.origin + "/email.html#verify=" + oldToken);
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page.locator("#message")).toContainText("invalid or expired");
  const newToken = await mailToken(h.pool, "correct.browser@example.test");
  await checkpoint();
  await page.goto(h.cfg.origin + "/email.html#verify=" + newToken);
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page.locator("#message")).toContainText("Email verified");
  if (collect) {
    await mkdir("coverage/raw/frontend", { recursive: true });
    await writeFile(
      "coverage/raw/frontend/roster.json",
      JSON.stringify([...coverage, ...(await page.coverage.stopJSCoverage())]),
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "Browser: keyboard roster editing, conflict preservation, cancel, mobile scrolling, read-only membership and password reset passed.",
  );
} finally {
  await browser.close();
  await h.stop();
}
