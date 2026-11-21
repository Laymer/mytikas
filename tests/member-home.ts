import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Zip from "adm-zip";
import { Client, harness } from "./harness.js";
import { transaction } from "../src/db.js";
import {
  parseReport,
  importReport,
  reportsTick,
  scanTick,
  warningTick,
} from "../src/blacklist.js";
import { syncReleases, validateArchive } from "../src/addon.js";
import { checkMembership, membershipResult } from "../src/armory.js";

const h = await harness(),
  { pool } = h,
  realFetch = fetch;
const guild = "123",
  channel = "456",
  author = { id: "555" };
let history: any[] = [],
  warnings: any[] = [],
  failSend = false,
  outage = false,
  discordId = "111",
  membership = 200;
const report = (id: string, name = "Moon", last = "Rise") => ({
  id,
  guild_id: guild,
  channel_id: channel,
  author,
  content: `Name: ${name}\nSurname: ${last}\nReason: private reason`,
  timestamp: new Date().toISOString(),
});
const zip = new Zip(),
  version = "2.0.1";
const files = [
  "Bootstrap.lua",
  "OlympusRecruit.lua",
  "KillOnSight.lua",
  "OlympusMytikas.lua",
];
zip.addFile(
  "OlympusMytikas/OlympusMytikas.toc",
  Buffer.from(["## Version: " + version, ...files].join("\n")),
);
for (const f of files)
  zip.addFile("OlympusMytikas/" + f, Buffer.from("-- test fixture"));
const bytes = zip.toBuffer(),
  digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
