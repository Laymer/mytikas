import assert from "node:assert/strict";
import { reportsTick, scanTick, warningTick } from "../src/blacklist.js";
import { Client, harness, mailToken, PASS } from "./harness.js";

const h = await harness();
const guild = "200000000000000001",
  channel = "200000000000000002";
const reporter = "200000000000000003",
  bot = "200000000000000004";
const base = 1500000000000000000n;
const id = (offset: number) => String(base + BigInt(offset));
function message(offset: number, content: string, author = reporter) {
  return {
    id: id(offset),
    guild_id: guild,
    channel_id: channel,
    author: { id: author, bot: author === bot },
    timestamp: "2026-02-01T11:00:00.000Z",
    content,
  };
}

const history = Array.from({ length: 102 }, (_, i) =>
  message(i + 1, "Guild discussion"),
);
history[0]!.content =
  "Name: Silver\r\nSurname: Ｒidge\r\nReason: Officer's original record.";
history[99]!.content =
  "Name: Pending\nSurname: Correction\nReason: Attribution fixture.";
history[100]!.content =
  "Name: Reported\nSurname: Character\nReason: Private revision fixture.";
const pagesRead: string[] = [];
let simulateLostResponse = false;
const sent: Array<ReturnType<typeof message>> = [];
const realFetch = globalThis.fetch;
const env = {
  DISCORD_GUILD_ID: guild,
  DISCORD_BLACKLIST_CHANNEL_ID: channel,
  DISCORD_BOT_TOKEN: "test-only-token",
};
const previous = Object.fromEntries(
  Object.keys(env).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, env);
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input));
  if (u.origin === h.cfg.origin) return realFetch(input, init);
  assert.equal(u.origin, "https://discord.com");
  assert.equal(
    new Headers(init?.headers).get("authorization"),
    "Bot test-only-token",
  );
  if (u.pathname === "/api/v10/applications/@me") return Response.json({flags: 1 << 18});
  if (u.pathname.endsWith("/permissions/member/" + bot)) return Response.json({permissions: "68608"});
  if (u.pathname === "/api/v10/users/@me") return Response.json({ id: bot });
  const path = "/api/v10/channels/" + channel;
  if (u.pathname === path) return Response.json({ id: channel, guild_id: guild });
  assert.equal(u.pathname, path + "/messages");
  if (init?.method === "POST") {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.enforce_nonce, true);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    // The message is accepted amid a burst of channel traffic. The worker loses its receipt.
    for (let i = 1; i <= 101; i++) {
      history.push(
        message(102 + i, i === 1 ? payload.content : "Guild discussion"),
      );
    }
    const accepted = message(204, payload.content, bot);
    sent.push(accepted);
    history.push(accepted);
    if (simulateLostResponse) throw new Error("Lost delivery response");
    return Response.json(accepted);
  }
  const after = u.searchParams.get("after");
  if (!after) {
    assert.equal(u.searchParams.get("limit"), "1");
    return Response.json(history.slice(-1));
  }
  pagesRead.push(after);
  assert.equal(u.searchParams.get("limit"), "100");
  const page = history
    .filter((m) => BigInt(m.id) > BigInt(after))
    .slice(0, 100);
  return Response.json(page.reverse());
};

