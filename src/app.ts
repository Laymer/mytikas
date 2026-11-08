import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import session from "express-session";
import connectPg from "connect-pg-simple";
import helmet from "helmet";
import argon2 from "argon2";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import { transaction, type Pool } from "./db.js";
import {
  HttpError,
  applicationInput,
  email,
  password,
  uuid,
} from "./validation.js";
import {
  acceptSubmission,
  assertRole,
  currentRules,
  detail,
  transition,
  type User,
} from "./applications.js";
import { checkMembership, verifyMembership, type Verify } from "./armory.js";
declare module "express-session" {
  interface SessionData {
    userId?: string;
    csrf?: string;
  }
}
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
const publicUser = (u: any): User => ({
  id: u.id,
  email: u.email,
  role: u.role,
});
export const hashPassword = (value: string) =>
  argon2.hash(value, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
export function createApp(
  pool: Pool,
  cfg: Config,
  verify: Verify = verifyMembership,
) {
  const app = express();
  const cookieName = cfg.demo ? "mytikas.demo.sid" : "mytikas.sid";
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "upgrade-insecure-requests": cfg.secureCookies ? [] : null,
        },
      },
      strictTransportSecurity: cfg.secureCookies ? undefined : false,
    }),
  );
  app.get("/api/runtime", (_req, res) => res.json({ mode: cfg.demo ? "demo" : "normal" }));
  app.get("/api/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1 FROM rules LIMIT 1");
      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false });
    }
  });
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", express.json({ limit: "128kb" }));
  const Store = connectPg(session);
  const sessionStore = new Store({
    pool,
    tableName: "sessions",
    pruneSessionInterval: false,
  });
  app.use(
    "/api",
    session({
      name: cookieName,
      secret: cfg.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: cfg.secureCookies,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );
  app.use("/api", async (req, res, next) => {
    if (req.session.userId) {
      const {
        rows: [u],
      } = await pool.query("SELECT id,email,role FROM users WHERE id=$1", [
        req.session.userId,
      ]);
      if (u) req.user = publicUser(u);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      if (
        (origin && origin !== cfg.origin) ||
        req.get("sec-fetch-site") === "cross-site"
      )
        throw new HttpError(403, "Cross-site request refused.");
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
        throw new HttpError(400, "Send a JSON object.");
      if (!req.is("application/json")) throw new HttpError(415, "Send JSON.");
      const token = req.get("x-csrf-token") || "",
        expected = req.session.csrf || "";
      if (
        !expected ||
        !/^[a-f0-9]{64}$/.test(token) ||
        token.length !== expected.length ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
      )
        throw new HttpError(
          403,
          "Session token missing or expired. Reload the page.",
        );
    }
    next();
  });
  const authenticated = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new HttpError(401, "Sign in to continue.");
    next();
  };
  const staff = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !["ADMIN", "MODERATOR"].includes(req.user.role))
      throw new HttpError(403, "Staff permission required.");
    next();
  };
  const admin = (req: Request, _res: Response, next: NextFunction) => {
    if (req.user?.role !== "ADMIN")
      throw new HttpError(403, "Admin permission required.");
    next();
  };
  const authLimit = async (req: Request, res: Response, next: NextFunction) => {
    const account =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    const keys = [
      ["ip:" + req.ip, 40],
      ["email:" + account, 12],
    ] as const;
    for (const [raw, max] of keys) {
      const key = createHash("sha256").update(raw).digest("hex");
      const {
        rows: [limit],
      } = await pool.query(
        `INSERT INTO auth_limits(key,attempts,reset_at) VALUES ($1,1,now()+interval '15 minutes')
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_limits.reset_at<now() THEN 1 ELSE auth_limits.attempts+1 END,
    reset_at=CASE WHEN auth_limits.reset_at<now() THEN now()+interval '15 minutes' ELSE auth_limits.reset_at END RETURNING attempts`,
        [key],
      );
      if (limit.attempts > max) {
        res.set("Retry-After", "900");
        throw new HttpError(
          429,
          "Too many authentication attempts. Try again in 15 minutes.",
        );
      }
    }
    next();
  };
  async function signedIn(req: Request, u: User) {
    await new Promise<void>((ok, no) =>
      req.session.regenerate((e) => (e ? no(e) : ok())),
    );
    req.session.userId = u.id;
    req.session.csrf = randomBytes(32).toString("hex");
    await new Promise<void>((ok, no) =>
      req.session.save((e) => (e ? no(e) : ok())),
    );
    return { user: u, csrfToken: req.session.csrf };
  }
  app.get("/api/auth/me", (req, res) => {
    req.session.csrf ||= randomBytes(32).toString("hex");
    res.json({ user: req.user || null, csrfToken: req.session.csrf });
  });
  app.get("/api/rules", async (_req, res) =>
    res.json(await currentRules(pool)),
  );
  app.post("/api/auth/register", authLimit, async (req, res) => {
    if (req.user) throw new HttpError(409, "You are already signed in.");
    const address = email(req.body.email),
      pass = password(req.body.password),
      input = applicationInput(req.body);
    const hash = await hashPassword(pass);
    const u = await transaction(pool, async (c) => {
      const {
        rows: [user],
      } = await c.query(
        "INSERT INTO users(email,password_hash) VALUES ($1,$2) RETURNING id,email,role",
        [address, hash],
      );
      const {
        rows: [application],
      } = await c.query(
        `INSERT INTO applications(user_id,character_name,character_key,status) VALUES ($1,$2,$3,'SUBMITTED') RETURNING *`,
        [user.id, input.name, input.key],
      );
      await acceptSubmission(
        c,
        application,
        input,
        user.id,
        !!cfg.discordWebhook,
      );
      return publicUser(user);
    });
    res.status(201).json(await signedIn(req, u));
  });
  // Fixed dummy hash keeps missing-account checks on the password hashing path.
  const dummyHash = hashPassword(randomBytes(32).toString("hex"));
  app.post("/api/auth/login", authLimit, async (req, res) => {
    const address = email(req.body.email);
    const pass =
      typeof req.body.password === "string" && req.body.password.length <= 128
        ? req.body.password
        : "";
    const {
      rows: [u],
    } = await pool.query("SELECT * FROM users WHERE email=$1", [address]);
    const valid = await argon2.verify(
      u?.password_hash || (await dummyHash),
      pass,
    );
    if (!u || !valid)
      throw new HttpError(401, "Email or password is incorrect.");
    res.json(await signedIn(req, publicUser(u)));
  });
  app.post("/api/auth/logout", authenticated, async (req, res) => {
    await new Promise<void>((ok, no) =>
      req.session.destroy((e) => (e ? no(e) : ok())),
    );
    res.clearCookie(cookieName, {
      httpOnly: true,
      sameSite: "lax",
      secure: cfg.secureCookies,
    });
    res.json({ ok: true });
  });
  async function ownerId(req: Request) {
    const {
      rows: [a],
    } = await pool.query("SELECT id FROM applications WHERE user_id=$1", [
      req.user!.id,
    ]);
    if (!a)
      throw new HttpError(
        404,
        "No application is associated with this account.",
      );
    return a.id as string;
  }
  app.get("/api/application", authenticated, async (req, res) => {
    const {
      rows: [a],
    } = await pool.query("SELECT id FROM applications WHERE user_id=$1", [
      req.user!.id,
    ]);
    res.json(
      a
        ? await detail(pool, a.id)
        : { application: null, submissions: [], events: [] },
    );
  });
  app.post("/api/application", authenticated, async (req, res) => {
    const input = applicationInput(req.body),
      id = await ownerId(req);
    await transaction(pool, async (c) => {
      const {
        rows: [a],
      } = await c.query("SELECT * FROM applications WHERE id=$1 FOR UPDATE", [
        id,
      ]);
      if (a.status !== "REOPENED")
        throw new HttpError(409, "Only a reopened application can be revised.");
      const {
        rows: [updated],
      } = await c.query(
        `UPDATE applications SET character_name=$2,character_key=$3,revision=revision+1,status='SUBMITTED',updated_at=now(),last_check_at=NULL,check_result=NULL,next_check_at=NULL,check_token=NULL,check_started_at=NULL WHERE id=$1 RETURNING *`,
        [id, input.name, input.key],
      );
      await acceptSubmission(
        c,
        updated,
        input,
        req.user!.id,
        !!cfg.discordWebhook,
      );
    });
    res.json(await detail(pool, id));
  });
  app.post("/api/application/check", authenticated, async (req, res) => {
    const id = await ownerId(req);
    await checkMembership(pool, id, verify, false, req.user!.id);
    res.json(await detail(pool, id));
  });
  app.use("/api/admin", authenticated, staff);
  app.get("/api/admin/applications", async (req, res) => {
    const status =
      typeof req.query.status === "string" ? req.query.status : "PENDING";
    if (
      ![
        "PENDING",
        "ALL",
        "SUBMITTED",
        "APPROVED",
        "REJECTED",
        "REOPENED",
        "JOINED",
      ].includes(status)
    )
      throw new HttpError(400, "Invalid status filter.");
    const offset = Math.max(
      0,
      Math.min(1_000_000, Number(req.query.offset) || 0),
    );
    const { rows } = await pool.query(
      `SELECT a.id,a.character_name,a.status,a.revision,a.updated_at,a.check_result FROM applications a
   WHERE $1='ALL' OR ($1='PENDING' AND a.status IN ('SUBMITTED','APPROVED','REOPENED')) OR a.status=$1 ORDER BY a.updated_at DESC,a.id LIMIT 51 OFFSET $2`,
      [status, offset],
    );
    res.json({
      applications: rows.slice(0, 50),
      hasMore: rows.length > 50,
      notificationsEnabled: !!cfg.discordWebhook,
    });
  });
  app.get("/api/admin/applications/:id", async (req, res) =>
    res.json(await detail(pool, uuid(req.params.id), true)),
  );
  app.post("/api/admin/applications/:id/check", async (req, res) => {
    const id = uuid(req.params.id);
    await checkMembership(pool, id, verify, false, req.user!.id);
    res.json(await detail(pool, id, true));
  });
  app.post("/api/admin/applications/:id/:action", async (req, res) => {
    const id = uuid(req.params.id),
      note = typeof req.body.note === "string" ? req.body.note.trim() : "";
    if (note.length > 1000)
      throw new HttpError(400, "Keep the review note within 1,000 characters.");
    await transition(pool, id, String(req.params.action), req.user!.id, note);
    res.json(await detail(pool, id, true));
  });
  app.get("/api/admin/users", admin, async (req, res) => {
    const q = String(req.query.q || "")
      .trim()
      .slice(0, 254);
    const { rows } = await pool.query(
      `SELECT id,email,role,created_at FROM users WHERE position(lower($1) in email)>0 ORDER BY email LIMIT 50`,
      [q],
    );
    res.json({ users: rows });
  });
  app.post("/api/admin/users/:id/role", admin, async (req, res) => {
    const id = uuid(req.params.id),
      role = req.body.role;
    if (!["USER", "MODERATOR", "ADMIN"].includes(role))
      throw new HttpError(400, "Invalid role.");
    await transaction(pool, async (c) => {
      // Serialize all role changes, including the last-admin test.
      await c.query("SELECT pg_advisory_xact_lock(1)");
      await assertRole(c, req.user!.id, true);
      const {
        rows: [u],
      } = await c.query("SELECT role FROM users WHERE id=$1 FOR UPDATE", [id]);
      if (!u) throw new HttpError(404, "Account not found.");
      if (
        u.role === "ADMIN" &&
        role !== "ADMIN" &&
        Number(
          (await c.query(`SELECT count(*) FROM users WHERE role='ADMIN'`))
            .rows[0].count,
        ) <= 1
      )
        throw new HttpError(409, "The last admin cannot be demoted.");
      await c.query("UPDATE users SET role=$2 WHERE id=$1", [id, role]);
      await c.query(
        "INSERT INTO role_events(user_id,actor_id,old_role,new_role) VALUES ($1,$2,$3,$4)",
        [id, req.user!.id, u.role, role],
      );
    });
    res.json({ ok: true });
  });
  app.post("/api/admin/rules", admin, async (req, res) => {
    const content =
      typeof req.body.content === "string" ? req.body.content.trim() : "";
    if (content.length < 1 || content.length > 20000)
      throw new HttpError(400, "Rules must contain 1–20,000 characters.");
    const rules = await transaction(pool, async (c) => {
      await assertRole(c, req.user!.id, true);
      await c.query("SELECT pg_advisory_xact_lock(2)");
      return (
        await c.query(
          "INSERT INTO rules(content,actor_id) VALUES ($1,$2) RETURNING *",
          [content, req.user!.id],
        )
      ).rows[0];
    });
    res.status(201).json(rules);
  });
  app.use("/api", (_req, _res) => {
    throw new HttpError(404, "API route not found.");
  });
  app.use(
    express.static(resolve("public"), {
      index: "index.html",
      dotfiles: "deny",
    }),
  );
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err.code === "23505")
      return res
        .status(409)
        .json({ error: "That email or character is already registered." });
    if (err instanceof HttpError) {
      if (err.status === 429 && !res.hasHeader("Retry-After"))
        res.set("Retry-After", "60");
      return res.status(err.status).json({ error: err.message });
    }
    if (err.type === "entity.parse.failed" || err.type === "entity.too.large")
      return res
        .status(400)
        .json({ error: "Invalid or oversized JSON request." });
    console.error("Request failed:", err.code || err.name || "unknown");
    res
      .status(500)
      .json({ error: "The request could not be completed. Please try again." });
  });
  return app;
}
