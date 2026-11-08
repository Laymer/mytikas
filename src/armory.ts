import { randomUUID } from "node:crypto";
import { transaction, type Pool } from "./db.js";
import { HttpError, normalize } from "./validation.js";
export const ARMORY_BASE = "https://worldofwarcraft.blizzard.com";
export function profileUrl(name: string) {
  return `${ARMORY_BASE}/en-us/forever/us/armory/character/${encodeURIComponent(normalize(name).replace(/ /g, "-"))}`;
}
// Parse just the JSON object from the known script. Never evaluate remote JavaScript.
export function parseProfile(html: string): any {
  const script = html.match(
    /<script\b[^>]*\bid=["']character-profile-mount-initial-state["'][^>]*>([\s\S]*?)<\/script\s*>/i,
  )?.[1];
  const match = script?.match(
    /\b(?:var|let|const)\s+characterProfileInitialState\s*=\s*/,
  );
  if (!script || !match || match.index === undefined)
    throw new Error("MALFORMED_PROFILE");
  const start = match.index + match[0].length;
  if (script[start] !== "{") throw new Error("MALFORMED_PROFILE");
  let depth = 0,
    inString = false,
    escaped = false;
  for (let i = start; i < script.length; i++) {
    const ch = script[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0)
      return JSON.parse(script.slice(start, i + 1)).character;
  }
  throw new Error("MALFORMED_PROFILE");
}
export function membershipResult(character: any, name: string): string {
  if (
    !character ||
    typeof character.name !== "string" ||
    typeof character.surname !== "string" ||
    typeof character.region !== "string" ||
    typeof character.ruleset?.slug !== "string"
  )
    return "MALFORMED_PROFILE";
  if (normalize(`${character.name} ${character.surname}`) !== normalize(name))
    return "CHARACTER_MISMATCH";
  if (normalize(character.region) !== "us") return "REGION_MISMATCH";
  if (normalize(character.ruleset.slug) !== "pvp") return "RULESET_MISMATCH";
  if (
    typeof character.guild?.name !== "string" ||
    normalize(character.guild.name) !== "olympus mytikas"
  )
    return "GUILD_MISMATCH";
  return "MATCH";
}
export async function limitedText(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("EMPTY_RESPONSE");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}
export type Verify = (name: string) => Promise<string>;
export async function verifyMembership(
  name: string,
  transport: typeof fetch = fetch,
): Promise<string> {
  try {
    const response = await transport(profileUrl(name), {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mytikas-local-prototype/1.0",
        Accept: "text/html",
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return response.status === 404
        ? "PROFILE_NOT_FOUND"
        : `HTTP_${response.status}`;
    }
    return membershipResult(
      parseProfile(await limitedText(response, 2_000_000)),
      name,
    );
  } catch (e) {
    if (
      e instanceof Error &&
      ["RESPONSE_TOO_LARGE", "MALFORMED_PROFILE"].includes(e.message)
    )
      return e.message;
    return "UNAVAILABLE";
  }
}
export async function checkMembership(
  pool: Pool,
  id: string,
  verify: Verify = verifyMembership,
  scheduled = false,
  actor: string | null = null,
) {
  const token = randomUUID();
  const {
    rows: [app],
  } = await pool.query(
    `UPDATE applications SET check_token=$2, check_started_at=now(), last_check_at=now(), check_result='CHECKING', next_check_at=now()+interval '15 minutes'
 WHERE id=$1 AND status='APPROVED' AND (last_check_at IS NULL OR last_check_at <= now()-interval '1 minute')
 AND (check_token IS NULL OR check_started_at < now()-interval '2 minutes')
 AND (NOT $3 OR next_check_at <= now()) RETURNING *`,
    [id, token, scheduled],
  );
  if (!app) {
    if (scheduled) return null;
    const {
      rows: [current],
    } = await pool.query("SELECT status FROM applications WHERE id=$1", [id]);
    if (!current) throw new HttpError(404, "Application not found.");
    if (current.status !== "APPROVED")
      throw new HttpError(
        409,
        "Membership checks require an approved application.",
      );
    throw new HttpError(
      429,
      "A check is running or was requested within the last minute. Please wait.",
    );
  }
  let result: string;
  try {
    result = await verify(app.character_name);
  } catch {
    result = "UNAVAILABLE";
  }
  await transaction(pool, async (c) => {
    const {
      rows: [updated],
    } = await c.query(
      `UPDATE applications SET check_result=$3, check_token=NULL, check_started_at=NULL,
    status=CASE WHEN $3='MATCH' THEN 'JOINED' ELSE status END,
    joined_via=CASE WHEN $3='MATCH' THEN 'ARMORY' ELSE joined_via END,
    updated_at=CASE WHEN $3='MATCH' THEN now() ELSE updated_at END,
    next_check_at=CASE WHEN $3='MATCH' THEN NULL ELSE next_check_at END
    WHERE id=$1 AND check_token=$2 AND status='APPROVED' RETURNING id`,
      [id, token, result],
    );
    if (updated && result === "MATCH")
      await c.query(
        `INSERT INTO events(application_id,actor_id,from_status,to_status,method) VALUES ($1,$2,'APPROVED','JOINED','ARMORY')`,
        [id, actor],
      );
  });
  return result;
}
