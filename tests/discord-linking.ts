import assert from "node:assert/strict";
import { Client, harness } from "./harness.js";

const h = await harness();
const realFetch = globalThis.fetch;
const settings = {
  DISCORD_CLIENT_ID: "100",
  DISCORD_CLIENT_SECRET: "client-secret-fixture",
  DISCORD_GUILD_ID: "200",
  DISCORD_BOT_TOKEN: "bot-fixture",
};
const previous = new Map(
  Object.keys(settings).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, settings);

const tokenUrl = "https://discord.com/api/oauth2/token";
const userUrl = "https://discord.com/api/v10/users/@me";
const memberUrl = "https://discord.com/api/v10/guilds/200/members/301";
let tokenResponse = async () =>
  Response.json({ access_token: "grant-fixture" });
let identityResponse = async () =>
  Response.json({ id: "301", username: "Summit" });
let membershipResponse = () => Response.json({ user: { id: "301" } });
const tokenRequests: URLSearchParams[] = [];
const identityRequests: string[] = [];

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (new URL(url).origin === h.cfg.origin) return realFetch(input, init);
  if (url === tokenUrl) {
    assert.equal(init?.method, "POST");
    assert.ok(init.body instanceof URLSearchParams);
    tokenRequests.push(init.body);
    return tokenResponse();
  }
  if (url === userUrl) {
    identityRequests.push(
      new Headers(init?.headers).get("Authorization") || "",
    );
    return identityResponse();
  }
  assert.equal(url, memberUrl);
  assert.equal(
    new Headers(init?.headers).get("Authorization"),
    "Bot bot-fixture",
  );
  return membershipResponse();
};

async function begin(client: Client) {
  const result = await client.request("/api/discord/link", {});
  assert.equal(result.status, 200);
  const url = new URL(result.data.url);
  assert.equal(
    url.origin + url.pathname,
    "https://discord.com/oauth2/authorize",
  );
  assert.equal(url.searchParams.get("client_id"), settings.DISCORD_CLIENT_ID);
  assert.equal(url.searchParams.get("scope"), "identify");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    h.cfg.origin + "/api/discord/callback",
  );
  const state = url.searchParams.get("state");
  assert.ok(state);
  return state;
}

function callback(client: Client, state: string) {
  const params = new URLSearchParams({ state, code: "fixture-code" });
  return realFetch(h.cfg.origin + "/api/discord/callback?" + params, {
    headers: { Cookie: client.cookie },
    redirect: "manual",
  });
}

async function expectRedirect(request: Promise<Response>, outcome: string) {
  const response = await request;
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "/account.html?discord=" + outcome,
  );
}

try {
  // Recreate the server with its assigned origin, as production does at startup.
  await h.restart();
  const first = new Client(h.cfg.origin);
  const second = new Client(h.cfg.origin);
  await first.login();
  await second.login();
  assert.notEqual(first.cookie, second.cookie);

  const foreign = await begin(first);
  assert.equal((await callback(second, foreign)).status, 400);
  assert.equal(tokenRequests.length, 0);
  const replaced = await begin(first);
  assert.notEqual(foreign, replaced);
  assert.equal((await callback(first, foreign)).status, 400);
  await h.pool.query(
    "UPDATE discord_states SET expires_at=now() WHERE user_id=$1",
    [h.admin.id],
  );
  assert.equal((await callback(first, replaced)).status, 400);
  assert.equal(tokenRequests.length, 0);

  // Pause the provider after the first callback has claimed this state. A second
  // callback cannot reuse it, and unlinking from another browser wins the race.
  let signalExchange!: () => void;
  let finishExchange!: (response: Response) => void;
  const entered = new Promise<void>((resolve) => {
    signalExchange = resolve;
  });
  const resume = new Promise<Response>((resolve) => {
    finishExchange = resolve;
  });
  const validToken = tokenResponse;
  tokenResponse = async () => {
    signalExchange();
    return resume;
  };
  const pendingState = await begin(first);
  const pending = callback(first, pendingState);
  try {
    await Promise.race([
      entered,
      pending.then(() => assert.fail("Callback ended before token exchange")),
    ]);
    assert.equal((await callback(first, pendingState)).status, 400);
    assert.equal((await second.request("/api/discord/unlink", {})).status, 200);
  } finally {
    finishExchange(Response.json({ access_token: "grant-fixture" }));
  }
  await expectRedirect(pending, "cancelled");
  assert.equal(tokenRequests.length, 1);
  assert.equal((await first.request("/api/discord")).data.link, undefined);

  tokenResponse = validToken;
  const validIdentity = identityResponse;
  for (const brokenToken of [
    async () => new Response(null, { status: 503 }),
    async () => Response.json({}),
    async () => {
      throw new TypeError("fixture offline");
    },
  ]) {
    tokenResponse = brokenToken;
    const before = identityRequests.length;
    const state = await begin(first);
    await expectRedirect(callback(first, state), "unavailable");
    assert.equal(identityRequests.length, before);
    assert.equal((await callback(first, state)).status, 400);
  }
  tokenResponse = validToken;
  for (const brokenIdentity of [
    async () => new Response(null, { status: 429 }),
    async () => new Response("invalid JSON"),
    async () => Response.json({ id: 301, username: "Summit" }),
  ]) {
    identityResponse = brokenIdentity;
    await expectRedirect(callback(first, await begin(first)), "unavailable");
    assert.equal((await first.request("/api/discord")).data.link, undefined);
  }

  // Both website accounts receive the same verified Discord identity concurrently.
  identityResponse = validIdentity;
  const third = new Client(h.cfg.origin);
  await third.login("mod@example.test");
  const [one, two] = await Promise.all([begin(first), begin(third)]);
  const results = await Promise.all([
    callback(first, one),
    callback(third, two),
  ]);
  const locations = results.map((r) => r.headers.get("location"));
  assert.deepEqual(locations.toSorted(), [
    "/account.html?discord=duplicate",
    "/account.html?discord=linked",
  ]);
  const winner = locations[0]?.endsWith("=linked") ? first : third;
  const loser = winner === first ? third : first;
  assert.equal((await loser.request("/api/discord")).data.link, undefined);
  assert.equal(
    (await h.pool.query("SELECT discord_id FROM discord_links")).rowCount,
    1,
  );
  assert.ok(
    identityRequests.every((value) => value === "Bearer grant-fixture"),
  );
  for (const body of tokenRequests) {
    assert.equal(body.get("code"), "fixture-code");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("client_secret"), settings.DISCORD_CLIENT_SECRET);
    assert.equal(
      body.get("redirect_uri"),
      h.cfg.origin + "/api/discord/callback",
    );
  }

  for (const [status, body, expected] of [
    [404, { code: 10004 }, "temporarily unavailable"],
    [429, {}, "temporarily unavailable"],
    [404, { code: 10007 }, "outside the server"],
    [200, { user: { id: "301" } }, "confirmed"],
  ] as const) {
    membershipResponse = () => Response.json(body, { status });
    const info = await winner.request("/api/discord");
    assert.equal(info.status, 200);
    assert.equal(info.data.membership, expected);
    assert.deepEqual(info.data.link, { username: "Summit", discord_id: "301" });
    assert.ok(Number.isFinite(Date.parse(info.data.checkedAt)));
  }
  console.log(
    "Discord OAuth session, expiry, concurrent callback, provider failure and reconnection checks passed.",
  );
} finally {
  globalThis.fetch = realFetch;
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await h.stop();
}
