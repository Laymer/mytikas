import assert from "node:assert/strict";
import { harness, Client, PASS, mailToken, character } from "./harness.js";
import { emailTick, unseal, seal } from "../src/email.js";
import { classTick, profileClass } from "../src/classes.js";
const h = await harness();
const client = () => new Client(h.cfg.origin),
  admin = client(),
  applicant = client();
async function register(c: Client, name: string, address: string) {
  await c.init();
  const rules = (await c.request("/api/rules")).data;
  return c.request("/api/auth/register", {
    email: address,
    password: PASS,
    characterName: name,
    motivation: "Ready to raid.",
    rulesId: rules.id,
    acceptRules: true,
  });
}
try {
  await admin.login();
  assert.equal(
    (await register(applicant, "Pending Summit", "pending@example.test"))
      .status,
    201,
  );
  assert.equal((await applicant.init()).data.user, null);
  assert.equal(
    (
      await applicant.request("/api/auth/login", {
        email: "pending@example.test",
        password: PASS,
      })
    ).status,
    403,
  );
  const pending = (
    await h.pool.query(
      "SELECT * FROM applications WHERE character_key='pending summit'",
    )
  ).rows[0];
  assert.equal(pending.status, "PENDING_EMAIL");
  assert.equal(
    (await admin.request(`/api/admin/applications/${pending.id}`)).status,
    404,
  );
  assert.equal(
    (await admin.request("/api/admin/applications?status=ALL")).data
      .applications.length,
    0,
  );
  assert.equal((await h.pool.query("SELECT * FROM discord_jobs")).rowCount, 0);
  const first = await mailToken(h.pool, "pending@example.test");
  assert.equal(
    (
      await applicant.request(
        "/api/auth/verify-email",
        { token: first },
        { "X-CSRF-Token": "" },
      )
    ).status,
    403,
  );
  await h.pool.query(
    "UPDATE email_limits SET last_at=now()-interval '61 seconds'",
  );
  const correction = await applicant.request(
    "/api/auth/correct-pending-email",
    {
      email: "pending@example.test",
      newEmail: "correct@example.test",
      password: PASS,
    },
  );
  assert.equal(correction.status, 200);
  assert.equal(
    (await applicant.request("/api/auth/verify-email", { token: first }))
      .status,
    400,
  );
  const token = await mailToken(h.pool, "correct@example.test");
  const rulesBefore = (
    await h.pool.query(
      "SELECT rules_id FROM submissions WHERE application_id=$1",
      [pending.id],
    )
  ).rows[0].rules_id;
  await admin.request("/api/admin/rules", {
    content: "New rules after registration.",
  });
  const other = client();
  await other.init();
  const results = await Promise.all([
    applicant.request("/api/auth/verify-email", { token }),
    other.request("/api/auth/verify-email", { token }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(
    (
      await h.pool.query(
        "SELECT rules_id FROM submissions WHERE application_id=$1",
        [pending.id],
      )
    ).rows[0].rules_id,
    rulesBefore,
  );
  assert.equal((await h.pool.query("SELECT * FROM discord_jobs")).rowCount, 1);
  await applicant.login("correct@example.test");
  const session = client();
  await session.login("correct@example.test");
  await h.pool.query(
    "UPDATE email_limits SET last_at=now()-interval '61 seconds'",
  );
  const unknown = await other.request("/api/auth/forgot-password", {
    email: "unknown@example.test",
  });
  const known = await other.request("/api/auth/forgot-password", {
    email: "correct@example.test",
  });
  assert.deepEqual(known.data, unknown.data);
  const reset = await mailToken(h.pool, "correct@example.test", "reset");
  assert.equal(
    (await other.request("/api/auth/verify-email", { token: reset })).status,
    400,
  );
  const newPass = "A-different-password-123";
  assert.equal(
    (
      await other.request("/api/auth/reset-password", {
        token: reset,
        password: newPass,
        confirmPassword: PASS,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await other.request("/api/auth/reset-password", {
        token: reset,
        password: newPass,
        confirmPassword: newPass,
      })
    ).status,
    200,
  );
  assert.equal((await applicant.init()).data.user, null);
  assert.equal((await session.init()).data.user, null);
  assert.equal(
    (
      await other.request("/api/auth/reset-password", {
        token: reset,
        password: PASS,
        confirmPassword: PASS,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await other.request("/api/auth/login", {
        email: "correct@example.test",
        password: PASS,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await other.request("/api/auth/login", {
        email: "correct@example.test",
        password: newPass,
      })
    ).status,
    200,
  );
  assert.equal((await other.request("/api/rosters")).status, 403);
  assert.equal((await client().request("/api/rosters")).status, 403);
  await admin.request(`/api/admin/applications/${pending.id}/approve`, {});
  await admin.request(`/api/admin/applications/${pending.id}/join`, {});
  assert.equal((await other.init()).data.canViewRosters, true);
  const rosters = (await admin.request("/api/rosters")).data.rosters;
  assert.deepEqual(
    rosters.map((r: any) => [r.size, r.slots.length]),
    [
      [10, 10],
      [20, 20],
      [40, 40],
    ],
  );
  assert.deepEqual(
    rosters.map((r: any) =>
      ["TANK", "HEALER", "DPS"].map(
        (role) => r.slots.filter((s: any) => s.role === role).length,
      ),
    ),
    [
      [2, 3, 5],
      [3, 5, 12],
      [4, 11, 25],
    ],
  );
  const r = rosters[0];
  r.slots[0].memberId = pending.id;
  r.slots[0].role = "DPS";
  assert.equal((await other.request("/api/admin/rosters/10", r)).status, 403);
  assert.equal((await admin.request("/api/admin/rosters/10", r)).status, 200);
  assert.equal((await admin.request("/api/admin/rosters/10", r)).status, 409);
  r.revision++;
  r.slots[1].memberId = pending.id;
  assert.equal((await admin.request("/api/admin/rosters/10", r)).status, 400);
  r.slots[1].memberId = null;
  const mod = client();
  await mod.login("mod@example.test");
  assert.equal((await mod.request("/api/rosters")).status, 403);
  assert.equal(
    (
      await mod.request(`/api/admin/applications/${pending.id}/remove`, {
        note: "No",
      })
    ).status,
    403,
  );
  assert.equal(
    (await admin.request(`/api/admin/applications/${pending.id}/remove`, {}))
      .status,
    400,
  );
  assert.equal(
    (
      await admin.request(`/api/admin/applications/${pending.id}/remove`, {
        note: "Taking a break",
      })
    ).status,
    200,
  );
  assert.equal((await other.request("/api/rosters")).status, 403);
  assert.equal((await admin.request("/api/admin/rosters/10", r)).status, 409);
  assert.ok(
    (await admin.request("/api/rosters")).data.rosters[0].slots.every(
      (s: any) => !s.memberId,
    ),
  );
  await admin.request(`/api/admin/applications/${pending.id}/restore`, {
    note: "Returned",
  });
  assert.equal((await other.request("/api/rosters")).status, 200);
  assert.equal(
    profileClass(
      character("Class Summit", { class: { enum: "WARRIOR" } }),
      "Class Summit",
    ),
    "Warrior",
  );
  assert.equal(profileClass(character("Class Summit"), "Class Summit"), null);
  assert.throws(() => profileClass(character("Other Summit"), "Class Summit"));
  await admin.request(`/api/admin/members/${pending.id}/class`, {
    class: "Mage",
  });
  await classTick(h.pool, async () => "Warrior");
  let member = (await admin.request("/api/admin/roster-members")).data
    .members[0];
  assert.equal(member.class, "Mage");
  assert.equal(member.armory_class, "Warrior");
  await admin.request(`/api/admin/members/${pending.id}/class`, {
    class: null,
  });
  member = (await admin.request("/api/admin/roster-members")).data.members[0];
  assert.equal(member.class, "Warrior");
  await admin.request(`/api/admin/members/${pending.id}/refresh-class`, {});
  await classTick(h.pool, async () => {
    await admin.request(`/api/admin/applications/${pending.id}/remove`, {
      note: "While fetching",
    });
    return "Priest";
  });
  assert.equal(
    (
      await h.pool.query(
        "SELECT status,armory_class FROM applications WHERE id=$1",
        [pending.id],
      )
    ).rows[0].status,
    "REMOVED",
  );
  assert.equal(
    (
      await h.pool.query("SELECT armory_class FROM applications WHERE id=$1", [
        pending.id,
      ])
    ).rows[0].armory_class,
    "Warrior",
  );
  const captured: any[] = [];
  while (
    await emailTick(h.pool, h.cfg, async (mail) => {
      captured.push(mail);
    })
  );
  assert.ok(captured.some((m) => m.subject.includes("password changed")));
  assert.equal(
    (
      await h.pool.query(
        "SELECT * FROM email_jobs WHERE status<>'PENDING' AND payload IS NOT NULL",
      )
    ).rowCount,
    0,
  );
  const sample = { to: "x@example.test", subject: "secret", text: "token" };
  assert.deepEqual(
    unseal(seal(sample, h.cfg.emailOutboxKey!), h.cfg.emailOutboxKey!),
    sample,
  );
  assert.throws(() =>
    unseal(seal(sample, h.cfg.emailOutboxKey!), "34".repeat(32)),
  );
  const pendingClient = client();
  await h.pool.query("DELETE FROM auth_limits");
  await register(pendingClient, "Reset Pending", "resetpending@example.test");
  await h.pool.query(
    "UPDATE email_limits SET last_at=now()-interval '61 seconds'",
  );
  await pendingClient.request("/api/auth/forgot-password", {
    email: "resetpending@example.test",
  });
  const pendingReset = await mailToken(
    h.pool,
    "resetpending@example.test",
    "reset",
  );
  assert.equal(
    (
      await pendingClient.request("/api/auth/reset-password", {
        token: pendingReset,
        password: newPass,
        confirmPassword: newPass,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await pendingClient.request("/api/auth/login", {
        email: "resetpending@example.test",
        password: newPass,
      })
    ).status,
    403,
  );
  await emailTick(h.pool, h.cfg, async () => {
    throw new Error("SMTP offline");
  });
  assert.ok(
    (
      await h.pool.query(
        "SELECT * FROM email_jobs WHERE status='PENDING' AND attempts=1 AND payload IS NOT NULL",
      )
    ).rowCount,
  );
  await h.pool.query(
    "UPDATE email_jobs SET expires_at=now()-interval '1 second' WHERE status='PENDING'",
  );
  await emailTick(h.pool, h.cfg, async () => {
    throw new Error("Must not send");
  });
  assert.equal(
    (await h.pool.query("SELECT * FROM email_jobs WHERE payload IS NOT NULL"))
      .rowCount,
    0,
  );
  console.log(
    "Activation, correction, concurrent consumption, reset/session revocation, roster permissions/conflicts/removal, classes and encrypted delivery passed.",
  );
} finally {
  await h.stop();
}
