import assert from "node:assert/strict";
import { createFightersProvider } from "../src/fighters.js";
import { HttpError } from "../src/validation.js";

const guildId = "us-none-olympus-mytikas";
function member(id: number) {
  return {
    rank: { rankId: 5 },
    character: {
      _id: `us-summit-${id}`, name: "Summit", surname: String(id).padStart(2, "0"),
      level: id + 1, region: "us", class: { name: "Paladin" },
    },
  };
}
const rows = Array.from({ length: 27 }, (_, i) => member(i));
rows[26]!.rank.rankId = 0;
rows[26]!.character.name = "Bäba";
rows[26]!.character.surname = "Yäga";
const identity = { name: "Olympus Mytikas", ruleset: { name: "PvP" }, memberCount: rows.length };
const listing = { _id: guildId, roster: [...rows].reverse().concat(rows[0]!) };
let currentTime = Date.UTC(2026, 10, 24);
let calls = 0;
type Reply = (operation: string) => Response;
const success: Reply = op => Response.json({ data: { Guild: op === "GetGuildRoster" ? listing : identity } });
let reply = success;
const transport: typeof fetch = async (url, init) => {
  calls++;
  assert.equal(url, "https://worldofwarcraft.blizzard.com/en-us/graphql");
  assert.equal(init?.method, "POST");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal);
  const headers = new Headers(init.headers);
  assert.equal(headers.get("Referer"), "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/guild/olympus-mytikas");
  const { operationName, variables, extensions } = JSON.parse(String(init.body));
  assert.deepEqual(variables.guild, { region: "us", nameSlug: "olympus-mytikas" });
  assert.equal(extensions.persistedQuery.version, 1);
  assert.match(extensions.persistedQuery.sha256Hash, /^[a-f0-9]{64}$/);
  return reply(operationName);
};
const getPage = createFightersProvider(transport, () => currentTime);
const [first, second] = await Promise.all([getPage(), getPage("999")]);
assert.equal(calls, 2);
assert.deepEqual({ total: first.total, page: first.page, pageCount: first.pageCount, stale: first.stale },
  { total: 27, page: 1, pageCount: 2, stale: false });
assert.equal(first.fighters.length, 25);
assert.equal(second.page, 2);
assert.deepEqual(second.fighters.map(f => f.name), ["Summit 24", "Summit 25"]);
assert.deepEqual(first.fighters[0], {
  name: "Bäba Yäga", class: "Paladin", level: 27,
  armoryUrl: "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/character/b%C3%A4ba-y%C3%A4ga",
});
assert.equal(first.fighters[1]?.level, 1);
for (const invalid of [0, -1, "1e2", "0", "1.5", ["2"], undefined])
  assert.equal((await getPage(invalid)).page, 1);
assert.equal(calls, 2);

currentTime += 15 * 60_000;
reply = () => new Response("Overloaded", { status: 429 });
const stale = await getPage(2);
assert.deepEqual(stale, { ...second, stale: true });
await getPage();
assert.equal(calls, 4);
currentTime += 30_000;
reply = success;
const recovered = await getPage(2);
assert.equal(recovered.stale, false);
assert.equal(recovered.updatedAt, new Date(currentTime).toISOString());
assert.equal(calls, 6);

function fixture(guildData: unknown, rosterData: unknown) {
  return createFightersProvider(async (_url, init) => {
    const { operationName } = JSON.parse(String(init?.body));
    return Response.json({ data: { Guild: operationName === "GetGuildRoster" ? rosterData : guildData } });
  });
}
const unavailable = (e: unknown) => e instanceof HttpError && e.status === 503;
const singleName = {
  rank: { rankId: 1 },
  character: { ...member(0).character, name: "Áda", surname: null },
};
const solo = await fixture({ ...identity, memberCount: 1 }, { _id: guildId, roster: [singleName] })();
assert.equal(solo.fighters[0]?.name, "Áda");
assert.equal(solo.fighters[0]?.armoryUrl,
  "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/character/%C3%A1da");
for (const bad of [
  fixture({ ...identity, ruleset: { name: "PvE" } }, listing),
  fixture({ ...identity, name: "Other" }, listing),
  fixture({ ...identity, memberCount: 28 }, listing),
  fixture(identity, { ...listing, _id: "eu-none-olympus-mytikas" }),
  fixture(identity, { ...listing, roster: null }),
  fixture(identity, { ...listing, roster: [] }),
  fixture(identity, { ...listing, roster: [...listing.roster, { rank: { rankId: 2 }, character: rows[0]!.character }] }),
  fixture(identity, { ...listing, roster: [{ rank: rows[0]!.rank, character: { ...rows[0]!.character, region: "eu" } }] }),
  fixture(identity, { ...listing, roster: [null] }),
  createFightersProvider(async () => Response.json({ data: { Guild: listing }, errors: [{ message: "partial" }] })),
  createFightersProvider(async () => new Response("malformed")),
  createFightersProvider(async () => new Response("large", { headers: { "Content-Length": "2000001" } })),
  createFightersProvider(async () => { throw new Error("unavailable"); }),
]) await assert.rejects(() => bad(), unavailable);

let coldCalls = 0;
const cold = createFightersProvider(async () => {
  coldCalls++;
  return new Response(null, { status: 503 });
}, () => currentTime);
await assert.rejects(() => cold(), unavailable);
await assert.rejects(() => cold(), unavailable);
assert.equal(coldCalls, 2);
const empty = await fixture({ ...identity, memberCount: 0 }, { ...listing, roster: [] })("2");
assert.equal(empty.total, 0);
assert.equal(empty.page, 1);
assert.equal(empty.pageCount, 1);
assert.equal(empty.stale, false);
assert.deepEqual(empty.fighters, []);
console.log("Guild armory ingestion, rank ordering, pagination, and cache checks passed.");