const env = {
  DISCORD_CLIENT_ID: "100",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: guild,
  DISCORD_BLACKLIST_CHANNEL_ID: channel,
  DISCORD_BOT_TOKEN: "fixture",
  ADDON_RELEASE_TOKEN: "fixture",
};
Object.assign(process.env, env);
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input));
  if (u.hostname === "127.0.0.1") return realFetch(input, init);
  if (u.hostname === "api.github.com") {
    if (outage) return new Response(null, { status: 503 });
    if (u.pathname.includes("/assets/"))
      return new Response(new Uint8Array(bytes));
    return Response.json([
      {
        tag_name: "v" + version,
        published_at: "2026-01-01",
        body: "Fixture",
        assets: [
          {
            id: 10,
            name: "OlympusMytikas-" + version + ".zip",
            size: bytes.length,
            digest,
            state: "uploaded",
          },
        ],
      },
    ]);
  }
  assert.equal(u.hostname, "discord.com");
  if (u.pathname.endsWith("/applications/@me"))
    return Response.json({flags: 1 << 19, bot: {id: "888"}});
  if (u.pathname.endsWith("/permissions/member/888"))
    return Response.json({permissions: "68608"});
  if (u.pathname.endsWith("/oauth2/token"))
    return Response.json({ access_token: "fixture" });
  if (u.pathname.endsWith("/users/@me"))
    return Response.json({
      id:
        (init?.headers as any)?.Authorization === "Bot fixture"
          ? "888"
          : discordId,
      username: "Hiker",
    });
  if (u.pathname.includes("/members/"))
    return Response.json({ code: 10007 }, { status: membership });
  if (u.pathname.endsWith("/channels/" + channel))
    return Response.json({ id: channel, guild_id: guild });
  if (init?.method === "POST") {
    const msg = {
      id: String(900 + warnings.length),
      channel_id: channel,
      author: { id: "888" },
      content: JSON.parse(String(init.body)).content,
    };
    warnings.push(msg);
    if (failSend) throw new Error("Ambiguous send");
    return Response.json(msg);
  }
  const after = BigInt(u.searchParams.get("after") || 0);
  return Response.json(
    [...history, ...warnings]
      .filter((m) => BigInt(m.id) > after)
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, Number(u.searchParams.get("limit"))),
  );
};
try {
  assert.equal(validateArchive(bytes, version, digest), digest.slice(7));
  assert.throws(() => validateArchive(bytes, "1.0.0", digest));
  assert.throws(() => validateArchive(bytes, "2.0.2", digest));
  assert.throws(() => validateArchive(bytes, version, "wrong"));
  await syncReleases(pool);
  outage = true;
  await assert.rejects(syncReleases(pool));
  const admin = new Client(h.cfg.origin),
    user = new Client(h.cfg.origin),
    other = new Client(h.cfg.origin);
  assert.equal((await user.request("/api/addon")).status, 401);
  assert.equal((await user.request("/api/addon/" + version)).status, 401);
  await admin.login();
  await user.signup("Moon Rise");
  await other.login("mod@example.test");
  assert.equal((await other.request("/api/addon")).status, 200);
  assert.equal((await other.request("/api/blacklist")).status, 403);
  const id = (await user.application()).application.id;
  assert.equal((await user.request("/api/addon")).data[0].version, version);
  const download = await fetch(h.cfg.origin + "/api/addon/" + version, {
    headers: { Cookie: user.cookie },
  });
  assert.match(download.headers.get("Cache-Control")!, /no-store/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  for (const m of [
    { ...report("1"), author: { ...author, bot: true } },
    { ...report("1"), webhook_id: "1" },
    ...["extra\n", "\n", "\u003e ", "```"].map((prefix) => ({
      ...report("1"),
      content: prefix + report("1").content,
    })),
    { ...report("1"), content: "Name: Moon\nSurname: Rise\nReason: " },
  ])
    assert.equal(parseReport(m), undefined);
  await admin.request("/api/admin/applications/" + id + "/approve", {});
  let finish!: (s: string) => void, started!: () => void;
  const start = new Promise<void>((r) => (started = r));
  const check = checkMembership(pool, id, async () => {
    started();
    return new Promise((r) => (finish = r));
  });
  await start;
  history = [
    report("101"),
    report("102"),
    report("103", "Unregistered", "Player"),
  ];
  await reportsTick(pool);
  await reportsTick(pool);
  finish("MATCH");
  await check;
  const detail = await user.application();
  assert.equal(detail.application.status, "BLACKLISTED");
  assert(!JSON.stringify(detail).includes("private reason"));
  assert.equal((await user.request("/api/addon")).status, 403);
  assert.equal((await user.request("/api/addon/" + version)).status, 403);
  assert.equal(
    (await admin.request("/api/admin/applications/" + id + "/join", {})).status,
    409,
  );
  const list = (await admin.request("/api/blacklist")).data;
  assert.equal(list.reports.length, 3);
  assert.equal(list.checkpoints[0].last_id, "103");
  assert.equal(
    (await admin.request("/api/blacklist/101/void", { reason: "" })).status,
    400,
  );
  assert.equal(
    (
      await admin.request("/api/blacklist/101/void", {
        reason: "Wrong character",
      })
    ).status,
    200,
  );
  assert.equal((await user.application()).application.status, "BLACKLISTED");
  assert.equal(
    (
      await admin.request("/api/blacklist/102/void", {
        reason: "Duplicate mistake",
      })
    ).status,
    200,
  );
  assert.equal((await user.application()).application.status, "SUBMITTED");
  const outsider = new Client(h.cfg.origin);
  await outsider.signup("Unregistered Player");
  assert.equal(
    (await outsider.application()).application.status,
    "BLACKLISTED",
  );
  for (const result of [
    "MATCH",
    "MATCH",
    "PROFILE_NOT_FOUND",
    "UNAVAILABLE",
    "MALFORMED_PROFILE",
    "GUILD_MISMATCH",
    "MATCH",
  ]) {
    await pool.query("UPDATE blacklist_checks SET scan_day=current_date-2");
    await scanTick(pool, async () => result);
  }
  assert.equal(
    (await pool.query("SELECT * FROM blacklist_warnings")).rowCount,
    2,
  );
  await warningTick(pool, h.cfg.origin);
  failSend = true;
  await assert.rejects(warningTick(pool, h.cfg.origin));
  failSend = false;
  for (let i = 0; i < 4; i++) await warningTick(pool, h.cfg.origin);
  assert.equal(warnings.length, 2);
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM blacklist_warnings WHERE delivered_id IS NOT NULL",
      )
    ).rowCount,
    2,
  );
  assert(!warnings.some((w) => w.content.includes("private reason")));
  assert.equal(
    membershipResult(
      {
        name: "Moon",
        surname: "Rise",
        region: "us",
        ruleset: { slug: "pvp" },
        guild: {},
      },
      "Moon Rise",
    ),
    "MALFORMED_PROFILE",
  );
  const racer = new Client(h.cfg.origin);
  await racer.signup("Race Character");
  const raceId = (await racer.application()).application.id;
  const ingest = (msgId: string) =>
    transaction(pool, (c) =>
      importReport(c, report(msgId, "Race", "Character"), guild, channel),
    );
  const staff = (act: string) =>
    admin.request("/api/admin/applications/" + raceId + "/" + act, {
      note: "fixture",
    });
  await Promise.all([staff("approve"), ingest("201")]);
  assert.equal((await racer.application()).application.status, "BLACKLISTED");
  await admin.request("/api/blacklist/201/void", { reason: "Wrong target" });
  await staff("approve");
  await staff("join");
  assert.equal((await racer.request("/api/addon")).status, 200);
  const roster = (await admin.request("/api/rosters")).data.rosters[0];
  roster.slots[0].memberId = raceId;
  await Promise.all([
    admin.request("/api/admin/rosters/10", roster),
    ingest("202"),
  ]);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM roster_slots WHERE application_id=$1", [
        raceId,
      ])
    ).rowCount,
    0,
  );
  await admin.request("/api/blacklist/202/void", { reason: "Wrong target" });
  await staff("approve");
  await staff("join");
  await staff("remove");
  await Promise.all([staff("restore"), ingest("203")]);
  assert.equal((await racer.application()).application.status, "BLACKLISTED");
  async function state(client: Client) {
    return new URL(
      (await client.request("/api/discord/link", {})).data.url,
    ).searchParams.get("state");
  }
  const callback = (client: Client, s: string | null, rest = "code=mock") =>
    realFetch(h.cfg.origin + "/api/discord/callback?state=" + s + "&" + rest, {
      redirect: "manual",
      headers: { Cookie: client.cookie },
    });
  let s = await state(user);
  assert.equal((await callback(other, s)).status, 400);
  assert.match((await callback(user, s)).headers.get("location")!, /linked/);
  assert.equal((await callback(user, s)).status, 400);
  for (const [status, label] of [
    [200, "confirmed"],
    [404, "outside the server"],
    [503, "temporarily unavailable"],
  ] as const) {
    membership = status;
    assert.equal((await user.request("/api/discord")).data.membership, label);
  }
  s = await state(other);
  assert.match(
    (await callback(other, s)).headers.get("location")!,
    /duplicate/,
  );
  s = await state(other);
  assert.match(
    (await callback(other, s, "error=access_denied")).headers.get("location")!,
    /cancelled/,
  );
  await user.request("/api/discord/unlink", {});
  assert.equal((await user.request("/api/discord")).data.link, undefined);
  console.log(
    "Member Home release, access, moderation, warning recovery and OAuth fixtures passed.",
  );
} finally {
  globalThis.fetch = realFetch;
  await h.stop();
}
