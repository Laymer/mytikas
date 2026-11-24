import { ARMORY_BASE, limitedText, profileUrl } from "./armory.js";
import { HttpError } from "./validation.js";

const guild = { region: "us", nameSlug: "olympus-mytikas" };
const guildUrl = `${ARMORY_BASE}/en-us/forever/us/armory/guild/${guild.nameSlug}`;
// Document IDs published by Blizzard's guild-profile client for its read-only queries.
const documents = {
  GetEssentialGuildData: "a38169a9f8c90daf2c1bb1bd8a608e34b43e075ddd7f96d657c2eb83282b310f",
  GetGuildRoster: "5f32b85faa248d321a08645d470fb38b82be64b9abd8b5b5fd2816620546794b",
};
const pageSize = 25;
const freshForMs = 15 * 60_000;
const retryAfterMs = 30_000;
const byName = new Intl.Collator("en-US");

interface Fighter {
  name: string;
  class: string;
  level: number;
  armoryUrl: string;
}
export interface FightersPage {
  fighters: Fighter[];
  total: number;
  page: number;
  pageCount: number;
  updatedAt: string;
  stale: boolean;
}

async function queryGuild(transport: typeof fetch, operationName: keyof typeof documents) {
  const variables = operationName === "GetGuildRoster"
    ? { guild, showMessageOfTheDay: false, showRoles: false }
    : { guild };
  const response = await transport(`${ARMORY_BASE}/en-us/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept-Language": "en-US",
      "Referer": guildUrl,
      "X-Static": "false",
    },
    body: JSON.stringify({
      operationName, variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: documents[operationName] } },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Armory request failed");
  }
  const result = JSON.parse(await limitedText(response, 2_000_000));
  if (result?.errors?.length || !result?.data?.Guild)
    throw new Error("Incomplete armory response");
  return result.data.Guild;
}

async function fetchRoster(transport: typeof fetch): Promise<Fighter[]> {
  const [identity, listing] = await Promise.all([
    queryGuild(transport, "GetEssentialGuildData"),
    queryGuild(transport, "GetGuildRoster"),
  ]);
  if (identity.name !== "Olympus Mytikas" || identity.ruleset?.name !== "PvP"
      || listing._id !== "us-none-olympus-mytikas" || !Array.isArray(listing.roster)
      || !Number.isSafeInteger(identity.memberCount) || identity.memberCount < 0)
    throw new Error("Unexpected armory guild or member count");

  const members = new Map<string, { rank: number; fighter: Fighter }>();
  for (const row of listing.roster) {
    const character = row?.character;
    const rank = row?.rank?.rankId;
    if (!Number.isSafeInteger(rank) || rank < 0 || character?.region !== guild.region
        || typeof character._id !== "string" || !character._id.trim()
        || typeof character.name !== "string" || !character.name.trim()
        || (character.surname != null && typeof character.surname !== "string")
        || typeof character.class?.name !== "string" || !character.class.name.trim()
        || !Number.isSafeInteger(character.level) || character.level < 1)
      throw new Error("Malformed armory guild member");
    const name = [character.name.trim(), character.surname?.trim()].filter(Boolean).join(" ");
    const fighter = { name, class: character.class.name, level: character.level, armoryUrl: profileUrl(name) };
    const prior = members.get(character._id);
    if (prior && (prior.rank !== rank || prior.fighter.name !== name
        || prior.fighter.level !== fighter.level || prior.fighter.class !== fighter.class))
      throw new Error("Conflicting armory character records");
    members.set(character._id, { rank, fighter });
  }
  if (members.size !== identity.memberCount) throw new Error("Incomplete armory roster");
  return Array.from(members.values())
    .sort((a, b) => a.rank - b.rank || byName.compare(a.fighter.name, b.fighter.name))
    .map(({ fighter }) => fighter);
}

export function createFightersProvider(transport: typeof fetch = fetch, now = Date.now) {
  let snapshot: { fighters: Fighter[]; updatedAt: number } | undefined;
  let refresh: Promise<void> | undefined;
  let nextAttempt = 0;

  async function update() {
    try {
      const fighters = await fetchRoster(transport);
      const updatedAt = now();
      snapshot = { fighters, updatedAt };
      nextAttempt = updatedAt + freshForMs;
    } catch {
      // Keep the complete prior snapshot while the upstream service recovers.
      nextAttempt = now() + retryAfterMs;
    } finally {
      refresh = undefined;
    }
  }

  return async (requestedPage?: unknown): Promise<FightersPage> => {
    if (now() >= nextAttempt) refresh ??= update();
    if (refresh) await refresh;
    if (!snapshot) throw new HttpError(503, "The armory roster is temporarily unavailable.");
    const { fighters, updatedAt } = snapshot;
    const pageCount = Math.max(1, Math.ceil(fighters.length / pageSize));
    const parsedPage = typeof requestedPage === "string" && /^\d+$/.test(requestedPage)
      ? Number(requestedPage) : requestedPage;
    const page = typeof parsedPage === "number" && Number.isSafeInteger(parsedPage) && parsedPage > 0
      ? Math.min(parsedPage, pageCount) : 1;
    return {
      fighters: fighters.slice((page - 1) * pageSize, page * pageSize),
      total: fighters.length, page, pageCount,
      updatedAt: new Date(updatedAt).toISOString(),
      stale: now() - updatedAt >= freshForMs,
    };
  };
}
