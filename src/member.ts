import type { Express, RequestHandler } from "express";
import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./validation.js";
import { eligibleSql } from "./addon.js";
import { discordBot, voidReport } from "./blacklist.js";
import { transaction, type Pool } from "./db.js";

export function installMember(
  app: Express,
  pool: Pool,
  origin: string,
  authenticated: RequestHandler,
  admin: RequestHandler,
) {
  app.use("/api/addon", authenticated, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!(await pool.query(eligibleSql, [req.user!.id])).rowCount)
      throw new HttpError(403, "Addon access is unavailable.");
    next();
  });
  app.get("/api/addon", async (_req, res) => {
    res.json(
      (
        await pool.query(
          "SELECT version,published_at,notes,sha256 FROM addon_releases ORDER BY string_to_array(version,'.')::int[] DESC",
        )
      ).rows,
    );
  });
  app.get("/api/addon/:version", async (req, res) => {
    const r = (
      await pool.query(
        "SELECT version,archive FROM addon_releases WHERE version=$2 AND EXISTS (" +
          eligibleSql +
          ")",
        [req.user!.id, req.params.version],
      )
    ).rows[0];
    if (!r) throw new HttpError(404, "Release unavailable.");
    res.attachment("OlympusMytikas-" + r.version + ".zip").send(r.archive);
  });
  app.use("/api/blacklist", authenticated, admin);
  app.get("/api/blacklist", async (req, res) => {
    const search = String(req.query.q ?? "").slice(0, 200);
    const reports = await pool.query(
      `SELECT r.*,a.id AS application_id,a.status,c.result,c.checked_at,
      (SELECT json_agg(json_build_object('id',w.id,'delivered',w.delivered_id IS NOT NULL) ORDER BY w.id DESC)
       FROM blacklist_warnings w WHERE w.character_key=r.character_key) AS warnings
      FROM blacklist_reports r LEFT JOIN applications a USING(character_key) LEFT JOIN blacklist_checks c USING(character_key)
      WHERE strpos(lower(r.character_name),lower($1))>0 ORDER BY reported_at DESC`,
      [search],
    );
    res.json({
      reports: reports.rows,
      checkpoints: (await pool.query("SELECT * FROM blacklist_checkpoint"))
        .rows,
    });
  });
  app.post("/api/blacklist/:id/void", async (req, res) => {
    await voidReport(
      pool,
      String(req.params.id),
      req.user!.id,
      String(req.body.reason ?? ""),
    );
    res.json({ ok: true });
  });
  const callback = origin + "/api/discord/callback";
  const digest = (sid: string) =>
    createHash("sha256").update(sid).digest("hex");
  app.use("/api/discord", authenticated);
  app.get("/api/discord", async (req, res) => {
    const link = (
      await pool.query(
        "SELECT username,discord_id FROM discord_links WHERE user_id=$1",
        [req.user!.id],
      )
    ).rows[0];
    let membership = "temporarily unavailable",
      checkedAt = null;
    if (link) {
      checkedAt = new Date();
      try {
        const member = await discordBot(
          `/guilds/${process.env.DISCORD_GUILD_ID}/members/${link.discord_id}`,
        );
        if (member.ok) membership = "confirmed";
        else if (member.status === 404 && (await member.json()).code === 10007)
          membership = "outside the server";
      } catch {}
    }
    res.json({
      link,
      membership,
      checkedAt,
      configured: !!(
        process.env.DISCORD_CLIENT_ID &&
        process.env.DISCORD_CLIENT_SECRET &&
        process.env.DISCORD_GUILD_ID
      ),
      invite: process.env.DISCORD_INVITE_URL,
    });
  });
  app.post("/api/discord/link", async (req, res) => {
    if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET)
      throw new HttpError(503, "Discord linking is unavailable.");
    const state = randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO discord_states VALUES($1,$2,$3,now()+interval '10 minutes')
      ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,session_hash=excluded.session_hash,expires_at=excluded.expires_at`,
      [req.user!.id, digest(req.sessionID), state],
    );
    res.json({
      url:
        "https://discord.com/oauth2/authorize?" +
        new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          redirect_uri: callback,
          scope: "identify",
          response_type: "code",
          state,
        }),
    });
  });
  app.post("/api/discord/unlink", async (req, res) => {
    await transaction(pool, async (c) => {
      await c.query("DELETE FROM discord_states WHERE user_id=$1", [
        req.user!.id,
      ]);
      await c.query("DELETE FROM discord_links WHERE user_id=$1", [
        req.user!.id,
      ]);
    });
    res.json({ ok: true });
  });
  app.get("/api/discord/callback", async (req, res) => {
    const claim = randomBytes(32).toString("hex");
    const state = await pool.query(
      "UPDATE discord_states SET state=$4 WHERE user_id=$1 AND state=$2 AND session_hash=$3 AND expires_at>now() RETURNING user_id",
      [req.user!.id, String(req.query.state), digest(req.sessionID), claim],
    );
    if (!state.rowCount)
      throw new HttpError(
        400,
        "Discord authorization expired. Start again from Member Home.",
      );
    if (req.query.error || !req.query.code) {
      res.redirect("/account.html?discord=cancelled");
      return;
    }
    try {
      const token = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: process.env.DISCORD_CLIENT_ID!,
          client_secret: process.env.DISCORD_CLIENT_SECRET!,
          redirect_uri: callback,
          code: String(req.query.code),
        }),
      });
      if (!token.ok) throw new Error();
      const me = await fetch("https://discord.com/api/v10/users/@me", {
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: "Bearer " + (await token.json()).access_token,
        },
      });
      if (!me.ok) throw new Error();
      const u = await me.json();
      if (!/^\d{1,20}$/.test(u.id) || typeof u.username !== "string")
        throw new Error();
      const result = await pool.query(
        `WITH authorized AS (DELETE FROM discord_states WHERE user_id=$1 AND state=$4 AND expires_at>now() RETURNING user_id)
        INSERT INTO discord_links SELECT user_id,$2,$3 FROM authorized ON CONFLICT DO NOTHING`,
        [req.user!.id, u.id, u.username, claim],
      );
      res.redirect(
        "/account.html?discord=" + (result.rowCount ? "linked" : "duplicate"),
      );
    } catch {
      res.redirect("/account.html?discord=unavailable");
    }
  });
}
