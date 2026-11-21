import { reportBlacklistConfiguration } from "../src/blacklist-status.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { packageZip } from "./addon-fixture.js";
import { expect, type Page } from "@playwright/test";
import { Client, PASS, type harness } from "./harness.js";
import { transaction } from "../src/db.js";
import { importReport } from "../src/blacklist.js";

type MeasurePage = (page: Page) => Promise<(restart?: boolean) => Promise<void>>;

export async function memberBrowser(
  page: Page,
  h: Awaited<ReturnType<typeof harness>>,
  checkpoint: () => Promise<void>,
  measurePage: MeasurePage,
) {
  const url = h.cfg.origin;
  const staffAccount = page.getByRole("heading", {name: "Your staff account"});
  await checkpoint();
  await page.goto(url + "/addon.html");
  await expect(
    page.getByText("Waiting for the first verified release."),
  ).toBeVisible();
  await h.pool.query(
    "INSERT INTO addon_releases VALUES('1.0.0',now(),'Original',$1,$2)",
    ["0".repeat(64), Buffer.from("browser fixture")],
  );
  await checkpoint();
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Download OlympusMytikas-1.0.0.zip" }),
  ).toBeVisible();
  const archive = await publishAddon(page, h, measurePage);
  await registeredAccountDownload(page, h, archive, measurePage);
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
  const blockedMember = new Client(url);
  await blockedMember.signup("Absent Character");
  const application = (await blockedMember.application()).application;
  await h.pool.query("INSERT INTO blacklist_checkpoint VALUES('12','12345')");
  await h.pool.query(
    "INSERT INTO blacklist_checks VALUES('absent character',current_date,now(),'MATCH',true)",
  );
  await h.pool.query(
    "INSERT INTO blacklist_warnings(character_key,character_name,delivered_id) VALUES ('absent character','Absent Character',NULL),('absent character','Absent Character','7654')",
  );
  await h.pool.query("INSERT INTO blacklist_reports SELECT '12346',guild_id,channel_id,reporter_id,reported_at,'Past Report','past report','Old report',now(),$1,'Corrected' FROM blacklist_reports WHERE message_id='12345'",[h.admin.id]);
  await transaction(h.pool, c => importReport(c, {
    id: "12348", channel_id: "12", author: {id: "678"}, timestamp: new Date(),
    content: "Name: Absent\nSurname: Neighbor\nReason: Neighbor report",
  }, "34", "12"));
  await checkpoint();
  await page.reload();

  const table = page.getByRole("table", {name: "Blacklist reports"});
  const reportRow = (name: string) => table.getByRole("row").filter({
    has: page.getByRole("rowheader", {name, exact: true}),
  });
  const target = reportRow("Absent Character"), neighbor = reportRow("Absent Neighbor"), past = reportRow("Past Report");
  await expect(page.getByRole("table")).toHaveCount(1);
  await expect(table.getByRole("columnheader")).toHaveText(["Character", "Report", "Guild checks", "Moderation"]);
  await expect(table.getByRole("rowheader")).toHaveCount(3);
  const bot = page.getByRole("region", {name: "Discord bot"});
  await expect(bot).toContainText("Last successful Discord history check");
  await expect(bot).toContainText("Last processed channel message 12345");
  await expect(target).toContainText("Officer fixture");
  await expect(target).toContainText("Reported by 432");
  await expect(target).toContainText("MATCH");
  await expect(target.getByRole("link", {name: "Source message"})).toHaveAttribute("href", "https://discord.com/channels/34/12/12345");
  await expect(target.getByRole("link", {name: /Application/})).toHaveAttribute("href", "/admin.html#" + application.id);
  await expect(neighbor).toContainText("Neighbor report");
  await expect(neighbor).toContainText("Awaiting armory check");
  await expect(neighbor).toContainText("No matching application.");
  await expect(neighbor.getByRole("link", {name: "Source message"})).toHaveAttribute("href", "https://discord.com/channels/34/12/12348");
  await expect(past).toContainText("Corrected");
  await expect(past.getByText("Void report", {exact:true})).toHaveCount(0);
  const region = page.getByRole("region", {name: "Report history"});
  await region.focus();
  await expect(region).toBeFocused();
  const layout = await region.evaluate(el => {
    el.scrollLeft = el.scrollWidth;
    return { scrollLeft: el.scrollLeft, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth };
  });
  expect(layout.scrollLeft).toBeGreaterThan(0);
  expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport + 1);

  const search = page.getByRole("search");
  await search.getByLabel("Character name").fill("Absent");
  await checkpoint();
  await search.getByRole("button", {name: "Search"}).click();
  await expect(table.getByRole("rowheader")).toHaveCount(2);
  await expect(past).toHaveCount(0);
  await expect(target.getByText(/Warning #.*Pending/)).toBeVisible();
  await expect(target.getByText(/Warning #.*Delivered/)).toBeVisible();
  const targetReason = target.getByLabel("Correction reason");
  await expect(targetReason).toBeHidden();
  await target.getByText("Void report", {exact: true}).focus();
  await page.keyboard.press("Enter");
  await expect(targetReason).toBeVisible();
  await expect(neighbor.getByLabel("Correction reason")).toBeHidden();
  await targetReason.fill("Wrong character");
  await target.getByRole("button", { name: "Void mistaken report" }).click();
  await expect(target).toContainText("Wrong character");
  await expect(target).toContainText("Voided by " + h.admin.id);
  await expect(target.getByRole("rowheader")).toBeFocused();
  await expect(target.getByText(/Warning #.*Withdrawn/)).toBeVisible();
  await expect(target.getByText(/Warning #.*Delivered/)).toBeVisible();
  await expect(neighbor.getByText("Void report", {exact:true})).toBeVisible();
  await expect(neighbor).not.toContainText("Wrong character");
  // A reconciliation scan can later confirm Discord accepted the withdrawn job.
  await h.pool.query(
    "UPDATE blacklist_warnings SET delivered_id='7655' WHERE character_key='absent character' AND withdrawn_at IS NOT NULL",
  );
  await checkpoint();
  await page.reload();
  await expect(target.getByText(/Warning #.*Delivered/)).toHaveCount(2);
  await expect(target.getByText(/Warning #.*Withdrawn/)).toHaveCount(0);
  await search.getByLabel("Character name").fill("No such fixture");
  await checkpoint();
  await search.getByRole("button", {name:"Search"}).click();
  await expect(page.getByText("No matching reports.")).toBeVisible();
  await expect(page.getByRole("rowheader")).toHaveCount(0);
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
  await applicantRevocation(page, h, archive, measurePage);
  await pausedMembership(page, h, checkpoint);
  await page.setViewportSize({ width: 390, height: 844 });
  await checkpoint();
  await page.goto(url + "/account.html");
  await expect(staffAccount).toBeVisible();
}

async function publishAddon(adminPage: Page, h: Awaited<ReturnType<typeof harness>>, measurePage: MeasurePage) {
  const staff = new Client(h.cfg.origin);
  await staff.login();
  const context = await adminPage.context().browser()!.newContext();
  const [name, value] = staff.cookie.split("=");
  await context.addCookies([{name: name!, value: value!, url: h.cfg.origin}]);
  const page = await context.newPage();
  const checkpoint = await measurePage(page);
  try {
    await page.goto(h.cfg.origin + "/addon.html");
    return await submitRelease(page, checkpoint);
  } finally {
    await checkpoint(false);
    await context.close();
  }
}

async function submitRelease(page: Page, checkpoint: () => Promise<void>) {
  const version = "1.0.1", archive = packageZip(version);
  const file = {name: "OlympusMytikas-1.0.1.zip", mimeType: "application/zip", buffer: archive};
  const form = page.getByRole("form", {name: "Publish an addon release"});
  const versionField = form.getByLabel("Release version"), fileField = form.getByLabel("Addon ZIP");
  const notesField = form.getByLabel("Release notes"), publish = form.getByRole("button", {name: "Publish release"});
  const alert = page.getByRole("alert");
  await versionField.fill(version);
  await fileField.setInputFiles({...file, buffer: Buffer.alloc(8_000_001)});
  await publish.click();
  await expect(alert).toContainText("8 MB");
  await fileField.setInputFiles(file);
  await notesField.fill("é".repeat(1025));
  await publish.click();
  await expect(alert).toContainText("2,048 UTF-8 bytes");
  const notes = "Édition été\nTarget fixes & bindings";
  await notesField.fill(notes);
  await versionField.fill("1.0.9"); // Archive declares 1.0.1.
  const refused = page.waitForResponse(r => r.url().endsWith("/api/admin/addon/releases"));
  await publish.click();
  expect((await refused).status()).toBe(400);
  await expect(alert).toContainText("ZIP validation failed");
  await expect(notesField).toHaveValue(notes);

  await versionField.fill(version);
  let resume!: () => void;
  const held = new Promise<void>(resolve => { resume = resolve; });
  await page.route("**/api/admin/addon/releases", async route => {
    await held;
    await route.continue();
  }, {times: 1});
  try {
    await publish.click();
    await expect(form.getByRole("status")).toContainText("Uploading and verifying version 1.0.1");
    await expect(publish).toBeDisabled();
  } finally { resume(); }
  await expect(alert).toHaveText("Published addon version 1.0.1.");
  await expect(page.getByRole("heading", {name: "Current release · 1.0.1"})).toBeVisible();
  await expect(page.getByText(notes, {exact: true})).toBeVisible();
  await expect(page.getByText("SHA-256 " + createHash("sha256").update(archive).digest("hex"), {exact:true})).toBeVisible();
  await expect(fileField).toHaveValue("");
  await versionField.fill(version);
  await fileField.setInputFiles(file);
  const duplicate = page.waitForResponse(r => r.url().endsWith("/api/admin/addon/releases"));
  await publish.click();
  expect((await duplicate).status()).toBe(409);
  await expect(alert).toContainText("already been published");
  await expect(publish).toBeEnabled();
  await page.route("**/api/admin/addon/releases", route => route.abort(), {times: 1});
  await publish.click();
  await expect(alert).toContainText("The response was lost.");
  await expect(publish).toBeDisabled();
  await expect(form.getByRole("link", {name: "Reload current state"})).toBeVisible();
  await checkpoint();
  await page.reload();
  await versionField.fill(version);
  await fileField.setInputFiles(file);
  // Ending the account session invalidates an already open upload form.
  await page.evaluate(async () => {
    const modulePath = "/common.js";
    const {api} = await import(modulePath);
    await api("/api/auth/logout", {});
  });
  const expired = page.waitForResponse(r => r.url().endsWith("/api/admin/addon/releases"));
  await publish.click();
  expect((await expired).status()).toBe(403);
  await expect(alert).toContainText("Session token missing or expired.");
  return archive;
}

async function registeredAccountDownload(page: Page, h: Awaited<ReturnType<typeof harness>>, archive: Buffer, measurePage: MeasurePage) {
  const email = "registered-no-application@example.test";
  await h.pool.query(
    "INSERT INTO users(email,password_hash,role,email_verified_at,activation_exempt) SELECT $1,password_hash,'USER',now(),false FROM users WHERE id=$2",
    [email,h.admin.id],
  );
  const context = await page.context().browser()!.newContext();
  try {
    const member = await context.newPage();
    const checkpoint = await measurePage(member);
    await member.goto(h.cfg.origin + "/addon.html");
    await expect(member.getByRole("alert")).toHaveText("Sign in to see available addon releases.");
    await expect(member.getByRole("form", {name: "Publish an addon release"})).toHaveCount(0);
    await checkpoint();
    await member.getByRole("link", {name: "Member Home", exact:true}).click();
    await member.locator("#login-email").fill(email);
    await member.locator("#login-password").fill(PASS);
    await member.getByRole("button", {name: "Sign in", exact:true}).click();
    await expect(member.getByText("There is no guild application associated with your account.")).toBeVisible();
    await checkpoint();
    await member.getByRole("link", {name:"Mytikas Addon", exact:true}).click();
    const [download] = await Promise.all([
      member.waitForEvent("download"),
      member.getByRole("link", {name: "Download OlympusMytikas-1.0.1.zip"}).click(),
    ]);
    expect(download.suggestedFilename()).toBe("OlympusMytikas-1.0.1.zip");
    expect(await readFile((await download.path())!)).toEqual(archive);
    await expect(member.getByRole("form", {name: "Publish an addon release"})).toHaveCount(0);
    await checkpoint(false);
  } finally { await context.close(); }
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
  const previousAddon = process.env.ADDON_DOWNLOADS_PAUSED;
  const notice = page.locator("#workspace [role=status]");
  try {
    process.env.MEMBERSHIP_DECISIONS_PAUSED = "1";
    delete process.env.ADDON_DOWNLOADS_PAUSED;
    await checkpoint();
    await page.goto(url + "/account.html");
    await expect(page.getByRole("heading", {name: "Your staff account"})).toBeVisible();
    await expect(notice).toContainText("temporarily paused");
    await expect(page.getByRole("link", {name: "Raid Roster", exact: true})).toBeVisible();
    await expect(notice).toContainText("Addon downloads are temporarily paused.");
    await page.getByRole("link", {name: "Mytikas Addon", exact: true}).click();
    await expect(page.getByRole("form", {name: "Publish an addon release"})).toBeVisible();
    await expect(page.getByText("Addon downloads are temporarily paused.")).toBeVisible();
    await expect(page.getByRole("link", {name: /^Download OlympusMytikas/})).toHaveCount(0);
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
        process.env.ADDON_DOWNLOADS_PAUSED = "0";
        await checkpoint();
        await page.reload();
        await expect(notice).toContainText("Membership decisions");
        await expect(notice).not.toContainText("Addon downloads");
        await expect(page.getByRole("button", {name: "Check now"})).toHaveCount(0);
        await page.getByRole("link", {name: "Mytikas Addon", exact: true}).click();
        await expect(page.getByRole("link", {name: "Download OlympusMytikas-1.0.1.zip"})).toBeVisible();
        await expect(page.getByRole("form", {name: "Publish an addon release"})).toHaveCount(0);

        process.env.MEMBERSHIP_DECISIONS_PAUSED = "0";
        process.env.ADDON_DOWNLOADS_PAUSED = "1";
        await checkpoint();
        await page.goto(url + "/account.html");
        await expect(notice).toHaveText("Addon downloads are temporarily paused.");
        await expect(page.getByRole("button", {name: "Check now"})).toBeVisible();
        await expect(page.getByRole("link", {name: "Mytikas Addon", exact: true})).toHaveCount(0);
        process.env.MEMBERSHIP_DECISIONS_PAUSED = "1";
        delete process.env.ADDON_DOWNLOADS_PAUSED;
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
    if (previousAddon === undefined) delete process.env.ADDON_DOWNLOADS_PAUSED;
    else process.env.ADDON_DOWNLOADS_PAUSED = previousAddon;
    await context.clearCookies();
    await context.addCookies(staffCookies);
  }
}

async function applicantRevocation(adminPage: Page, h: Awaited<ReturnType<typeof harness>>, archive: Buffer, measurePage: MeasurePage) {
  // Absent Character is now awaiting review after the administrator's correction.
  const url = h.cfg.origin;
  const context = await adminPage.context().browser()!.newContext();
  try {
    const applicant = await context.newPage();
    const checkpoint = await measurePage(applicant);
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
    await checkpoint();
    await addonTab.click();
    const downloadLink = applicant.getByRole("link", {name: "Download OlympusMytikas-1.0.1.zip"});
    await expect(downloadLink).toBeVisible();
    await expect(applicant.getByRole("form", {name:"Publish an addon release"})).toHaveCount(0);
    const bookmark = new URL((await downloadLink.getAttribute("href"))!, url).href;
    const download = await context.request.get(bookmark);
    expect(download.status()).toBe(200);
    expect(await download.body()).toEqual(archive);

    const reason = "Private officer finding for this fixture.";
    await transaction(h.pool, c => importReport(c, {
      id: "12347", channel_id: "12", author: {id: "432"}, timestamp: new Date(),
      content: "Name: Absent\nSurname: Character\nReason: " + reason,
    }, "34", "12"));
    // A previously displayed link and a direct visit must enforce the new report immediately.
    const denied = await context.request.get(bookmark);
    expect(denied.status()).toBe(403);
    expect(denied.headers()["cache-control"]).toContain("no-store");
    await checkpoint();
    await applicant.reload();
    await expect(applicant.getByRole("alert")).toHaveText("Addon access is unavailable.");
    await expect(downloadLink).toHaveCount(0);
    await checkpoint();
    await applicant.getByRole("link", { name: "Member Home", exact: true }).click();
    await expect(applicant.getByText("BLACKLISTED", {exact: true})).toBeVisible();
    await expect(applicant.getByText("Current guild rules", {exact: true})).toBeVisible();
    await expect(addonTab).toHaveCount(0);
    await expect(addonCard).toHaveCount(0);
    await expect(applicant.getByText(reason, {exact: true})).toHaveCount(0);
    await checkpoint();
    await applicant.goto(url + "/blacklist.html?q=Absent");
    await expect(applicant.getByRole("alert")).toHaveText("Admin permission required.");
    await expect(applicant.getByRole("table")).toHaveCount(0);
    await expect(applicant.getByRole("region", {name:"Report history"})).toHaveCount(0);
    await expect(applicant.getByRole("link", {name:"Source message"})).toHaveCount(0);
    await expect(applicant.getByText(reason, {exact: true})).toHaveCount(0);
    await checkpoint(false);
  } finally {
    await context.close();
  }
}
