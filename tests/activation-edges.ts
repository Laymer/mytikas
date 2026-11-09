import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  harness,
  Client,
  PASS,
  mailToken,
  character,
  html,
} from "./harness.js";
import {
  emailLimit,
  emailTick,
  queueMail,
  captureTransport,
  smtpSender,
} from "../src/email.js";
import { transaction } from "../src/db.js";
import { classTick, fetchClass, profileClass } from "../src/classes.js";
import { config } from "../src/config.js";
const h = await harness(),
  admin = new Client(h.cfg.origin),
  anon = new Client(h.cfg.origin);
const clear = async () => {
  await h.pool.query("DELETE FROM auth_limits");
  await h.pool.query("DELETE FROM email_limits");
};
try {
  await admin.login();
  await anon.init();
  const c = await h.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("CREATE SCHEMA upgrade_fixture");
    await c.query("SET LOCAL search_path=upgrade_fixture");
    await c.query(await readFile("migrations/001_initial.sql", "utf8"));
    await c.query(
      "INSERT INTO users(email,password_hash) VALUES('legacy@example.test','legacy-hash')",
    );
    await c.query(
      await readFile("migrations/004_activation_rosters.sql", "utf8"),
    );
    const u = (await c.query("SELECT * FROM users")).rows[0];
    assert.equal(u.activation_exempt, true);
    assert.equal(u.email_verified_at, null);
    assert.equal(u.auth_version, 0);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
  const member = new Client(h.cfg.origin);
  await member.signup("Edge Summit");
  const id = (await member.application()).application.id;
  await h.pool.query(
    "UPDATE sessions SET sess=(sess::jsonb - 'authVersion')::json WHERE sess->>'userId'=(SELECT id::text FROM users WHERE email='edge.summit@example.test')",
  );
  assert.ok((await member.init()).data.user);
  await clear();
  await anon.request("/api/auth/forgot-password", {
    email: "edge.summit@example.test",
  });
  const old = await mailToken(h.pool, "edge.summit@example.test", "reset");
  await h.pool.query(
    "UPDATE email_limits SET last_at=now()-interval '61 seconds'",
  );
  await anon.request("/api/auth/forgot-password", {
    email: "edge.summit@example.test",
  });
  const replacement = await mailToken(
    h.pool,
    "edge.summit@example.test",
    "reset",
  );
  assert.notEqual(old, replacement);
  assert.equal(
    (
      await anon.request("/api/auth/reset-password", {
        token: old,
        password: PASS,
        confirmPassword: PASS,
      })
    ).status,
    400,
  );
  const login = new Client(h.cfg.origin);
  await login.init();
  await Promise.all([
    login.request("/api/auth/login", {
      email: "edge.summit@example.test",
      password: PASS,
    }),
    anon.request("/api/auth/reset-password", {
      token: replacement,
      password: "Reset-race-password-123",
      confirmPassword: "Reset-race-password-123",
    }),
  ]);
  assert.equal((await login.init()).data.user, null);
  assert.equal((await member.init()).data.user, null);
  await clear();
  for (const token of [null, "bad", "0".repeat(64)])
    assert.equal(
      (await anon.request("/api/auth/verify-email", { token })).status,
      400,
    );
  const rules = (await anon.request("/api/rules")).data;
  const body = {
    email: "expire@example.test",
    password: PASS,
    characterName: "Expire Summit",
    motivation: "Test expiry",
    rulesId: rules.id,
    acceptRules: true,
  };
  assert.equal((await anon.request("/api/auth/register", body)).status, 201);
  const expired = await mailToken(h.pool, body.email);
  await h.pool.query(
    "UPDATE email_tokens SET expires_at=now()-interval '1 second' WHERE user_id=(SELECT id FROM users WHERE email=$1)",
    [body.email],
  );
  assert.equal(
    (await anon.request("/api/auth/verify-email", { token: expired })).status,
    400,
  );
  const ack = (
    await anon.request("/api/auth/resend-verification", { email: body.email })
  ).data;
  assert.equal(await mailToken(h.pool, body.email), expired);
  await clear();
  assert.deepEqual(
    (await anon.request("/api/auth/resend-verification", { email: body.email }))
      .data,
    ack,
  );
  assert.notEqual(await mailToken(h.pool, body.email), expired);
  await clear();
  assert.equal(
    (
      await anon.request("/api/auth/correct-pending-email", {
        email: body.email,
        newEmail: "new@example.test",
        password: "wrong",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await anon.request("/api/auth/correct-pending-email", {
        email: body.email,
        newEmail: "new@example.test",
        password: PASS,
      })
    ).status,
    429,
  );
  await clear();
  assert.equal(
    (
      await anon.request("/api/auth/correct-pending-email", {
        email: "missing@example.test",
        newEmail: "new@example.test",
      })
    ).status,
    400,
  );
  await clear();
  assert.equal(
    (
      await anon.request("/api/auth/correct-pending-email", {
        email: "admin@example.test",
        newEmail: "new@example.test",
        password: PASS,
      })
    ).status,
    400,
  );
  await clear();
  await anon.request("/api/auth/resend-verification", {
    email: "admin@example.test",
  });
  assert.equal(
    (
      await h.pool.query("SELECT * FROM email_tokens WHERE user_id=$1", [
        h.admin.id,
      ])
    ).rowCount,
    0,
  );
  await clear();
  for (let i = 0; i < 5; i++) {
    assert.equal(
      await emailLimit(h.pool, "limited@example.test", `ip-${i}`),
      true,
    );
    await h.pool.query(
      "UPDATE email_limits SET last_at=now()-interval '61 seconds'",
    );
  }
  assert.equal(
    await emailLimit(h.pool, "limited@example.test", "another"),
    false,
  );
  await clear();
  for (let i = 0; i < 20; i++)
    assert.equal(
      await emailLimit(h.pool, `person${i}@example.test`, "shared-ip"),
      true,
    );
  assert.equal(
    await emailLimit(h.pool, "person21@example.test", "shared-ip"),
    false,
  );
  await h.pool.query(
    "UPDATE email_limits SET reset_at=now()-interval '1 second',last_at=now()-interval '61 seconds'",
  );
  assert.equal(
    await emailLimit(h.pool, "person21@example.test", "shared-ip"),
    true,
  );
  await clear();
  const originalKey = h.cfg.emailOutboxKey;
  h.cfg.emailOutboxKey = undefined;
  assert.equal(
    (await anon.request("/api/auth/forgot-password", { email: body.email }))
      .status,
    503,
  );
  h.cfg.emailOutboxKey = originalKey;
  await admin.request(`/api/admin/applications/${id}/approve`, {});
  await admin.request(`/api/admin/applications/${id}/join`, {});
  for (const r of [
    { revision: 0, slots: [] },
    {
      revision: 0,
      slots: Array(10).fill({ position: 0, role: "INVALID", memberId: null }),
    },
  ])
    assert.equal((await admin.request("/api/admin/rosters/10", r)).status, 400);
  for (const [path, body] of [
    ["/api/admin/roster-members", undefined],
    ["/api/admin/rosters/10", {}],
    [`/api/admin/members/${id}/class`, { class: "Mage" }],
    [`/api/admin/members/${id}/refresh-class`, {}],
  ] as const)
    assert.equal((await anon.request(path, body)).status, 403);
  assert.equal(
    (await admin.request(`/api/admin/members/${id}/class`, { class: "Monk" }))
      .status,
    400,
  );
  assert.equal(
    (
      await admin.request(`/api/admin/members/${randomUUID()}/class`, {
        class: "Mage",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await admin.request(
        `/api/admin/members/${randomUUID()}/refresh-class`,
        {},
      )
    ).status,
    404,
  );
  const roster = (await admin.request("/api/rosters")).data.rosters[0];
  roster.slots[0].memberId = randomUUID();
  assert.equal(
    (await admin.request("/api/admin/rosters/10", roster)).status,
    409,
  );
  roster.slots[0].memberId = id;
  await Promise.all([
    admin.request("/api/admin/rosters/10", roster),
    admin.request(`/api/admin/applications/${id}/remove`, {
      note: "Concurrent removal",
    }),
  ]);
  assert.equal(
    (
      await h.pool.query("SELECT * FROM roster_slots WHERE application_id=$1", [
        id,
      ])
    ).rowCount,
    0,
  );
  await admin.request(`/api/admin/applications/${id}/restore`, {
    note: "Returned",
  });
  await h.pool.query(
    "INSERT INTO applications(user_id,character_name,character_key,status) VALUES($1,'Moderator Summit','moderator summit','JOINED'),($2,'Admin Summit','admin summit','JOINED')",
    [h.moderator.id, h.admin.id],
  );
  const mod = new Client(h.cfg.origin);
  await mod.login("mod@example.test");
  assert.equal((await mod.request("/api/rosters")).status, 200);
  assert.equal(
    (await mod.request("/api/admin/rosters/10", roster)).status,
    403,
  );
  const adminApp = (
    await h.pool.query("SELECT id FROM applications WHERE user_id=$1", [
      h.admin.id,
    ])
  ).rows[0].id;
  await admin.request(`/api/admin/applications/${adminApp}/remove`, {
    note: "Admin remains staff",
  });
  assert.equal((await admin.init()).data.canViewRosters, true);
  const transport =
    (raw: string, status = 200) =>
    async () =>
      new Response(raw, { status });
  assert.equal(
    await fetchClass(
      "Class Summit",
      transport(
        html(character("Class Summit", { class: { enum: "PALADIN" } })),
      ),
    ),
    "Paladin",
  );
  await assert.rejects(fetchClass("Class Summit", transport("", 503)));
  await assert.rejects(fetchClass("Class Summit", transport("bad")));
  for (const patch of [{ region: "eu" }, { ruleset: { slug: "pve" } }])
    assert.throws(() =>
      profileClass(character("Class Summit", patch), "Class Summit"),
    );
  assert.equal(
    profileClass(
      character("Class Summit", { class: { enum: "MONK" } }),
      "Class Summit",
    ),
    null,
  );
  assert.equal(
    profileClass(
      character("Class Summit", { guild: null, class: { enum: "MAGE" } }),
      "Class Summit",
    ),
    "Mage",
  );
  await h.pool.query("DELETE FROM class_jobs");
  await admin.request(`/api/admin/members/${id}/refresh-class`, {});
  await classTick(h.pool, async () => {
    throw new Error("Unavailable");
  });
  assert.equal(
    (await h.pool.query("SELECT attempts FROM class_jobs")).rows[0].attempts,
    1,
  );
  await h.pool.query(
    "UPDATE class_jobs SET available_at=now(),attempts=5,lease_until=now()-interval '1 second'",
  );
  await classTick(h.pool, async () => {
    throw new Error("Unavailable");
  });
  assert.equal((await h.pool.query("SELECT * FROM class_jobs")).rowCount, 0);
  assert.equal(await classTick(h.pool), false);
  await admin.request(`/api/admin/members/${id}/refresh-class`, {});
  await classTick(h.pool, async () => {
    await admin.request(`/api/admin/members/${id}/refresh-class`, {});
    return "Mage";
  });
  assert.equal(
    (await h.pool.query("SELECT attempts FROM class_jobs")).rows[0].attempts,
    0,
  );
  await classTick(h.pool, async () => null);
  await h.pool.query("UPDATE email_jobs SET status='CANCELLED',payload=NULL");
  const capture = captureTransport();
  await smtpSender({ ...h.cfg, demo: true })({
    to: "demo@example.test",
    subject: "demo",
    text: "isolated",
  });
  const enqueue = () =>
    transaction(h.pool, (c) =>
      queueMail(
        c,
        h.cfg,
        h.admin.id,
        { to: "admin@example.test", subject: "Notice", text: "Isolated" },
        new Date(Date.now() + 60000),
      ),
    );
  await enqueue();
  await h.pool.query(
    "UPDATE email_jobs SET lease_until=now()+interval '1 minute',lease_token=gen_random_uuid() WHERE status='PENDING'",
  );
  assert.equal(await emailTick(h.pool, h.cfg, capture.send), false);
  await h.pool.query(
    "UPDATE email_jobs SET lease_until=now()-interval '1 second' WHERE status='PENDING'",
  );
  assert.equal(await emailTick(h.pool, h.cfg, capture.send), true);
  assert.equal(capture.messages.length, 1);
  await enqueue();
  await emailTick(h.pool, h.cfg, async () => {
    throw { responseCode: 550 };
  });
  assert.equal(
    (
      await h.pool.query(
        "SELECT * FROM email_jobs WHERE status='FAILED' AND payload IS NULL",
      )
    ).rowCount,
    1,
  );
  await enqueue();
  await h.pool.query("UPDATE email_jobs SET attempts=7 WHERE status='PENDING'");
  await emailTick(h.pool, h.cfg, async () => {
    throw new Error("Offline");
  });
  assert.equal(
    (await h.pool.query("SELECT * FROM email_jobs WHERE status='PENDING'"))
      .rowCount,
    0,
  );
  await enqueue();
  await emailTick(
    h.pool,
    { ...h.cfg, emailOutboxKey: undefined },
    capture.send,
  );
  let received = "";
  const smtp = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 fixture\r\n");
    socket.on("data", (data) => {
      received += data;
      if (data.toString().startsWith("EHLO")) socket.write("250 fixture\r\n");
      else if (data.toString().startsWith("STARTTLS"))
        socket.write("454 TLS unavailable\r\n");
      else socket.end();
    });
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      smtpSender({
        ...h.cfg,
        smtpHost: "127.0.0.1",
        smtpPort: (smtp.address() as any).port,
        emailFrom: "guild@example.test",
        smtpUser: "fixture",
        smtpPassword: "fixture",
      })({
        to: "recipient@example.test",
        subject: "Private",
        text: "Never send this",
      }),
    );
    assert.ok(!received.includes("Never send this"));
  } finally {
    await new Promise<void>((r) => smtp.close(() => r()));
  }
  const env = { ...process.env };
  try {
    process.env.DATABASE_URL = h.cfg.databaseUrl;
    process.env.SESSION_SECRET = h.cfg.sessionSecret;
    process.env.EMAIL_OUTBOX_KEY = "bad";
    assert.throws(config, /EMAIL_OUTBOX_KEY/);
    process.env.EMAIL_OUTBOX_KEY = "12".repeat(32);
    process.env.SMTP_PORT = "0";
    assert.throws(config, /SMTP_PORT/);
    process.env.SMTP_PORT = "587";
    process.env.EMAIL_OUTBOX_KEY = h.cfg.sessionSecret;
    assert.throws(config, /independent/);
    delete process.env.EMAIL_OUTBOX_KEY;
    process.env.DEPLOYMENT_PROFILE = "cloud";
    process.env.INGRESS_MODE = "proxy-loopback";
    process.env.APP_ORIGIN = "https://example.test";
    process.env.PUBLIC_SITE_ORIGIN = "https://example.test";
    assert.throws(config, /Production requires/);
  } finally {
    process.env = env;
  }
  console.log(
    "Activation expiry/replacement/throttling, upgrade compatibility, race safety, membership permissions, class retries and SMTP TLS refusal passed.",
  );
} finally {
  await h.stop();
}
