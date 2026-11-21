import assert from "node:assert/strict";
import { Client, harness } from "./harness.js";
import { importReport } from "../src/blacklist.js";
import { transaction } from "../src/db.js";
import { membershipTick } from "../src/worker.js";

const previous = process.env.MEMBERSHIP_DECISIONS_PAUSED;
const previousDownloadSetting = process.env.ADDON_DOWNLOADS_PAUSED;
delete process.env.MEMBERSHIP_DECISIONS_PAUSED;
delete process.env.ADDON_DOWNLOADS_PAUSED;
const h = await harness();
try {
  const staff = new Client(h.cfg.origin);
  await staff.login();
  const applicant = new Client(h.cfg.origin);
  await applicant.signup("Pause Member");
  const { application } = await applicant.application();
  const review = "/api/admin/applications/" + application.id;
  assert.equal((await staff.request(review + "/approve", {})).status, 200);

  const draft = new Client(h.cfg.origin);
  await draft.signup("Draft Member");
  const draftApplication = (await draft.application()).application;
  for (const action of ["reject", "reopen"])
    assert.equal(
      (
        await staff.request(
          "/api/admin/applications/" + draftApplication.id + "/" + action,
          {},
        )
      ).status,
      200,
    );
  await h.pool.query(
    "INSERT INTO addon_releases VALUES('1.2.3',now(),'Synthetic fixture',$1,$2)",
    ["0".repeat(64), Buffer.from("fixture")],
  );

  process.env.MEMBERSHIP_DECISIONS_PAUSED = "1";
  for (const client of [staff, applicant]) {
    const { data } = await client.request("/api/auth/me");
    assert.equal(data.membershipDecisionsPaused, true);
    assert.equal(data.addonDownloadsPaused, true);
    assert.equal(data.canDownloadAddon, false);
    for (const endpoint of ["/api/addon", "/api/addon/1.2.3"]) {
      const result = await client.request(endpoint);
      assert.equal(result.status, 503);
      assert.match(result.data.error, /temporarily paused/i);
      assert.match(result.headers.get("cache-control")!, /no-store/);
    }
  }
  const anonymous = new Client(h.cfg.origin);
  process.env.ADDON_DOWNLOADS_PAUSED = "0";
  const bookmark = h.cfg.origin + "/api/addon/1.2.3";
  for (const client of [staff, applicant, anonymous]) {
    const { data } = await client.request("/api/auth/me");
    assert.equal(data.membershipDecisionsPaused, true);
    assert.equal(data.addonDownloadsPaused, false);
    assert.equal(data.canDownloadAddon, client !== anonymous);
    const list = await client.request("/api/addon");
    const download = await fetch(bookmark, { headers: { Cookie: client.cookie } });
    assert.equal(download.status, client === anonymous ? 401 : 200);
    assert.equal(list.status, download.status);
    assert.match(download.headers.get("cache-control")!, /no-store/);
    if (download.ok) assert.equal(await download.text(), "fixture");
  }
  assert.equal((await anonymous.request("/api/addon")).status, 401);
  assert.equal((await applicant.request(review + "/approve", {})).status, 403);
  for (const action of [
    "approve",
    "reject",
    "reopen",
    "join",
    "remove",
    "restore",
    "check",
  ]) {
    const result = await staff.request(review + "/" + action, {
      note: "Fixture",
    });
    assert.equal(result.status, 503, action);
    assert.match(
      result.data.error,
      /membership decisions are temporarily paused/i,
    );
  }
  assert.equal(
    (await applicant.request("/api/application/check", {})).status,
    503,
  );
  await membershipTick(h.pool, async () =>
    assert.fail("Paused worker contacted the armory"),
  );
  const paused = (await applicant.application()).application;
  assert.equal(paused.status, "APPROVED");
  assert.equal(paused.last_check_at, null);
  assert.equal((await staff.request("/api/rosters")).status, 200);
  assert.equal((await applicant.request("/api/discord")).status, 200);
  assert.equal((await staff.request(review)).status, 200);

  // Keep accepting new applications and revisions while the historical import is pending.
  const newcomer = new Client(h.cfg.origin);
  assert.equal((await newcomer.signup("Pause Rookie")).status, 201);
  const revised = await draft.request("/api/application", {
    characterName: "Draft Revised",
    motivation: "Updated application",
    rulesId: (await draft.request("/api/rules")).data.id,
    acceptRules: true,
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.data.application.character_name, "Draft Revised");
  await transaction(h.pool, (client) =>
    importReport(
      client,
      {
        id: "400",
        channel_id: "300",
        guild_id: "200",
        author: { id: "100" },
        timestamp: new Date().toISOString(),
        content: "Name: Draft\nSurname: Revised\nReason: Fixture",
      },
      "200",
      "300",
    ),
  );
  assert.equal((await draft.application()).application.status, "BLACKLISTED");
  assert.equal((await draft.request("/api/auth/me")).data.canDownloadAddon, false);
  assert.equal((await draft.request("/api/addon")).status, 403);
  assert.equal((await draft.request("/api/addon/1.2.3")).status, 403);
  assert.equal(
    (
      await staff.request("/api/blacklist/400/void", {
        reason: "Fixture correction",
      })
    ).status,
    200,
  );
  assert.equal((await draft.application()).application.status, "SUBMITTED");
  assert.equal((await draft.request("/api/auth/me")).data.canDownloadAddon, true);

  process.env.MEMBERSHIP_DECISIONS_PAUSED = "0";
  process.env.ADDON_DOWNLOADS_PAUSED = "1";
  const onlyDownloadsPaused = (await applicant.request("/api/auth/me")).data;
  assert.equal(onlyDownloadsPaused.membershipDecisionsPaused, false);
  assert.equal(onlyDownloadsPaused.addonDownloadsPaused, true);
  assert.equal(onlyDownloadsPaused.canDownloadAddon, false);
  assert.equal((await applicant.request("/api/addon")).status, 503);
  assert.equal((await applicant.request("/api/addon/1.2.3")).status, 503);
  await membershipTick(h.pool, async (name) => {
    assert.equal(name, "Pause Member");
    return "MATCH";
  });
  assert.equal((await applicant.application()).application.status, "JOINED");
  process.env.ADDON_DOWNLOADS_PAUSED = "0";
  const active = (await applicant.request("/api/auth/me")).data;
  assert.equal(active.membershipDecisionsPaused, false);
  assert.equal(active.addonDownloadsPaused, false);
  assert.equal(active.canDownloadAddon, true);
  assert.equal((await applicant.request("/api/addon")).status, 200);
  const downloaded = await fetch(h.cfg.origin + "/api/addon/1.2.3", {
    headers: { Cookie: applicant.cookie },
  });
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), "fixture");
  assert.equal(
    (await staff.request(review + "/remove", { note: "Fixture removal" }))
      .status,
    200,
  );
  console.log(
    "Independent download and membership pauses preserve registered access, blacklist enforcement and scheduled checks.",
  );
} finally {
  if (previous === undefined) delete process.env.MEMBERSHIP_DECISIONS_PAUSED;
  else process.env.MEMBERSHIP_DECISIONS_PAUSED = previous;
  if (previousDownloadSetting === undefined) delete process.env.ADDON_DOWNLOADS_PAUSED;
  else process.env.ADDON_DOWNLOADS_PAUSED = previousDownloadSetting;
  await h.stop();
}
