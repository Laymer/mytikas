import assert from "node:assert/strict";
import { harness, Client, character, html, PASS } from "./harness.js";
import {
  checkMembership,
  parseProfile,
  membershipResult,
  limitedText,
  verifyMembership,
  profileUrl,
} from "../src/armory.js";
import { tick } from "../src/worker.js";
import { deliverDiscord } from "../src/discord.js";
import { migrate } from "../src/migrate.js";
import { config } from "../src/config.js";
const h = await harness();
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}
const client = () => new Client(h.cfg.origin);
const admin = client(),
  mod = client(),
  alice = client();
async function action(c: Client, id: string, verb: string, body = {}) {
  return c.request(`/api/admin/applications/${id}/${verb}`, body);
}
try {
  console.log(
    "Isolated PostgreSQL:",
    (await h.pool.query("SHOW server_version")).rows[0].server_version,
  );
  await admin.login();
  await mod.login("mod@example.test");
  await test("migrations are idempotent; readiness requires the database", async () => {
    await migrate(h.pool);
    assert.equal((await admin.request("/api/health")).status, 200);
    assert.equal(
      (await h.pool.query("SELECT count(*) FROM rules")).rows[0].count,
      "1",
    );
  });
  await test("signup is atomic, normalizes identity, ignores role escalation, and rotates the session", async () => {
    await alice.init();
    const oldCookie = alice.cookie;
    const r = await alice.signup("Alice Summit", " ALICE@EXAMPLE.TEST ", {
      role: "ADMIN",
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.role, "USER");
    assert.notEqual(oldCookie, alice.cookie);
    assert.match(r.headers.get("set-cookie")!, /HttpOnly/);
    assert.match(r.headers.get("set-cookie")!, /SameSite=Lax/);
    const a = await alice.application();
    assert.equal(a.application.status, "SUBMITTED");
    assert.equal(a.application.character_key, "alice summit");
    assert.equal(a.submissions.length, 1);
    assert.equal(a.events.length, 2);
    const {
      rows: [job],
    } = await h.pool.query(
      "SELECT * FROM discord_jobs WHERE submission_id=$1",
      [a.submissions[0].id],
    );
    assert.equal(job.status, "PENDING");
  });
  const id = (await alice.application()).application.id;
  await test("rejects missing/overlong motivation, rules acceptance and malformed names without partial accounts", async () => {
    for (const extra of [
      { motivation: "" },
      { motivation: "   " },
      { motivation: "x".repeat(301) },
      { acceptRules: false },
      { acceptRules: "true" },
      { characterName: "SurnameMissing" },
      { characterName: "Name <script>" },
      { password: "short" },
    ]) {
      const c = client();
      assert.equal(
        (await c.signup("Invalid Test", undefined, extra)).status,
        400,
      );
    }
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*) FROM users WHERE email='invalid.test@example.test'",
        )
      ).rows[0].count,
      "0",
    );
  });
  await test("unique normalized email and character identities roll back conflicting registrations", async () => {
    assert.equal(
      (await client().signup("Other Summit", "alice@example.test")).status,
      409,
    );
    assert.equal(
      (await client().signup("ALICE   SUMMIT", "other@example.test")).status,
      409,
    );
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*) FROM users WHERE email='other@example.test'",
        )
      ).rows[0].count,
      "0",
    );
  });
  await test("authentication, CSRF, origin checks, and private routes protect application data", async () => {
    const stranger = client();
    await stranger.init();
    assert.equal((await stranger.request("/api/application")).status, 401);
    assert.equal(
      (
        await stranger.request(
          "/api/auth/login",
          { email: "admin@example.test", password: PASS },
          { "X-CSRF-Token": "" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await stranger.request(
          "/api/auth/login",
          { email: "admin@example.test", password: PASS },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await alice.request(`/api/admin/applications/${id}`)).status,
      403,
    );
    assert.equal((await alice.request("/api/application/" + id)).status, 404);
    assert.equal(
      (await alice.request("/api/admin/rules", { content: "bad" })).status,
      403,
    );
    assert.equal(
      (await mod.request("/api/admin/rules", { content: "bad" })).status,
      403,
    );
    assert.equal((await mod.request("/api/admin/users")).status, 403);
    assert.equal(
      (
        await mod.request(`/api/admin/users/${h.admin.id}/role`, {
          role: "USER",
        })
      ).status,
      403,
    );
  });
  await test("immutable rules and submissions; stale acceptance is rejected atomically", async () => {
    const old = (await alice.application()).submissions[0];
    assert.equal(
      (
        await admin.request("/api/admin/rules", {
          content: "New published rules. Be respectful.",
        })
      ).status,
      201,
    );
    assert.equal(
      (await alice.application()).submissions[0].rules_content,
      old.rules_content,
    );
    const c = client();
    assert.equal(
      (await c.signup("Stale Rules", undefined, { rulesId: old.rules_id }))
        .status,
      409,
    );
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*) FROM users WHERE email='stale.rules@example.test'",
        )
      ).rows[0].count,
      "0",
    );
    await assert.rejects(
      h.pool.query("UPDATE rules SET content=$1 WHERE id=$2", [
        "tampered",
        old.rules_id,
      ]),
      /immutable/,
    );
    await assert.rejects(
      h.pool.query("DELETE FROM submissions WHERE id=$1", [old.id]),
      /immutable/,
    );
  });
  await test("submitted applications cannot be edited, joined directly, or reopened directly", async () => {
    const rules = (await alice.request("/api/rules")).data;
    assert.equal(
      (
        await alice.request("/api/application", {
          characterName: "Alice Summit",
          motivation: "Edit",
          rulesId: rules.id,
          acceptRules: true,
        })
      ).status,
      409,
    );
    assert.equal((await action(admin, id, "join")).status, 409);
    assert.equal((await action(admin, id, "reopen")).status, 409);
  });
  await test("rejection → reopening → revised resubmission preserves acceptance and history", async () => {
    assert.equal(
      (
        await action(mod, id, "reject", {
          note: "Please clarify your motivation.",
        })
      ).status,
      200,
    );
    assert.equal((await action(mod, id, "reopen")).status, 200);
    const rules = (await alice.request("/api/rules")).data;
    assert.equal(
      (
        await alice.request("/api/application", {
          characterName: "Alice Summit",
          motivation: "I would like to help guild groups.",
          rulesId: rules.id,
          acceptRules: true,
        })
      ).status,
      200,
    );
    const a = await alice.application();
    assert.equal(a.submissions.length, 2);
    assert.notEqual(a.submissions[0].rules_id, a.submissions[1].rules_id);
    assert.equal(a.events.length, 5);
    assert.equal(
      a.submissions[0].motivation,
      "I would like to help guild groups.",
    );
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*) FROM discord_jobs j JOIN submissions s ON s.id=j.submission_id WHERE s.application_id=$1",
          [id],
        )
      ).rows[0].count,
      "2",
    );
  });
  await test("staff approval → scheduled armory match joins without any browser request", async () => {
    assert.equal((await action(mod, id, "approve")).status, 200);
    assert.equal((await alice.application()).application.status, "APPROVED");
    await tick(h.pool, undefined, h.cfg.origin, h.verify);
    const a = await alice.application();
    assert.equal(a.application.status, "JOINED");
    assert.equal(a.application.joined_via, "ARMORY");
    assert.equal(a.events.at(-1).method, "ARMORY");
    assert.equal(a.application.next_check_at, null);
    assert.ok(
      !(await admin.request("/api/admin/applications")).data.applications.some(
        (a: any) => a.id === id,
      ),
    );
    assert.equal(
      (await alice.request("/api/application/check", {})).status,
      409,
    );
    assert.equal((await action(mod, id, "reopen")).status, 409);
  });
  await test("new account can see only its own application; login and logout invalidate old sessions", async () => {
    const bob = client();
    assert.equal((await bob.signup("Bob Ridge")).status, 201);
    assert.notEqual((await bob.application()).application.id, id);
    const oldCookie = bob.cookie;
    await bob.request("/api/auth/logout", {});
    const stolen = client();
    stolen.cookie = oldCookie;
    assert.equal((await stolen.request("/api/application")).status, 401);
    await bob.login("bob.ridge@example.test");
    assert.equal(
      (await bob.application()).application.character_name,
      "Bob Ridge",
    );
    const previous = bob.cookie;
    await bob.login("bob.ridge@example.test");
    assert.notEqual(bob.cookie, previous);
    stolen.cookie = previous;
    assert.equal((await stolen.request("/api/application")).status, 401);
  });
  const manual = client();
  await manual.signup("Manual Peak");
  const mid = (await manual.application()).application.id;
  await action(admin, mid, "approve");
  await test("armory structured data rejects wrong identity, region, ruleset, and substring guilds", async () => {
    for (const [patch, expected] of [
      [{ name: "Someone" }, "CHARACTER_MISMATCH"],
      [{ region: "eu" }, "REGION_MISMATCH"],
      [{ ruleset: { slug: "pve" } }, "RULESET_MISMATCH"],
      [{ guild: { name: "Olympus Mytikas fans" } }, "GUILD_MISMATCH"],
      [{ guild: null }, "GUILD_MISMATCH"],
      [{ surname: undefined }, "MALFORMED_PROFILE"],
    ] as const) {
      h.profiles.set("manual-peak", {
        character: character("Manual Peak", patch),
      });
      assert.equal(await h.verify("Manual Peak"), expected);
    }
    assert.equal(
      membershipResult(
        parseProfile(
          html(
            character("Manual Peak", {
              guild: { name: " OLYMPUS   MYTIKAS " },
            }),
          ),
        ),
        "manual peak",
      ),
      "MATCH",
    );
    assert.throws(() =>
      parseProfile("<script>characterProfileInitialState = alert(1)</script>"),
    );
    assert.equal(
      profileUrl("Àlice Summit"),
      "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/character/%C3%A0lice-summit",
    );
  });
  await test("HTTP failures, missing and malformed profiles, redirects, size limits and transport outages fail closed", async () => {
    for (const [status, expected] of [
      [404, "PROFILE_NOT_FOUND"],
      [403, "HTTP_403"],
      [503, "HTTP_503"],
      [302, "UNAVAILABLE"],
    ] as const) {
      h.profiles.set("manual-peak", { status });
      assert.equal(await h.verify("Manual Peak"), expected);
    }
    h.profiles.set("manual-peak", { raw: "<html>No profile</html>" });
    assert.equal(await h.verify("Manual Peak"), "MALFORMED_PROFILE");
    h.profiles.set("manual-peak", { raw: "x".repeat(2_000_001) });
    assert.equal(await h.verify("Manual Peak"), "RESPONSE_TOO_LARGE");
    await assert.rejects(
      limitedText(new Response("x".repeat(50)), 20),
      /RESPONSE_TOO_LARGE/,
    );
    assert.equal(
      await verifyMembership("Manual Peak", async () => {
        throw new Error("offline");
      }),
      "UNAVAILABLE",
    );
  });
  await test("armory timeout aborts an actual slow fixture request", async () => {
    h.profiles.set("timeout-profile", { delay: 10500 });
    const started = Date.now();
    assert.equal(await h.verify("Timeout Profile"), "UNAVAILABLE");
    assert.ok(Date.now() - started < 12000);
  });
  await test("failed membership check keeps approval; shared cooldown covers staff and owner", async () => {
    h.profiles.set("manual-peak", { status: 503 });
    assert.equal(
      (await manual.request("/api/application/check", {})).status,
      200,
    );
    const a = await manual.application();
    assert.equal(a.application.status, "APPROVED");
    assert.equal(a.application.check_result, "HTTP_503");
    assert.ok(a.application.next_check_at);
    assert.equal((await action(admin, mid, "check")).status, 429);
    assert.equal(
      (await manual.request("/api/application/check", {})).status,
      429,
    );
  });
  await test("manual joining wins over a slow armory check and history records one joined event", async () => {
    await h.pool.query(
      "UPDATE applications SET last_check_at=now()-interval '2 minutes' WHERE id=$1",
      [mid],
    );
    let finish!: (s: string) => void, started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const pending = checkMembership(h.pool, mid, async () => {
      started();
      return new Promise((r) => (finish = r));
    });
    await ready;
    assert.equal((await action(mod, mid, "check")).status, 429);
    assert.equal(
      (
        await action(mod, mid, "join", {
          note: "Invited and verified in game.",
        })
      ).status,
      200,
    );
    finish("MATCH");
    await pending;
    const a = await manual.application();
    assert.equal(a.application.status, "JOINED");
    assert.equal(a.application.joined_via, "MANUAL");
    assert.equal(
      a.events.filter((e: any) => e.to_status === "JOINED").length,
      1,
    );
  });
  await test("concurrent conflicting staff transitions cannot both commit", async () => {
    const b = client();
    await b.signup("Concurrent Summit");
    const bid = (await b.application()).application.id;
    const responses = await Promise.all([
      action(admin, bid, "approve"),
      action(mod, bid, "approve"),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (await b.application()).events.filter(
        (e: any) => e.to_status === "APPROVED",
      ).length,
      1,
    );
  });
  await test("last-admin protection and current database roles apply to existing sessions", async () => {
    assert.equal(
      (
        await admin.request(`/api/admin/users/${h.admin.id}/role`, {
          role: "USER",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await admin.request(`/api/admin/users/${h.moderator.id}/role`, {
          role: "USER",
        })
      ).status,
      200,
    );
    assert.equal((await mod.request("/api/admin/applications")).status, 403);
    assert.equal(
      (
        await admin.request(`/api/admin/users/${h.moderator.id}/role`, {
          role: "MODERATOR",
        })
      ).status,
      200,
    );
    assert.equal((await mod.request("/api/admin/applications")).status, 200);
  });
  await test("concurrent admin demotions leave exactly one administrator", async () => {
    await admin.request(`/api/admin/users/${h.moderator.id}/role`, {
      role: "ADMIN",
    });
    const results = await Promise.all([
      admin.request(`/api/admin/users/${h.admin.id}/role`, { role: "USER" }),
      mod.request(`/api/admin/users/${h.moderator.id}/role`, { role: "USER" }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (await h.pool.query("SELECT count(*) FROM users WHERE role='ADMIN'"))
        .rows[0].count,
      "1",
    );
    const remaining = results[0].status === 200 ? mod : admin;
    await remaining.request(`/api/admin/users/${h.admin.id}/role`, {
      role: "ADMIN",
    });
    await admin.request(`/api/admin/users/${h.moderator.id}/role`, {
      role: "MODERATOR",
    });
  });
  await test("Discord outage never rolls back signup; retries back off and payload excludes private fields", async () => {
    h.discord.status = 503;
    const c = client();
    assert.equal(
      (
        await c.signup("Discord Outage", "private@example.test", {
          motivation: "secret motivation",
        })
      ).status,
      201,
    );
    assert.equal(
      await deliverDiscord(h.pool, h.cfg.discordWebhook, h.cfg.origin),
      true,
    );
    const job = (
      await h.pool.query(
        "SELECT * FROM discord_jobs WHERE attempts>0 ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    assert.equal(job.status, "PENDING");
    assert.equal(job.last_error, "HTTP_503");
    assert.ok(new Date(job.available_at).getTime() > Date.now());
    const payload = h.discord.messages[0];
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.ok(payload.content.includes("/admin.html#"));
    assert.ok(!payload.content.includes("@example.test"));
    assert.ok(!payload.content.includes("motivation"));
    h.discord.status = 204;
    await h.pool.query(
      "UPDATE discord_jobs SET available_at=now()-interval '1 hour' WHERE id=$1",
      [job.id],
    );
    await deliverDiscord(h.pool, h.cfg.discordWebhook, h.cfg.origin);
    assert.equal(
      (
        await h.pool.query("SELECT status FROM discord_jobs WHERE id=$1", [
          job.id,
        ])
      ).rows[0].status,
      "DELIVERED",
    );
  });
  await test("Discord respects 429 retry timing globally, bounds attempts, and disables jobs without configuration", async () => {
    h.discord.status = 429;
    h.discord.retryAfter = 120;
    await deliverDiscord(h.pool, h.cfg.discordWebhook, h.cfg.origin);
    assert.equal(
      await deliverDiscord(h.pool, h.cfg.discordWebhook, h.cfg.origin),
      false,
    );
    const job = (
      await h.pool.query(
        "SELECT * FROM discord_jobs WHERE last_error='HTTP_429'",
      )
    ).rows[0];
    assert.ok(new Date(job.available_at).getTime() > Date.now() + 110000);
    const fresh = client();
    await fresh.signup("Rate Limited");
    assert.equal(
      await deliverDiscord(h.pool, h.cfg.discordWebhook, h.cfg.origin),
      false,
    );
    await h.pool.query("UPDATE discord_delivery_state SET not_before=now()");
    await h.pool.query(
      "UPDATE discord_jobs SET attempts=7,available_at=now()-interval '1 hour' WHERE id=$1",
      [job.id],
    );
    h.discord.status = 503;
    await deliverDiscord(h.pool, h.cfg.discordWebhook, h.cfg.origin);
    assert.equal(
      (
        await h.pool.query("SELECT status FROM discord_jobs WHERE id=$1", [
          job.id,
        ])
      ).rows[0].status,
      "FAILED",
    );
    const original = h.cfg.discordWebhook;
    h.cfg.discordWebhook = undefined;
    try {
      const c = client();
      await c.signup("No Notifications");
      const a = await c.application();
      assert.equal(
        (
          await h.pool.query(
            "SELECT status FROM discord_jobs WHERE submission_id=$1",
            [a.submissions[0].id],
          )
        ).rows[0].status,
        "DISABLED",
      );
      assert.equal(
        (await admin.request("/api/admin/applications")).data
          .notificationsEnabled,
        false,
      );
    } finally {
      h.cfg.discordWebhook = original;
    }
  });
  await test("auth attempts are rate limited and stored in PostgreSQL", async () => {
    await h.pool.query("DELETE FROM auth_limits");
    const c = client();
    await c.init();
    for (let i = 0; i < 12; i++)
      assert.equal(
        (
          await c.request("/api/auth/login", {
            email: "missing@example.test",
            password: PASS,
          })
        ).status,
        401,
      );
    const result = await c.request("/api/auth/login", {
      email: "missing@example.test",
      password: PASS,
    });
    assert.equal(result.status, 429);
    assert.equal(result.headers.get("retry-after"), "900");
  });
  await test("database and application restart preserve login sessions, rules, applications and history", async () => {
    const before = await alice.application();
    await h.restart();
    const after = await alice.application();
    assert.deepEqual(after, before);
    assert.equal((await admin.request("/api/auth/me")).data.user.role, "ADMIN");
    assert.equal((await admin.request("/api/rules")).data.id, 2);
  });
  console.log(
    `\n${passed} integration checks passed. Fixtures are isolated; no live Discord or armory calls were made.`,
  );
} finally {
  await h.stop();
}
