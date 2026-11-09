import { chromium, firefox, webkit, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { harness, PASS, Client } from "./harness.js";
const engine = process.env.BROWSER || "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw new Error("Unsupported BROWSER");
const collectCoverage = process.env.FRONTEND_COVERAGE === "1";
if (collectCoverage && engine !== "chromium") throw new Error("Coverage requires Chromium");
const coverage: Awaited<ReturnType<import("@playwright/test").Page["coverage"]["stopJSCoverage"]>> = [];
async function checkpoint(page: import("@playwright/test").Page) {
  if (!collectCoverage) return;
  coverage.push(...await page.coverage.stopJSCoverage());
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
}
const h = await harness();
let browser;
try {
  browser = await ({ chromium, firefox, webkit }[engine as "chromium" | "firefox" | "webkit"]).launch({ headless: true });
  const applicantContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    }),
    staffContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
  const applicant = await applicantContext.newPage(),
    staff = await staffContext.newPage(),
    errors: string[] = [];
  for (const p of [applicant, staff]) {
    p.on("pageerror", (e) => errors.push(e.message));
    if (collectCoverage) await p.coverage.startJSCoverage({ resetOnNavigation: false });
  }
  await mkdir("test-results", { recursive: true });
  await applicant.goto(h.cfg.origin);
  await expect(
    applicant.getByRole("heading", { name: "The Ascent of Mytikas" }),
  ).toBeVisible();
  await checkpoint(applicant);
  await applicant.getByRole("link", { name: "Apply / sign in" }).click();
  await expect(
    applicant.getByRole("heading", { name: "Apply to Mytikas" }),
  ).toBeVisible();
  await expect(applicant.getByRole("checkbox")).not.toBeChecked();
  await applicant.locator("#signup-email").fill("browser@example.test");
  await applicant.locator("#signup-password").fill(PASS);
  await applicant.getByLabel("Full in-game name").fill("Browser Summit");
  await applicant
    .getByLabel("Why do you want to join?")
    .fill("I enjoy guild groups.");
  await expect(applicant.locator("#counter")).toHaveText("21 / 300 characters");
  await applicant
    .getByRole("button", { name: "Create account & apply" })
    .click();
  await expect(applicant.locator("#signup")).toBeVisible();
  await applicant.getByRole("checkbox").check();
  await applicant
    .getByRole("button", { name: "Create account & apply" })
    .click();
  await expect(applicant.locator(".tag")).toHaveText("SUBMITTED");
  await expect(
    applicant.getByRole("link", { name: "Admin panel" }),
  ).toHaveCount(0);
  const application = (
    await h.pool.query(
      "SELECT a.id FROM applications a JOIN users u ON u.id=a.user_id WHERE u.email='browser@example.test'",
    )
  ).rows[0];
  await applicant.screenshot({
    path: "test-results/account-submitted.png",
    fullPage: true,
  });
  console.log(
    "✓ Browser: combined signup, unchecked rules acceptance, counter, submitted status and applicant permissions",
  );
  // A signed-out staff review link must survive account login.
  await staff.goto(`${h.cfg.origin}/admin.html#${application.id}`);
  await checkpoint(staff);
  await staff.getByRole("link", { name: "Go to your account" }).click();
  await staff.locator("#login-email").fill("admin@example.test");
  await staff.locator("#login-password").fill(PASS);
  await checkpoint(staff);
  await staff.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(staff.locator("#detail .tag")).toHaveText("SUBMITTED");
  await staff
    .getByLabel("Review note")
    .fill("Please add your usual play time.");
  await staff.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(staff.locator("#detail .tag")).toHaveText("REJECTED");
  await staff.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(staff.locator("#detail .tag")).toHaveText("REOPENED");
  await staff
    .getByText("Admin tools · rules and account roles", { exact: true })
    .click();
  await staff
    .getByLabel("New rules (plain text)")
    .fill("Be respectful. No cheating. Follow guild leadership.");
  await staff.getByRole("button", { name: "Publish new version" }).click();
  await expect(staff.locator("#published-rules")).toContainText(
    "Rules version 2",
  );
  await checkpoint(applicant);
  await applicant.reload();
  await expect(applicant.locator(".tag")).toHaveText("REOPENED");
  await expect(applicant.getByRole("checkbox")).not.toBeChecked();
  await expect(applicant.locator("#current-rules")).toContainText(
    "Rules version 2",
  );
  await applicant
    .getByLabel("Why do you want to join?")
    .fill("I enjoy guild groups and play in the evenings.");
  await applicant.getByRole("checkbox").check();
  // Simulate a committed mutation whose response is lost at the tunnel.
  await applicant.route("**/api/application", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await route.abort("failed");
  });
  await applicant.getByRole("button", { name: "Resubmit application" }).click();
  await expect(applicant.locator(".tag")).toHaveText("SUBMITTED");
  await applicant.unroute("**/api/application");
  await applicant.getByText("Submission history (2)", { exact: true }).click();
  await expect(
    applicant.getByText("Revision 1 · Browser Summit", { exact: true }),
  ).toBeVisible();
  await expect(
    applicant.getByText(
      "PROTOTYPE RULES — draft for local testing; replace before opening recruitment.",
      { exact: false },
    ),
  ).toBeVisible();
  console.log(
    "✓ Browser: staff rejection/reopening, rules publication, applicant revision and immutable history",
  );
  await checkpoint(staff);
  await staff.reload();
  await expect(staff.locator("#detail .tag")).toHaveText("SUBMITTED");
  await staff.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(staff.locator("#detail .tag")).toHaveText("APPROVED");
  await checkpoint(applicant);
  await applicant.reload();
  await expect(applicant.locator(".tag")).toHaveText("APPROVED");
  await applicant.getByRole("button", { name: "Check now" }).click();
  await expect(applicant.locator(".tag")).toHaveText("JOINED");
  await expect(
    applicant.getByRole("button", { name: "Check now" }),
  ).toHaveCount(0);
  await staff.getByRole("button", { name: "Refresh queue" }).click();
  await expect(staff.locator("#queue")).not.toContainText("Browser Summit");
  await expect(staff.locator("#detail .tag")).toHaveText("JOINED");
  console.log(
    "✓ Browser: approval, applicant armory check, joined status and removal from pending queue",
  );
  await staff
    .getByText("Admin tools · rules and account roles", { exact: true })
    .click();
  await staff.getByLabel("Find accounts by email").fill("browser@example.test");
  await staff
    .getByRole("button", { name: "Find accounts", exact: true })
    .click();
  await staff
    .getByLabel("browser@example.test", { exact: true })
    .selectOption("MODERATOR");
  await staff.getByRole("button", { name: "Save role" }).click();
  await expect(staff.locator("#message")).toHaveText("Account role updated.");
  await checkpoint(applicant);
  await applicant.reload();
  await checkpoint(applicant);
  await applicant.getByRole("link", { name: "Admin panel" }).click();
  await expect(
    applicant.getByText("Admin tools · rules and account roles", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    applicant.getByRole("heading", { name: "Applications", exact: true }),
  ).toBeVisible();
  const manualClient = new Client(h.cfg.origin);
  await manualClient.signup("Browser Manual");
  await staff.getByRole("button", { name: "Refresh queue" }).click();
  await staff.getByRole("link", { name: /Browser Manual/ }).click();
  await staff.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(staff.locator("#detail .tag")).toHaveText("APPROVED");
  await staff
    .getByRole("button", { name: "Mark as joined", exact: true })
    .click();
  await expect(staff.locator("#detail .tag")).toHaveText("JOINED");
  await expect(staff.locator("#detail")).toContainText(
    "Joining confirmed manually by staff.",
  );
  console.log(
    "✓ Browser: manual joining and refresh of selected application status",
  );
  await staff.screenshot({
    path: "test-results/admin-desktop.png",
    fullPage: true,
  });
  console.log(
    "✓ Browser: account lookup, role assignment, moderator panel without admin tools",
  );
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  mobile.on("pageerror", (e) => errors.push(e.message));
  if (collectCoverage) await mobile.coverage.startJSCoverage({ resetOnNavigation: false });
  await mobile.goto(h.cfg.origin + "/account.html");
  await expect(
    mobile.getByRole("heading", { name: "Apply to Mytikas" }),
  ).toBeVisible();
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await mobile.screenshot({
    path: "test-results/account-mobile.png",
    fullPage: true,
  });
  // Registration can commit even if its new session cookie never reaches the browser.
  await mobile.locator("#signup-email").fill("lost-response@example.test");
  await mobile.locator("#signup-password").fill(PASS);
  await mobile.getByLabel("Full in-game name").fill("Lost Response");
  await mobile.getByLabel("Why do you want to join?").fill("Keep this application when the response is lost.");
  await mobile.getByRole("checkbox").check();
  await mobile.route("**/api/auth/register", async route => {
    const request = route.request();
    const response = await fetch(request.url(), {
      method: "POST", headers: await request.allHeaders(), body: request.postData(),
    });
    assert.equal(response.status, 201);
    await response.arrayBuffer();
    await route.abort("failed");
  });
  await mobile.getByRole("button", { name: "Create account & apply" }).click();
  await expect(mobile.locator("#message")).toContainText("account may have been created");
  await expect(mobile.getByRole("button", { name: "Create account & apply" })).toBeDisabled();
  await expect(mobile.getByLabel("Why do you want to join?")).toHaveValue("Keep this application when the response is lost.");
  assert.equal((await h.pool.query("SELECT count(*) FROM users WHERE email='lost-response@example.test'")).rows[0].count, "1");
  await mobile.locator("#login-email").fill("lost-response@example.test");
  await mobile.locator("#login-password").fill(PASS);
  await mobile.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(mobile.locator(".tag")).toHaveText("SUBMITTED");
  await mobile.getByRole("button", { name: "Sign out" }).click();
  await expect(mobile.locator("#signup")).toBeVisible();
  await checkpoint(mobile);
  await mobile.route("**/api/auth/me", route => route.fulfill({ status: 502, contentType: "text/html", body: "<html>Tunnel unavailable</html>" }));
  await mobile.reload();
  await expect(mobile.locator("#message")).toContainText("service could not be reached");
  if (collectCoverage) coverage.push(...await mobile.coverage.stopJSCoverage());
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log(
    "✓ Browser: mobile layout has no horizontal overflow; no uncaught page errors",
  );
  // Check bootstrap admin has no application and local health is still ready.
  assert.equal(
    (
      await h.pool.query("SELECT count(*) FROM applications WHERE user_id=$1", [
        h.admin.id,
      ])
    ).rows[0].count,
    "0",
  );
  if (collectCoverage) {
    for (const p of [applicant, staff]) coverage.push(...await p.coverage.stopJSCoverage());
    await mkdir("coverage/raw/frontend", { recursive: true });
    await writeFile("coverage/raw/frontend/application.json", JSON.stringify(coverage));
  }
  console.log(
    "Browser checks passed. Armory and Discord use the isolated fixture service.",
  );
} finally {
  await browser?.close();
  await h.stop();
}
