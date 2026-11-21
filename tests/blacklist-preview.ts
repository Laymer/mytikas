import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, harness } from "./harness.js";
import { reportsTick, warningTick } from "../src/blacklist.js";

const h = await harness();
const dir = await mkdtemp(join(tmpdir(), "mytikas-preview-"));
const guild = "552001",
  channel = "552002";
const credential = "private-preview-fixture";
const privateReason = "Officer-only fixture reason";
const baseline = 1000000000000000000n;
function message(i: number, name: string, surname: string) {
  return {
    id: String(baseline + BigInt(i)),
    channel_id: channel,
    guild_id: guild,
    author: { id: "999" },
    content: `Name: ${name}\nSurname: ${surname}\nReason: ${privateReason}`,
  };
}
try {
  const applicant = new Client(h.cfg.origin);
  await applicant.signup("Silver Pine");
  const db = new URL(h.cfg.databaseUrl);
  await h.pool.query(
    "CREATE ROLE preview_reader LOGIN PASSWORD 'fixture-password'",
  );
  await h.pool.query(
    "GRANT SELECT(character_key) ON applications TO preview_reader",
  );
  db.username = "preview_reader";
  db.password = "fixture-password";
  const headersPath = "/channels/" + channel;
  const preload = join(dir, "discord-fixture.mjs");
  // Run the operator's actual CLI with an HTTP fixture and a SELECT-only role.
  await writeFile(
    preload,
    `
    import assert from 'node:assert/strict';
    const pages = JSON.parse(process.env.FIXTURE_PAGES);
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://discord.com');
      assert.equal(init.headers.Authorization, 'Bot ' + process.env.DISCORD_BOT_TOKEN);
      assert.equal(init.method ?? 'GET','GET');
      if (url.pathname === '/api/v10/applications/@me') return Response.json({flags:Number(process.env.FIXTURE_FLAGS),bot:{id:'123456'}});
      if (url.pathname === '/api/v10${headersPath}') return Response.json({id:'${channel}',guild_id: process.env.FIXTURE_GUILD});
      if (url.pathname === '/api/v10${headersPath}/permissions/member/123456') return Response.json({permissions: process.env.FIXTURE_PERMISSIONS});
      assert.equal(url.pathname, '/api/v10${headersPath}/messages');
      assert.equal(url.searchParams.get('limit'), '100');
      const page = pages[url.searchParams.get('after')];
      return page === undefined ? new Response(null, {status: 503}) : Response.json(page);
    };
  `,
  );
  function preview(
    pages: Record<string, unknown>,
    extra: Record<string, string> = {},
  ) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", preload, "src/blacklist-preview.ts"],
      {
        encoding: "utf8",
        timeout: 8000,
        env: {
          ...process.env,
          DATABASE_URL: db.href,
          DISCORD_GUILD_ID: guild,
          DISCORD_BLACKLIST_CHANNEL_ID: channel,
          DISCORD_BOT_TOKEN: credential,
          FIXTURE_GUILD: guild,
          FIXTURE_FLAGS: String(1 << 19),
          FIXTURE_PERMISSIONS: "68608",
          FIXTURE_PAGES: JSON.stringify(pages),
          ...extra,
        },
      },
    );
  }
  const firstPage = Array.from({ length: 100 }, (_, i) => ({
    ...message(i + 1, "Silver", "Pine"),
    content: i < 2 ? message(i + 1, "Silver", "Pine").content : "Guild chat",
  })).reverse();
  const lastId = String(baseline + 100n);
  const lastPage = [
    message(103, "Unlisted", "Walker"),
    { ...message(102, "Skip", "Bot"), author: { id: "998", bot: true } },
    message(101, "SILVER", "PINE"),
  ];
  const complete = preview({ "0": firstPage, [lastId]: lastPage });
  assert.equal(complete.status, 0, complete.stderr);
  assert.deepEqual(JSON.parse(complete.stdout), {
    messages: 103,
    reports: 4,
    characters: 2,
    matchedApplications: 1,
    lastId: String(baseline + 103n),
  });
  assert.deepEqual(JSON.parse(preview({ "0": [] }).stdout), {
    messages: 0,
    reports: 0,
    characters: 0,
    matchedApplications: 0,
    lastId: "0",
  });
  for (const run of [
    preview({ "0": firstPage }),
    preview({ "0": firstPage, [lastId]: firstPage }),
    preview({ "0": {} }),
    preview({ "0": [{ ...message(1, "Skip", "Guild"), guild_id: "123" }] }),
    preview({ "0": [{ ...message(1, "Skip", "Channel"), channel_id: "123" }] }),
    preview({ "0": [{ ...message(1, "Skip", "Message"), id: "invalid" }] }),
    preview({ "0": [] }, { FIXTURE_GUILD: "123" }),
    preview({ "0": [] }, { DISCORD_BOT_TOKEN: "" }),
  ]) {
    assert.equal(run.status, 1, run.error?.message);
    assert.equal(run.stdout, "");
    assert.ok(
      !run.stderr.includes(privateReason) && !run.stderr.includes(credential),
    );
  }
  for (const [settings, error] of [
    [{ FIXTURE_FLAGS: "0" }, "Message Content Intent"],
    [{ FIXTURE_PERMISSIONS: "67584" }, "View Channel"],
    [{ FIXTURE_PERMISSIONS: "3072" }, "Read Message History"],
    [{ FIXTURE_PERMISSIONS: "66560" }, "Send Messages"],
    [{ FIXTURE_PERMISSIONS: "invalid" }, "channel permissions"],
  ] as const) {
    const result = preview({ "0": [] }, { ...settings } as Record<
      string,
      string
    >);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(error));
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(credential));
  }
  // An unexpected source page must leave the live import cursor at its last commit.
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    DISCORD_GUILD_ID: guild,
    DISCORD_BLACKLIST_CHANNEL_ID: channel,
    DISCORD_BOT_TOKEN: credential,
  });
  await h.pool.query("INSERT INTO blacklist_checkpoint VALUES($1,$2)", [
    channel,
    lastId,
  ]);
  let flags = 0,
    permissions = "66560"; // View and history, sufficient for importing reports.
  let requestedHistory = false;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/applications/@me"))
      return Response.json({ flags, bot: { id: "123456" } });
    if (path.endsWith("/permissions/member/123456"))
      return Response.json({ permissions });
    if (path.endsWith("/messages")) {
      requestedHistory = true;
      return Response.json([
        lastPage[0],
        { ...lastPage[1], channel_id: "123" },
      ]);
    }
    return Response.json({ id: channel, guild_id: guild });
  };
  try {
    await assert.rejects(reportsTick(h.pool), /Message Content Intent/);
    flags = 1 << 18;
    permissions = "1024";
    await assert.rejects(reportsTick(h.pool), /Read Message History/);
    assert.equal(requestedHistory, false);
    permissions = "66560";
    await assert.rejects(warningTick(h.pool, h.cfg.origin), /Send Messages/);
    assert.equal(requestedHistory, false);
    await assert.rejects(reportsTick(h.pool), /source mismatch/);
    assert.equal(requestedHistory, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(
    (await h.pool.query("SELECT last_id FROM blacklist_checkpoint")).rows,
    [{ last_id: lastId }],
  );
  assert.equal(
    (await h.pool.query("SELECT 1 FROM blacklist_reports")).rowCount,
    0,
  );
  console.log(
    "Read-only blacklist preview counts, private output, pagination and checkpoint integrity passed.",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
  await h.stop();
}
