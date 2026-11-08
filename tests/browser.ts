import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { harness, PASS, Client } from "./harness.js";
const h = await harness();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const applicantContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    }),
    staffContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
  const applicant = await applicantContext.newPage(),
    staff = await staffContext.newPage(),
    errors: string[] = [];
  for (const p of [applicant, staff])
    p.on("pageerror", (e) => errors.push(e.message));
  await mkdir("test-results", { recursive: true });
  await applicant.goto(h.cfg.origin);
  await expect(
    applicant.getByRole("heading", { name: "The Ascent of Mytikas" }),
  ).toBeVisible();
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
  await staff.goto(h.cfg.origin + "/account.html");
  await staff.locator("#login-email").fill("admin@example.test");
  await staff.locator("#login-password").fill(PASS);
  await staff.getByRole("button", { name: "Sign in", exact: true }).click();
  await staff.getByRole("link", { name: "Admin panel" }).click();
  await staff.getByRole("link", { name: /Browser Summit/ }).click();
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
  await applicant.getByRole("button", { name: "Resubmit application" }).click();
  await expect(applicant.locator(".tag")).toHaveText("SUBMITTED");
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
  await staff.reload();
  await expect(staff.locator("#detail .tag")).toHaveText("SUBMITTED");
  await staff.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(staff.locator("#detail .tag")).toHaveText("APPROVED");
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
  await applicant.reload();
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
  console.log(
    "Browser checks passed. Armory and Discord use the isolated fixture service.",
  );
} finally {
  await browser?.close();
  await h.stop();
}
