import type { PoolClient } from "pg";
import { transaction, type Pool } from "./db.js";
import { HttpError, applicationInput } from "./validation.js";
export type User = {
  id: string;
  email: string;
  role: "USER" | "MODERATOR" | "ADMIN";
};
export async function currentRules(c: Pool | PoolClient) {
  return (await c.query("SELECT * FROM rules ORDER BY id DESC LIMIT 1"))
    .rows[0];
}
export async function acceptSubmission(
  c: PoolClient,
  app: any,
  input: ReturnType<typeof applicationInput>,
  actor: string,
  notifications: boolean,
) {
  // Serialize rule publication with acceptance so an obsolete form cannot be accepted.
  await c.query("SELECT pg_advisory_xact_lock(2)");
  const rules = await currentRules(c);
  if (rules.id !== input.rulesId)
    throw new HttpError(
      409,
      "The rules have changed. Reload and read the current version before accepting.",
    );
  const {
    rows: [submission],
  } = await c.query(
    `INSERT INTO submissions(application_id, revision, character_name, character_key, motivation, rules_id, actor_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      app.id,
      app.revision,
      input.name,
      input.key,
      input.motivation,
      rules.id,
      actor,
    ],
  );
  await c.query(
    "INSERT INTO events(application_id, actor_id, from_status, to_status, method) VALUES ($1,$2,$3,'SUBMITTED','APPLICANT')",
    [app.id, actor, app.revision === 1 ? null : "REOPENED"],
  );
  await c.query(
    "INSERT INTO discord_jobs(submission_id,status) VALUES ($1,$2)",
    [submission.id, notifications ? "PENDING" : "DISABLED"],
  );
}
export async function detail(pool: Pool, id: string, staff = false) {
  const {
    rows: [app],
  } = await pool.query("SELECT * FROM applications WHERE id=$1", [id]);
  if (!app) throw new HttpError(404, "Application not found.");
  const [submissions, events] = await Promise.all([
    pool.query(
      `SELECT s.*, r.content AS rules_content, r.prototype AS rules_prototype FROM submissions s JOIN rules r ON r.id=s.rules_id WHERE s.application_id=$1 ORDER BY s.revision DESC`,
      [id],
    ),
    pool.query(
      `SELECT e.*, ${staff ? "u.email AS actor_email," : ""} CASE WHEN e.actor_id IS NULL THEN 'Automatic worker' WHEN e.actor_id=a.user_id THEN 'Applicant' ELSE 'Staff' END AS actor_label FROM events e JOIN applications a ON a.id=e.application_id LEFT JOIN users u ON u.id=e.actor_id WHERE e.application_id=$1 ORDER BY e.id`,
      [id],
    ),
  ]);
  delete app.check_token;
  delete app.check_started_at;
  const result: any = {
    application: app,
    submissions: submissions.rows,
    events: events.rows,
  };
  if (staff) {
    result.account = (
      await pool.query("SELECT id,email,role FROM users WHERE id=$1", [
        app.user_id,
      ])
    ).rows[0];
    result.notifications = (
      await pool.query(
        "SELECT j.id,j.status,j.attempts,j.last_error,j.created_at,j.delivered_at FROM discord_jobs j JOIN submissions s ON s.id=j.submission_id WHERE s.application_id=$1 ORDER BY j.created_at",
        [id],
      )
    ).rows;
  }
  return result;
}
export async function assertRole(
  c: PoolClient,
  actor: string,
  adminOnly = false,
) {
  const {
    rows: [user],
  } = await c.query("SELECT role FROM users WHERE id=$1 FOR SHARE", [actor]);
  if (
    !user ||
    (adminOnly
      ? user.role !== "ADMIN"
      : !["ADMIN", "MODERATOR"].includes(user.role))
  )
    throw new HttpError(403, "Staff permission required.");
}
export async function transition(
  pool: Pool,
  id: string,
  action: string,
  actor: string,
  note = "",
) {
  const actions: Record<string, { from: string[]; to: string }> = {
    approve: { from: ["SUBMITTED"], to: "APPROVED" },
    reject: { from: ["SUBMITTED", "APPROVED"], to: "REJECTED" },
    reopen: { from: ["REJECTED"], to: "REOPENED" },
    join: { from: ["APPROVED"], to: "JOINED" },
  };
  const spec = actions[action];
  if (!spec) throw new HttpError(400, "Unknown action.");
  return transaction(pool, async (c) => {
    await assertRole(c, actor);
    const {
      rows: [app],
    } = await c.query("SELECT * FROM applications WHERE id=$1 FOR UPDATE", [
      id,
    ]);
    if (!app) throw new HttpError(404, "Application not found.");
    if (!spec.from.includes(app.status))
      throw new HttpError(
        409,
        "This action is no longer available. Refresh the application.",
      );
    await c.query(
      `UPDATE applications SET status=$2, updated_at=now(), next_check_at=CASE WHEN $2='APPROVED' THEN now() ELSE NULL END,
    check_result=CASE WHEN check_token IS NOT NULL THEN 'CANCELLED' ELSE check_result END,
    check_token=NULL, check_started_at=NULL, joined_via=CASE WHEN $2='JOINED' THEN 'MANUAL' ELSE NULL END WHERE id=$1`,
      [id, spec.to],
    );
    await c.query(
      `INSERT INTO events(application_id,actor_id,from_status,to_status,method,note) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        id,
        actor,
        app.status,
        spec.to,
        action === "join" ? "MANUAL" : "STAFF",
        note,
      ],
    );
  });
}
