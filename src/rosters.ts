import type { Express } from "express";
import { transaction, type Pool } from "./db.js";
import { assertRole } from "./applications.js";
import { HttpError, uuid } from "./validation.js";
export const CLASSES = [
  "Warrior",
  "Paladin",
  "Hunter",
  "Rogue",
  "Priest",
  "Shaman",
  "Mage",
  "Warlock",
  "Druid",
];
export async function rosterAccess(pool: Pool, id: string) {
  return !!(
    await pool.query(
      `SELECT 1 FROM users u LEFT JOIN applications a ON a.user_id=u.id WHERE u.id=$1 AND (u.email_verified_at IS NOT NULL OR u.activation_exempt) AND (u.role='ADMIN' OR a.status='JOINED')`,
      [id],
    )
  ).rowCount;
}
export async function rosterData(pool: Pool) {
  // One statement gives slots and revisions from the same snapshot.
  const { rows } = await pool.query(
    `SELECT r.size,r.revision,s.position,s.role,a.id AS member_id,a.character_name,COALESCE(a.class_override,a.armory_class) AS class FROM rosters r JOIN roster_slots s ON s.roster_size=r.size LEFT JOIN applications a ON a.id=s.application_id ORDER BY r.size,s.position`,
  );
  return {
    rosters: [10, 20, 40].map((size) => ({
      size,
      revision: rows.find((r) => r.size === size).revision,
      slots: rows
        .filter((r) => r.size === size)
        .map(({ position, role, member_id, character_name, class: klass }) => ({
          position,
          role,
          memberId: member_id,
          characterName: character_name,
          class: klass,
        })),
    })),
  };
}
export function installRosters(app: Express, pool: Pool) {
  app.get("/api/rosters", async (req, res) => {
    if (!req.user || !(await rosterAccess(pool, req.user.id)))
      throw new HttpError(
        403,
        "Confirmed membership is required to view Raid Roster.",
      );
    res.json(await rosterData(pool));
  });
  app.get("/api/admin/roster-members", async (req, res) => {
    if (req.user?.role !== "ADMIN")
      throw new HttpError(403, "Admin permission required.");
    res.json({
      members: (
        await pool.query(
          `SELECT id,character_name,armory_class,class_override,class_checked_at,class_result,COALESCE(class_override,armory_class) AS class FROM applications WHERE status='JOINED' ORDER BY lower(character_name),id`,
        )
      ).rows,
    });
  });
  app.post("/api/admin/rosters/:size", async (req, res) => {
    if (!req.user) throw new HttpError(403, "Admin permission required.");
    const size = Number(req.params.size),
      { revision, slots } = req.body;
    if (
      ![10, 20, 40].includes(size) ||
      !Number.isInteger(revision) ||
      !Array.isArray(slots) ||
      slots.length !== size
    )
      throw new HttpError(400, "Send the complete roster and revision.");
    const ids = new Set<string>();
    for (let i = 0; i < size; i++) {
      const s = slots[i];
      if (
        !s ||
        s.position !== i ||
        !["TANK", "HEALER", "DPS"].includes(s.role) ||
        (s.memberId !== null && typeof s.memberId !== "string")
      )
        throw new HttpError(400, "Invalid roster slot.");
      if (s.memberId !== null) {
        uuid(s.memberId);
        if (ids.has(s.memberId))
          throw new HttpError(400, "A member may appear only once per roster.");
        ids.add(s.memberId);
      }
    }
    await transaction(pool, async (c) => {
      await assertRole(c, req.user!.id, true);
      // Same lock as membership removal: membership cannot change during a save.
      await c.query("SELECT pg_advisory_xact_lock(3)");
      const {
        rows: [r],
      } = await c.query(
        "SELECT revision FROM rosters WHERE size=$1 FOR UPDATE",
        [size],
      );
      if (r.revision !== revision)
        throw new HttpError(
          409,
          "This roster changed. Your draft is preserved. Reload or Cancel to load the current roster.",
        );
      const members = await c.query(
        "SELECT id FROM applications WHERE id=ANY($1::uuid[]) AND status='JOINED' FOR SHARE",
        [[...ids]],
      );
      if (members.rowCount !== ids.size)
        throw new HttpError(
          409,
          "A selected member is no longer confirmed. Reload the members and roster.",
        );
      await c.query(
        "UPDATE roster_slots SET application_id=NULL WHERE roster_size=$1",
        [size],
      );
      for (const s of slots)
        await c.query(
          "UPDATE roster_slots SET role=$3,application_id=$4 WHERE roster_size=$1 AND position=$2",
          [size, s.position, s.role, s.memberId],
        );
      await c.query("UPDATE rosters SET revision=revision+1 WHERE size=$1", [
        size,
      ]);
    });
    res.json(await rosterData(pool));
  });
  app.post("/api/admin/members/:id/class", async (req, res) => {
    if (!req.user) throw new HttpError(403, "Admin permission required.");
    const id = uuid(req.params.id),
      value = req.body.class;
    if (value !== null && !CLASSES.includes(value))
      throw new HttpError(400, "Select a classic class or use armory class.");
    await transaction(pool, async (c) => {
      await assertRole(c, req.user!.id, true);
      const r = await c.query(
        "UPDATE applications SET class_override=$2 WHERE id=$1 AND status IN ('JOINED','REMOVED')",
        [id, value],
      );
      if (!r.rowCount) throw new HttpError(404, "Member not found.");
    });
    res.json({ ok: true });
  });
  app.post("/api/admin/members/:id/refresh-class", async (req, res) => {
    if (!req.user) throw new HttpError(403, "Admin permission required.");
    const id = uuid(req.params.id);
    await transaction(pool, async (c) => {
      await assertRole(c, req.user!.id, true);
      if (
        !(
          await c.query(
            "SELECT id FROM applications WHERE id=$1 AND status='JOINED' FOR SHARE",
            [id],
          )
        ).rowCount
      )
        throw new HttpError(404, "Confirmed member not found.");
      await c.query(
        "INSERT INTO class_jobs(application_id) VALUES($1) ON CONFLICT(application_id) DO UPDATE SET attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL",
        [id],
      );
    });
    res.json({ ok: true });
  });
}
