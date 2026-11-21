import assert from "node:assert/strict";
import { captureTransport, emailTick } from "../src/email.js";
import { Client, PASS, type harness } from "./harness.js";

export async function recoveryEmailCases(
  h: Awaited<ReturnType<typeof harness>>,
) {
  const visitor = new Client(h.cfg.origin);
  await visitor.init();
  const admin = new Client(h.cfg.origin);
  await admin.login();
  const login = "admin@example.test";
  const mailbox = "operator-mailbox@example.test";
  const otherMailbox = "form-mailbox@example.test";
  const supplied = {
    recovery_email: otherMailbox,
    recoveryEmail: otherMailbox,
    to: otherMailbox,
  };
  const capture = captureTransport();

  async function nextMail(subject: string, address: string) {
    assert.equal(await emailTick(h.pool, h.cfg, capture.send), true);
    const next = capture.messages.shift()!;
    assert.equal(next.subject, "Mytikas: " + subject);
    assert.equal(next.to, address);
    assert.equal(await emailTick(h.pool, h.cfg, capture.send), false);
    return next.text;
  }
  async function storedAddress(address: string) {
    return (
      await h.pool.query("SELECT recovery_email FROM users WHERE email=$1", [
        address,
      ])
    ).rows[0].recovery_email;
  }
  await h.pool.query("DELETE FROM auth_limits");
  await h.pool.query("DELETE FROM email_limits");
  await h.pool.query("UPDATE users SET recovery_email=$1 WHERE id=$2", [
    mailbox,
    h.admin.id,
  ]);

  const me = (await admin.init()).data;
  assert.deepEqual(me.user, { id: h.admin.id, email: login, role: "ADMIN" });
  const listed = await admin.request(
    "/api/admin/users?q=" + encodeURIComponent(login),
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(Object.keys(listed.data.users[0]).sort(), [
    "created_at",
    "email",
    "id",
    "role",
  ]);
  assert.deepEqual(
    (await admin.request("/api/admin/users?q=" + encodeURIComponent(mailbox)))
      .data.users,
    [],
  );

  const requestReset = (email: string) =>
    visitor.request("/api/auth/forgot-password", { email, ...supplied });
  const unknown = await requestReset("unknown-recovery@example.test");
  const byMailbox = await requestReset(mailbox);
  assert.equal(unknown.status, 200);
  assert.equal(byMailbox.status, 200);
  assert.deepEqual(byMailbox.data, unknown.data);
  assert.equal(await emailTick(h.pool, h.cfg, capture.send), false);
  assert.equal(
    (
      await visitor.request("/api/auth/login", {
        email: mailbox,
        password: PASS,
      })
    ).status,
    401,
  );

  const resetRequest = await requestReset(login);
  assert.equal(resetRequest.status, 200);
  assert.deepEqual(resetRequest.data, unknown.data);
  const text = await nextMail("Reset your password", mailbox);
  const token = text.match(/#reset=([a-f0-9]{64})/)![1]!;
  const changedPassword = "New-admin-password-fixture";
  const submit = () =>
    visitor.request("/api/auth/reset-password", {
      token,
      password: changedPassword,
      confirmPassword: changedPassword,
      ...supplied,
    });
  assert.equal((await submit()).status, 200);
  assert.equal(await storedAddress(login), mailbox);
  await nextMail("password changed", mailbox);
  assert.equal((await admin.init()).data.user, null);
  assert.equal((await submit()).status, 400);
  assert.equal(await emailTick(h.pool, h.cfg, capture.send), false);
  assert.equal(
    (
      await visitor.request("/api/auth/login", {
        email: login,
        password: changedPassword,
      })
    ).status,
    200,
  );
  assert.equal((await visitor.request("/api/auth/logout", {})).status, 200);
  await visitor.init();

  const memberLogin = "ordinary-recovery@example.test";
  const registered = await visitor.request("/api/auth/register", {
    email: memberLogin,
    password: PASS,
    characterName: "Recovery Summit",
    motivation: "Fixture account",
    rulesId: (await visitor.request("/api/rules")).data.id,
    acceptRules: true,
    ...supplied,
  });
  assert.equal(registered.status, 201);
  assert.equal(await storedAddress(memberLogin), null);
  await nextMail("Verify your email", memberLogin);

  // Verification always confirms the login address, including after a pending-address correction.
  await h.pool.query("UPDATE users SET recovery_email=$1 WHERE email=$2", [
    mailbox,
    memberLogin,
  ]);
  await h.pool.query(
    "UPDATE email_limits SET last_at=now()-interval '2 minutes'",
  );
  const correctedLogin = "corrected-recovery@example.test";
  assert.equal(
    (
      await visitor.request("/api/auth/correct-pending-email", {
        email: memberLogin,
        newEmail: correctedLogin,
        password: PASS,
        ...supplied,
      })
    ).status,
    200,
  );
  assert.equal(await storedAddress(correctedLogin), mailbox);
  const verify = (await nextMail("Verify your email", correctedLogin)).match(
    /#verify=([a-f0-9]{64})/,
  )![1]!;
  assert.equal(
    (await visitor.request("/api/auth/verify-email", { token: verify })).status,
    200,
  );

  // Without an operator override, both reset messages use the verified login address.
  await h.pool.query("UPDATE users SET recovery_email=NULL WHERE email=$1", [
    correctedLogin,
  ]);
  await h.pool.query(
    "UPDATE email_limits SET last_at=now()-interval '2 minutes'",
  );
  assert.equal((await requestReset(correctedLogin)).status, 200);
  const ordinary = (
    await nextMail("Reset your password", correctedLogin)
  ).match(/#reset=([a-f0-9]{64})/)![1]!;
  assert.equal(
    (
      await visitor.request("/api/auth/reset-password", {
        token: ordinary,
        password: PASS,
        confirmPassword: PASS,
        ...supplied,
      })
    ).status,
    200,
  );
  await nextMail("password changed", correctedLogin);
  assert.equal(await storedAddress(correctedLogin), null);
}
