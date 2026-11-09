import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import nodemailer from "nodemailer";
import type { PoolClient } from "pg";
import { transaction, type Pool } from "./db.js";
import type { Config } from "./config.js";
import { HttpError } from "./validation.js";
export type Mail = { to: string; subject: string; text: string };
export type SendMail = (mail: Mail) => Promise<unknown>;
export const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function seal(mail: Mail, key: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(mail)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
export function unseal(payload: string, key: string): Mail {
  const b = Buffer.from(payload, "base64"),
    cipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      b.subarray(0, 12),
    );
  cipher.setAuthTag(b.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(),
  );
}
export async function cancelTokens(
  c: PoolClient,
  userId: string,
  purpose: string,
) {
  await c.query(
    `UPDATE email_tokens SET consumed_at=now() WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL`,
    [userId, purpose],
  );
  await c.query(
    `UPDATE email_jobs SET status='CANCELLED',payload=NULL,lease_token=NULL,lease_until=NULL WHERE token_id IN (SELECT id FROM email_tokens WHERE user_id=$1 AND purpose=$2) AND status='PENDING'`,
    [userId, purpose],
  );
}
export async function queueMail(
  c: PoolClient,
  cfg: Config,
  userId: string,
  mail: Mail,
  expires: Date,
  tokenId: string | null = null,
) {
  if (!cfg.emailOutboxKey)
    throw new HttpError(
      503,
      "Email delivery is not configured. Please try later.",
    );
  await c.query(
    "INSERT INTO email_jobs(user_id,token_id,payload,expires_at) VALUES($1,$2,$3,$4)",
    [userId, tokenId, seal(mail, cfg.emailOutboxKey), expires],
  );
}
// Caller holds the user row lock throughout token replacement and queueing.
export async function issueToken(
  c: PoolClient,
  cfg: Config,
  user: any,
  purpose: "VERIFY" | "RESET",
) {
  await cancelTokens(c, user.id, purpose);
  const token = randomBytes(32).toString("hex"),
    expires = new Date(
      Date.now() + (purpose === "VERIFY" ? 24 * 60 : 30) * 60_000,
    );
  const {
    rows: [record],
  } = await c.query(
    "INSERT INTO email_tokens(user_id,purpose,digest,expires_at) VALUES($1,$2,$3,$4) RETURNING id",
    [user.id, purpose, digest(token), expires],
  );
  const title =
    purpose === "VERIFY" ? "Verify your email" : "Reset your password";
  await queueMail(
    c,
    cfg,
    user.id,
    {
      to: user.email,
      subject: `Mytikas: ${title}`,
      text: `${title}: ${cfg.origin}/email.html#${purpose.toLowerCase()}=${token}\nThis link expires in ${purpose === "VERIFY" ? "24 hours" : "30 minutes"}. If you did not request this, ignore it.`,
    },
    expires,
    record.id,
  );
}
export async function consumeToken(
  c: PoolClient,
  token: unknown,
  purpose: string,
) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
    throw new HttpError(
      400,
      "This link is invalid or expired. Request a new one.",
    );
  // Locate without locking, then always lock user before token, matching replacement/reset.
  const {
    rows: [candidate],
  } = await c.query(
    "SELECT user_id FROM email_tokens WHERE digest=$1 AND purpose=$2",
    [digest(token), purpose],
  );
  if (!candidate)
    throw new HttpError(
      400,
      "This link is invalid or expired. Request a new one.",
    );
  const {
    rows: [user],
  } = await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
    candidate.user_id,
  ]);
  const {
    rows: [record],
  } = await c.query(
    "UPDATE email_tokens SET consumed_at=now() WHERE digest=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING id",
    [digest(token), purpose],
  );
  if (!record)
    throw new HttpError(
      400,
      "This link is invalid or expired. Request a new one.",
    );
  await cancelTokens(c, user.id, purpose);
  return user;
}
export async function emailLimit(
  pool: Pool,
  address: string | string[],
  ip: string,
) {
  // Commit rejected attempts too; uniform limits apply to nonexistent accounts.
  return transaction(pool, async (c) => {
    let allowed = true;
    for (const [raw, max, cooldown] of [
      ...[...new Set(Array.isArray(address) ? address : [address])]
        .sort()
        .map((a) => [`address:${a}`, 5, true] as const),
      [`ip:${ip}`, 20, false] as const,
    ]) {
      const key = digest(raw);
      await c.query(
        "INSERT INTO email_limits(key,attempts,reset_at,last_at) VALUES($1,0,now()+interval '1 hour','epoch') ON CONFLICT DO NOTHING",
        [key],
      );
      const {
        rows: [r],
      } = await c.query(
        "SELECT *, now() AS current_time FROM email_limits WHERE key=$1 FOR UPDATE",
        [key],
      );
      const count = r.reset_at <= r.current_time ? 0 : r.attempts;
      if (count >= max || (cooldown && r.current_time - r.last_at < 60_000))
        allowed = false;
      await c.query(
        `UPDATE email_limits SET attempts=$2, reset_at=CASE WHEN reset_at<=now() THEN now()+interval '1 hour' ELSE reset_at END,last_at=now() WHERE key=$1`,
        [key, count + 1],
      );
    }
    return allowed;
  });
}
export function captureTransport() {
  const messages: Mail[] = [];
  return {
    messages,
    send: async (mail: Mail) => {
      messages.push(structuredClone(mail));
    },
  };
}
export function smtpSender(cfg: Config): SendMail {
  if (cfg.demo) return captureTransport().send; // Isolated demo capture: never connect to SMTP.
  const transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort || 587,
    secure: cfg.smtpPort === 465,
    requireTLS: true,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth: cfg.smtpUser
      ? { user: cfg.smtpUser, pass: cfg.smtpPassword }
      : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return (mail) => transport.sendMail({ ...mail, from: cfg.emailFrom });
}
export async function emailTick(pool: Pool, cfg: Config, send: SendMail) {
  await pool.query(
    `UPDATE email_jobs SET status='CANCELLED',payload=NULL,lease_token=NULL,lease_until=NULL WHERE status='PENDING' AND expires_at<=now()`,
  );
  const lease = randomUUID();
  const {
    rows: [job],
  } = await pool.query(
    `UPDATE email_jobs SET lease_token=$1,lease_until=now()+interval '2 minutes',attempts=attempts+1 WHERE id=(SELECT id FROM email_jobs WHERE status='PENDING' AND expires_at>now() AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    [lease],
  );
  if (!job) return false;
  try {
    if (!cfg.emailOutboxKey) throw new Error("MAIL_CONFIG");
    await send(unseal(job.payload, cfg.emailOutboxKey));
    await pool.query(
      `UPDATE email_jobs SET status='DELIVERED',payload=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`,
      [job.id, lease],
    );
  } catch (error: any) {
    const terminal =
      job.attempts >= 8 ||
      (error?.responseCode >= 500 && error?.responseCode < 600);
    await pool.query(
      `UPDATE email_jobs SET status=CASE WHEN $3 THEN 'FAILED' ELSE 'PENDING' END,payload=CASE WHEN $3 THEN NULL ELSE payload END,lease_token=NULL,lease_until=NULL,available_at=now()+($4*interval '1 second') WHERE id=$1 AND lease_token=$2`,
      [job.id, lease, terminal, Math.min(3600, 30 * 2 ** job.attempts)],
    );
  }
  return true;
}