try {
  const member = new Client(h.cfg.origin),
    admin = new Client(h.cfg.origin);
  await admin.login();
  await member.signup("Silver Ridge");

  // A failure on the last report must roll back every earlier report, membership update and cursor.
  await h.pool
    .query(`ALTER TABLE blacklist_reports ADD CONSTRAINT fixture_interrupt
    CHECK (message_id <> '${id(100)}')`);
  await assert.rejects(reportsTick(h.pool), { code: "23514" });
  assert.equal(
    (await h.pool.query("SELECT 1 FROM blacklist_reports")).rowCount,
    0,
  );
  assert.equal(
    (await h.pool.query("SELECT 1 FROM blacklist_checkpoint")).rowCount,
    0,
  );
  assert.equal((await member.application()).application.status, "SUBMITTED");
  await h.pool.query(
    "ALTER TABLE blacklist_reports DROP CONSTRAINT fixture_interrupt",
  );
  await reportsTick(h.pool);
  assert.equal((await member.application()).application.status, "BLACKLISTED");
  assert.equal(
    (await h.pool.query("SELECT last_id FROM blacklist_checkpoint")).rows[0]
      .last_id,
    id(100),
  );
  await h.restart();
  history[0]!.content = "This report was edited.";
  history.splice(99, 1); // Remove an already-imported report from Discord.
  await reportsTick(h.pool);
  await reportsTick(h.pool);
  assert.deepEqual(pagesRead, ["0", "0", id(100), id(102)]);
  const reports = (await admin.request("/api/blacklist")).data.reports;
  assert.deepEqual(
    reports.map((r: { message_id: string }) => r.message_id).sort(),
    [id(1), id(100), id(101)],
  );
  const original = reports.find(
    (r: { message_id: string }) => r.message_id === id(1),
  );
  assert.equal(original.character_name, "Silver Ｒidge");
  assert.equal(original.character_key, "silver ridge");
  assert.equal(original.reporter_id, reporter);
  assert.equal(original.reason, "Officer's original record.");
  assert.equal(original.reported_at, history[0]!.timestamp);
  assert.equal(original.channel_id, channel);
  assert.equal(original.guild_id, guild);

  // A previously valid application can become blocked when a revision selects a reported character.
  const revising = new Client(h.cfg.origin);
  await revising.signup("Clear Character");
  const appId = (await revising.application()).application.id;
  for (const action of ["reject", "reopen"]) {
    assert.equal(
      (
        await admin.request(`/api/admin/applications/${appId}/${action}`, {
          note: "Staff review",
        })
      ).status,
      200,
    );
  }
  const rules = (await revising.request("/api/rules")).data;
  const revised = await revising.request("/api/application", {
    characterName: "Reported Character",
    motivation: "My main character.",
    acceptRules: true,
    rulesId: rules.id,
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.data.application.status, "BLACKLISTED");
  assert.equal(revised.data.application.revision, 2);
  assert.equal(
    JSON.stringify(revised.data).includes("Private revision fixture"),
    false,
  );
  assert.equal(
    (
      await h.pool.query(
        `SELECT 1 FROM discord_jobs j JOIN submissions s ON s.id=j.submission_id
    WHERE s.application_id=$1 AND s.revision=2`,
        [appId],
      )
    ).rowCount,
    0,
  );

  const pending = new Client(h.cfg.origin);
  const email = "pending-correction@example.test";
  await pending.init();
  assert.equal(
    (
      await pending.request("/api/auth/register", {
        email,
        password: PASS,
        characterName: "Pending Correction",
        motivation: "I want to join.",
        acceptRules: true,
        rulesId: rules.id,
      })
    ).status,
    201,
  );
  const token = await mailToken(h.pool, email);
  const pendingApplication = async () =>
    (
      await h.pool.query(
        "SELECT a.status,u.email_verified_at FROM applications a JOIN users u ON u.id=a.user_id WHERE u.email=$1",
        [email],
      )
    ).rows[0];
  assert.deepEqual(await pendingApplication(), {
    status: "BLACKLISTED",
    email_verified_at: null,
  });

  // A correction during an armory lookup must discard the obsolete result and its warning.
  const checked: string[] = [];
  await scanTick(h.pool, async (name) => {
    checked.push(name);
    if (name === "Pending Correction") {
      const result = await admin.request(`/api/blacklist/${id(100)}/void`, {
        reason: "Corrected in review.",
      });
      assert.equal(result.status, 200);
      return "MATCH";
    }
    return name === "Silver Ｒidge" ? "MATCH" : "PROFILE_NOT_FOUND";
  });
  assert.deepEqual(checked.sort(), [
    "Pending Correction",
    "Reported Character",
    "Silver Ｒidge",
  ]);
  assert.equal(
    (
      await h.pool.query(
        "SELECT 1 FROM blacklist_checks WHERE character_key='pending correction'",
      )
    ).rowCount,
    0,
  );
  assert.deepEqual(await pendingApplication(), {
    status: "PENDING_EMAIL",
    email_verified_at: null,
  });
  assert.equal(
    (await pending.request("/api/auth/verify-email", { token })).status,
    200,
  );
  await pending.login(email);
  assert.equal((await pending.application()).application.status, "SUBMITTED");
  await scanTick(h.pool, async () => {
    throw new Error("Character scanned twice in one night");
  });
  assert.equal(
    (await h.pool.query("SELECT character_key FROM blacklist_warnings")).rows[0]
      .character_key,
    "silver ridge",
  );
  await warningTick(h.pool, h.cfg.origin);
  simulateLostResponse = true;
  await assert.rejects(
    warningTick(h.pool, h.cfg.origin),
    /Lost delivery response/,
  );
  assert.equal(sent.length, 1);
  assert.equal(
    (await h.pool.query("SELECT delivered_id FROM blacklist_warnings")).rows[0]
      .delivered_id,
    null,
  );
  await h.restart();
  pagesRead.length = 0;
  simulateLostResponse = false;
  await Promise.all([
    warningTick(h.pool, h.cfg.origin),
    warningTick(h.pool, h.cfg.origin),
  ]);
  assert.deepEqual(pagesRead, [id(102), id(202)]);
  assert.deepEqual(
    (await h.pool.query("SELECT delivered_id FROM blacklist_warnings")).rows,
    [{ delivered_id: id(204) }],
  );
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.content.includes("Silver Ｒidge"));
  assert.equal(sent[0]!.content.includes(original.reason), false);
  console.log(
    "Moderation history rollback, restart, blocked revision, scan correction and paginated warning recovery passed.",
  );
} finally {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await h.stop();
}
