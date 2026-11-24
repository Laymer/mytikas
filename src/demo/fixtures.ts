import type { Pool } from "../db.js";
import { normalize } from "../validation.js";
import { verifyMembership } from "../armory.js";
export const states = ["member", "outsider", "missing", "unavailable"];
export function fixtureTransport(pool: Pool): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/en-us/graphql") {
      const { operationName } = JSON.parse(String(init?.body));
      const { rows } = await pool.query(
        "SELECT character_key, character_name FROM demo_fixtures WHERE state = 'member' ORDER BY character_key",
      );
      if (operationName === "GetEssentialGuildData") {
        return Response.json({ data: { Guild: {
          name: "Olympus Mytikas", ruleset: { name: "PvP" }, memberCount: rows.length,
        } } });
      }
      if (operationName !== "GetGuildRoster") return new Response(null, { status: 400 });
      const roster = rows.map(row => {
        const [name, surname] = row.character_name.split(" ");
        return {
          rank: { rankId: 1 },
          character: { _id: row.character_key, name, surname, region: "us", class: { name: "Warrior" }, level: 60 },
        };
      });
      return Response.json({ data: { Guild: { _id: "us-none-olympus-mytikas", roster } } });
    }
    const key = normalize(decodeURIComponent(url.pathname.split('/').pop() || ''));
    const { rows: [fixture] } = await pool.query("SELECT * FROM demo_fixtures WHERE replace(character_key, ' ', '-')=$1", [key]);
    if (!fixture || fixture.state === 'missing') return new Response('', { status: 404 });
    if (fixture.state === 'unavailable') throw new Error('Demo armory unavailable');
    const parts = fixture.character_name.split(' ');
    const character = { name: parts.shift(), surname: parts.join(' '), region: 'us', ruleset: { slug: 'pvp' }, guild: { name: fixture.state === 'member' ? 'Olympus Mytikas' : 'Other Guild' } };
    return new Response(`<script id="character-profile-mount-initial-state">var characterProfileInitialState = ${JSON.stringify({character})};</script>`);
  };
}
export const fixtureVerifier = (pool: Pool) => (name: string) => verifyMembership(name, fixtureTransport(pool));
