import { reportBlacklistConfiguration } from "../src/blacklist-status.js";
import { expect, type Page } from "@playwright/test";
import { Client, PASS, type harness } from "./harness.js";
import { transaction } from "../src/db.js";
import { importReport } from "../src/blacklist.js";

export async function memberBrowser(
  page: Page,
  h: Awaited<ReturnType<typeof harness>>,
  checkpoint: () => Promise<void>,
) {
  const url = h.cfg.origin;
  const staffAccount = page.getByRole("heading", {name: "Your staff account"});
  await checkpoint();
  await page.goto(url + "/addon.html");
  await expect(
    page.getByText("Waiting for the first verified release."),
  ).toBeVisible();
  await h.pool.query(
    "INSERT INTO addon_releases VALUES('1.0.1',now(),'Window update',$1,$2),('1.0.0',now(),'Original',$1,$2)",
    ["0".repeat(64), Buffer.from("browser fixture")],
  );
  await checkpoint();
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Download OlympusMytikas-1.0.0.zip" }),
  ).toBeVisible();
  await checkpoint();
  await page.goto(url + "/blacklist.html");
  await expect(page.getByText("Waiting for a current worker status report.")).toBeVisible();
  await expect(page.getByText("No reports imported.")).toBeVisible();
  await reportBlacklistConfiguration(h.pool, false, {DISCORD_GUILD_ID:"34"});
  await checkpoint(); await page.reload();
  await expect(page.getByText("Configure the bot token and blacklist channel ID on the worker to read Discord history.")).toBeVisible();
  const configured = {DISCORD_BOT_TOKEN:"fixture-only", DISCORD_GUILD_ID:"34", DISCORD_BLACKLIST_CHANNEL_ID:"12"};
  await reportBlacklistConfiguration(h.pool,false,configured);
  await checkpoint(); await page.reload();
  await expect(page.getByText("Waiting for the worker’s first successful Discord history check.")).toBeVisible();
  await h.pool.query("INSERT INTO integration_health VALUES('blacklist-history',now())");
  await reportBlacklistConfiguration(h.pool,true,configured);
  await checkpoint(); await page.reload();
  await expect(page.getByText("Discord history checks are current.")).toBeVisible();
  await expect(page.getByText("No reports imported.")).toBeVisible();
  await h.pool.query("UPDATE integration_health SET succeeded_at=now()-interval '16 minutes' WHERE lane='blacklist-history'");
  await checkpoint(); await page.reload();
  await expect(page.getByText(/Discord history checks are overdue/)).toBeVisible();
  await transaction(h.pool, async (c) => {
    await importReport(
      c,
      {
        id: "12345",
        channel_id: "12",
        author: { id: "432" },
        timestamp: new Date(),
        content: "Name: Absent\nSurname: Character\nReason: Officer fixture",
      },
      "34",
      "12",
    );
  });
  await checkpoint();
  await page.reload();
  await expect(page.getByText("Officer fixture")).toBeVisible();
  await new Client(url).signup("Absent Character");
  await h.pool.query("INSERT INTO blacklist_checkpoint VALUES('12','12345')");
  await h.pool.query(
    "INSERT INTO blacklist_checks VALUES('absent character',current_date,now(),'MATCH',true)",
  );
  await h.pool.query(
    "INSERT INTO blacklist_warnings(character_key,character_name,delivered_id) VALUES ('absent character','Absent Character',NULL),('absent character','Absent Character','7654')",
  );
  await h.pool.query("INSERT INTO blacklist_reports SELECT '12346',guild_id,channel_id,reporter_id,reported_at,'Past Report','past report','Old report',now(),$1,'Corrected' FROM blacklist_reports WHERE message_id='12345'",[h.admin.id]);
  await checkpoint();
  await page.reload();
  await expect(page.getByText("Past Report",{exact:true})).toBeVisible();
  await expect(page.getByText(/Warning #.*Pending/)).toBeVisible();
  await page.getByLabel("Character name").fill("Absent");
  await checkpoint();
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(/Warning #.*Pending/)).toBeVisible();
  await expect(page.getByText(/Warning #.*Delivered/)).toBeVisible();
  await page.getByLabel("Correction reason").fill("Wrong character");
  await page.getByRole("button", { name: "Void mistaken report" }).click();
  await expect(page.getByText(/Voided by/)).toBeVisible();
  await expect(page.getByText(/Warning #.*Withdrawn/)).toBeVisible();
  await expect(page.getByText(/Warning #.*Delivered/)).toBeVisible();
  await page.getByLabel("Character name").fill("No such fixture");
  await checkpoint();
  await page.getByRole("button", {name:"Search"}).click();
  await expect(page.getByText("No matching reports.")).toBeVisible();
  for (const width of [390, 1200]) {
    await page.setViewportSize({ width, height: 844 });
    await checkpoint();
    await page.goto(url + "/account.html?discord=cancelled");
    await expect(
      page.getByRole("heading", { name: "Member Home" }),
    ).toBeVisible();
    await expect(page.getByText("Current release · 1.0.1")).toBeVisible();
    await expect(staffAccount).toBeVisible();
  }
  await page.route("**/api/discord", (route) =>
    route.fulfill({
      json: {
        configured: true,
        invite: "https://discord.gg/fixture",
        membership: "confirmed",
        link: { username: "BrowserFixture" },
        checkedAt: new Date().toISOString(),
      },
    }),
  );
  await checkpoint();
  await page.reload();
  await expect(staffAccount).toBeVisible();
  await page.unroute("**/api/discord");
  await page.route("**/api/discord", (route) =>
    route.fulfill({
      json: { configured: true, invite: "https://discord.gg/fixture" },
    }),
  );
  await page.route("**/api/discord/link", (route) =>
    route.fulfill({
      json: { url: url + "/account.html?discord=cancelled#linked" },
    }),
  );
  await page.getByRole("button", {name: "Unlink Discord"}).click();
  await expect(page.getByRole("button", {name: "Link Discord account"})).toBeVisible();
  await expect(staffAccount).toBeVisible();
  await checkpoint();
  await page.getByRole("button", { name: "Link Discord account" }).click();
  await expect(page).toHaveURL(/#linked$/);
  await checkpoint();
  await page.unroute("**/api/discord");
  await page.unroute("**/api/discord/link");
  // Exercise direct visits when the session expires.
  for (const name of ["addon", "blacklist"]) {
    await page.route("**/api/" + name + "*", (route) =>
      route.fulfill({ status: 403, json: { error: "Denied" } }),
    );
    await checkpoint();
    await page.goto(url + "/" + name + ".html");
    await expect(page.getByText("Denied")).toBeVisible();
    await page.unroute("**/api/" + name + "*");
  }
  await applicantRevocation(page, h);
  await pausedMembership(page, h, checkpoint);
  await page.setViewportSize({ width: 390, height: 844 });
  await checkpoint();
  await page.goto(url + "/account.html");
  await expect(staffAccount).toBeVisible();
}

async function pausedMembership(page: Page, h: Awaited<ReturnType<typeof harness>>, checkpoint: () => Promise<void>) {
  const url = h.cfg.origin;
  const approved = new Client(url), reopened = new Client(url), staff = new Client(url);
  await staff.login();
  expect((await approved.signup("Pause Approved")).status).toBe(201);
  expect((await reopened.signup("Pause Reopened")).status).toBe(201);
  const approvedId = (await approved.application()).application.id;
  const reopenedId = (await reopened.application()).application.id;
  expect((await staff.request(`/api/admin/applications/${approvedId}/approve`, {})).status).toBe(200);
  expect((await staff.request(`/api/admin/applications/${reopenedId}/reject`, {})).status).toBe(200);
  expect((await staff.request(`/api/admin/applications/${reopenedId}/reopen`, {})).status).toBe(200);

  const context = page.context();
  const staffCookies = await context.cookies();
  const previous = process.env.MEMBERSHIP_DECISIONS_PAUSED;
  const notice = page.locator("#workspace [role=status]");
  try {
    process.env.MEMBERSHIP_DECISIONS_PAUSED = "1";
    await checkpoint();
    await page.goto(url + "/account.html");
    await expect(page.getByRole("heading", {name: "Your staff account"})).toBeVisible();
    await expect(notice).toContainText("temporarily paused");
    await expect(page.getByRole("link", {name: "Raid Roster", exact: true})).toBeVisible();
    await expect(page.getByRole("link", {name: "Mytikas Addon", exact: true})).toHaveCount(0);
    await checkpoint();
    await page.goto(url + "/admin.html#" + approvedId);
    await expect(notice).toContainText("temporarily paused");
    const detail = page.locator("#detail");
    await expect(detail.getByText("Submission notifications")).toBeVisible();
    await detail.getByText("Submission history (1)").click();
    await expect(detail.getByRole("heading", {name: "Revision 1 · Pause Approved"})).toBeVisible();
    await expect(detail.getByRole("heading", {name: "Application timeline"})).toBeVisible();
    await expect(detail.getByRole("button")).toHaveCount(0);
    await expect(detail.getByLabel("Review note", {exact: false})).toHaveCount(0);
    await expect(page.getByText("Edit Raid Rosters", {exact: true})).toBeVisible();

    await context.clearCookies();
    await checkpoint();
    await page.goto(url + "/account.html");
    await expect(notice).toContainText("You can still apply");
    await expect(page.getByRole("button", {name: "Create account & apply"})).toBeEnabled();
    for (const client of [approved, reopened]) {
      const [name, value] = client.cookie.split("=");
      await context.addCookies([{name: name!, value: value!, url}]);
      await checkpoint();
      await page.reload();
      await expect(page.getByText("Current guild rules", {exact: true})).toBeVisible();
      await expect(notice).toContainText("temporarily paused");
      if (client === approved) {
        await expect(page.getByText("APPROVED", {exact: true})).toBeVisible();
        await expect(page.getByRole("button", {name: "Check now"})).toHaveCount(0);
        await expect(page.getByText(/Automatic checks run every/)).toHaveCount(0);
        await expect(page.getByRole("link", {name: "Open character in the armory"})).toBeVisible();
        await expect(page.getByRole("heading", {name: "Mytikas Addon"})).toHaveCount(0);
      } else {
        await page.getByRole("checkbox").check();
        await page.getByRole("button", {name: "Resubmit application"}).click();
        await expect(page.getByText("Your revised application has been submitted.")).toBeVisible();
        await expect(page.getByText("Submission history (2)")).toBeVisible();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.MEMBERSHIP_DECISIONS_PAUSED;
    else process.env.MEMBERSHIP_DECISIONS_PAUSED = previous;
    await context.clearCookies();
    await context.addCookies(staffCookies);
  }
}

async function applicantRevocation(adminPage: Page, h: Awaited<ReturnType<typeof harness>>) {
  // Absent Character is now awaiting review after the administrator's correction.
  const url = h.cfg.origin;
  const context = await adminPage.context().browser()!.newContext();
  try {
    const applicant = await context.newPage();
    await applicant.goto(url + "/account.html");
    await applicant.locator("#login-email").fill("absent.character@example.test");
    await applicant.locator("#login-password").fill(PASS);
    await applicant.getByRole("button", { name: "Sign in", exact: true }).click();
    const nav = applicant.getByRole("navigation");
    const addonTab = nav.getByRole("link", { name: "Mytikas Addon", exact: true });
    const addonCard = applicant.getByRole("heading", { name: "Mytikas Addon", exact: true });
    await expect(addonTab).toBeVisible();
    await expect(addonCard).toBeVisible();
    await expect(applicant.getByText("Current guild rules", {exact: true})).toBeVisible();
    await expect(nav.getByRole("link", { name: "Blacklist", exact: true })).toHaveCount(0);
    await addonTab.click();
    const downloadLink = applicant.getByRole("link", {name: "Download OlympusMytikas-1.0.1.zip"});
    await expect(downloadLink).toBeVisible();
    const bookmark = new URL((await downloadLink.getAttribute("href"))!, url).href;
    const download = await context.request.get(bookmark);
    expect(download.status()).toBe(200);
    expect((await download.body()).toString()).toBe("browser fixture");

    const reason = "Private officer finding for this fixture.";
    await transaction(h.pool, c => importReport(c, {
      id: "12347", channel_id: "12", author: {id: "432"}, timestamp: new Date(),
      content: "Name: Absent\nSurname: Character\nReason: " + reason,
    }, "34", "12"));
    // A previously displayed link and a direct visit must enforce the new report immediately.
    const denied = await context.request.get(bookmark);
    expect(denied.status()).toBe(403);
    expect(denied.headers()["cache-control"]).toContain("no-store");
    await applicant.reload();
    await expect(applicant.getByRole("alert")).toHaveText("Addon access is unavailable.");
    await expect(downloadLink).toHaveCount(0);
    await applicant.getByRole("link", { name: "Member Home", exact: true }).click();
    await expect(applicant.getByText("BLACKLISTED", {exact: true})).toBeVisible();
    await expect(applicant.getByText("Current guild rules", {exact: true})).toBeVisible();
    await expect(addonTab).toHaveCount(0);
    await expect(addonCard).toHaveCount(0);
    await expect(applicant.getByText(reason, {exact: true})).toHaveCount(0);
    await applicant.goto(url + "/blacklist.html?q=Absent");
    await expect(applicant.getByRole("alert")).toHaveText("Admin permission required.");
    await expect(applicant.getByText(reason, {exact: true})).toHaveCount(0);
  } finally {
    await context.close();
  }
}
