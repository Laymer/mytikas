import type { Pool } from "../db.js";
import { normalize } from "../validation.js";
import { verifyMembership } from "../armory.js";
export const states = ["member", "outsider", "missing", "unavailable"];
export function fixtureTransport(pool: Pool): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
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
