import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { syncReleases } from "../src/addon.js";
import { Client, harness } from "./harness.js";
import { packageZip, prefix } from "./addon-fixture.js";

const h = await harness();
const admin = new Client(h.cfg.origin),
  moderator = new Client(h.cfg.origin),
  applicant = new Client(h.cfg.origin),
  anonymous = new Client(h.cfg.origin);
const route = "/api/admin/addon/releases",
  version = "2.3.4";
const bytes = packageZip(version);
const sha = (archive: Buffer) =>
  createHash("sha256").update(archive).digest("hex");
const formerPause = process.env.MEMBERSHIP_DECISIONS_PAUSED;
async function upload(
  actor: Client,
  archive = bytes,
  overrides: Record<string, string> = {},
  path = route,
) {
  return fetch(h.cfg.origin + path, {
    method: "POST",
    headers: {
      Cookie: actor.cookie,
      "X-CSRF-Token": actor.csrf,
      Origin: h.cfg.origin,
      "Content-Type": "application/zip",
      "X-Addon-Version": version,
      "X-Addon-SHA256": sha(archive),
      ...overrides,
    },
    body: new Uint8Array(archive),
  });
}
try {
  await Promise.all([
    admin.login(),
    moderator.login("mod@example.test"),
    anonymous.init(),
  ]);
  assert.equal((await applicant.signup("Addon Member")).status, 201);
  for (const [client, status] of [
    [anonymous, 401],
    [moderator, 403],
    [applicant, 403],
  ] as const) {
    assert.equal((await upload(client)).status, status);
  }
  for (const headers of [
    { "X-CSRF-Token": "" },
    { Origin: "https://elsewhere.example" },
    { "Sec-Fetch-Site": "cross-site" },
  ] as Record<string, string>[]) {
    assert.equal((await upload(admin, bytes, headers)).status, 403);
  }
  assert.equal((await admin.request(route, {})).status, 415);
  assert.equal(
    (await upload(admin, bytes, { "Content-Encoding": "gzip" })).status,
    415,
  );
  assert.equal(
    (await upload(admin, bytes, {}, "/api/admin/rules")).status,
    400,
  );

  // Even valid credentials cannot publish a bad ZIP or inconsistent metadata.
  for (const invalid of ["v2.3.4", "2.3.4-rc.1", "02.3.4", "123456789.0.0"]) {
    assert.equal(
      (await upload(admin, bytes, { "X-Addon-Version": invalid })).status,
      400,
    );
  }
  for (const invalid of ["", "123", "0".repeat(64)]) {
    assert.equal(
      (await upload(admin, bytes, { "X-Addon-SHA256": invalid })).status,
      400,
    );
  }
  for (const notes of ["%E0%A4", "%00", "a".repeat(2049)]) {
    assert.equal(
      (await upload(admin, bytes, { "X-Addon-Notes": notes })).status,
      400,
    );
  }
  for (const invalid of [
    Buffer.from("invalid archive"),
    packageZip("9.0.0"),
    packageZip(version, (zip) => {
      for (let n = 0; n < 2048; n++)
        zip.addFile(prefix + "resource-" + n, Buffer.alloc(0));
    }),
    packageZip(version, (zip) => zip.deleteFile(prefix + "OlympusRecruit.lua")),
    packageZip(version, (zip) =>
      zip.addFile(prefix + "large.bin", Buffer.alloc(16_000_001)),
    ),
  ]) {
    assert.equal((await upload(admin, invalid)).status, 400);
  }
  assert.equal(
    (await upload(admin, packageZip("1.0.0"), { "X-Addon-Version": "1.0.0" }))
      .status,
    400,
  );
  assert.equal((await upload(admin, Buffer.alloc(8_000_001))).status, 413);
  assert.equal(
    (await h.pool.query("SELECT version FROM addon_releases")).rowCount,
    0,
  );

  process.env.MEMBERSHIP_DECISIONS_PAUSED = "1";
  const notes = "Δοκιμή\n50% complete 🔧",
    created = await upload(admin, bytes, {
      "X-Addon-Notes": encodeURIComponent(notes),
    });
  assert.equal(created.status, 201);
  assert.match(created.headers.get("cache-control")!, /no-store/);
  const metadata = await created.json();
  assert.deepEqual(Object.keys(metadata).sort(), [
    "notes",
    "published_at",
    "sha256",
    "version",
  ]);
  assert.equal(metadata.version, version);
  assert.equal(metadata.notes, notes);
  assert.equal(metadata.sha256, sha(bytes));
  assert.ok(Number.isFinite(Date.parse(metadata.published_at)));
  delete process.env.MEMBERSHIP_DECISIONS_PAUSED;
  const alternative = packageZip(version, (zip) =>
    zip.updateFile(
      prefix + "Bootstrap.lua",
      Buffer.from("-- Different packaged bytes"),
    ),
  );
  assert.equal((await upload(admin)).status, 409);
  assert.equal((await upload(admin, alternative)).status, 409);
  assert.deepEqual((await applicant.request("/api/addon")).data, [metadata]);
  const downloaded = await fetch(h.cfg.origin + "/api/addon/" + version, {
    headers: { Cookie: applicant.cookie },
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal((await anonymous.request("/api/addon/" + version)).status, 401);

  const racingVersion = "2.3.5",
    racingBytes = packageZip(racingVersion);
  const racers = await Promise.all(
    ["First notes", "Second notes"].map((n) =>
      upload(admin, racingBytes, {
        "X-Addon-Version": racingVersion,
        "X-Addon-Notes": n,
      }),
    ),
  );
  assert.deepEqual(racers.map((r) => r.status).sort(), [201, 409]);
  const winner = await racers.find((r) => r.status === 201)!.json();
  assert.equal(
    (
      await h.pool.query("SELECT notes FROM addon_releases WHERE version=$1", [
        racingVersion,
      ])
    ).rows[0].notes,
    winner.notes,
  );

  // Finish an authenticated upload while the worker is fetching the same version.
  const oldFetch = globalThis.fetch,
    oldToken = process.env.ADDON_RELEASE_TOKEN;
  const shared = "2.3.7",
    uploaded = packageZip(shared),
    upstream = packageZip(shared, (zip) =>
      zip.addFile(prefix + "Changelog.txt", Buffer.from("Upstream copy")),
    );
  try {
    process.env.ADDON_RELEASE_TOKEN = "fixture-only";
    globalThis.fetch = async (url, init) => {
      const target = new URL(String(url));
      if (target.origin === h.cfg.origin) return oldFetch(url, init);
      assert.equal(target.origin, "https://api.github.com");
      if (target.pathname.endsWith("/releases"))
        return Response.json([
          {
            tag_name: "v" + shared,
            published_at: "2026-01-01T00:00:00Z",
            body: "Upstream notes",
            assets: [
              {
                id: 7,
                name: "OlympusMytikas-" + shared + ".zip",
                state: "uploaded",
                size: upstream.length,
                digest: "sha256:" + sha(upstream),
              },
            ],
          },
        ]);
      assert.ok(target.pathname.endsWith("/assets/7"));
      assert.equal(
        (
          await upload(admin, uploaded, {
            "X-Addon-Version": shared,
            "X-Addon-Notes": "Uploaded",
          })
        ).status,
        201,
      );
      return new Response(new Uint8Array(upstream));
    };
    await syncReleases(h.pool);
    const afterSync = (
      await h.pool.query(
        "SELECT notes,archive FROM addon_releases WHERE version=$1",
        [shared],
      )
    ).rows[0];
    assert.equal(afterSync.notes, "Uploaded");
    assert.deepEqual(afterSync.archive, uploaded);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.ADDON_RELEASE_TOKEN;
    else process.env.ADDON_RELEASE_TOKEN = oldToken;
  }

  // Wait until publication has rechecked the database role, then finish demoting the actor.
  const connection = await h.pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("UPDATE users SET role='MODERATOR' WHERE id=$1", [
      h.admin.id,
    ]);
    const next = "2.3.6",
      pending = upload(admin, packageZip(next), { "X-Addon-Version": next });
    let waiting = false;
    for (let i = 0; i < 1000 && !waiting; i++) {
      waiting = !!(
        await h.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT role FROM users%FOR SHARE'",
        )
      ).rowCount;
      if (!waiting) await delay(10);
    }
    assert.ok(
      waiting,
      "Publication must check the administrator's current role before inserting.",
    );
    await connection.query("COMMIT");
    assert.equal((await pending).status, 403);
    assert.equal(
      (
        await h.pool.query(
          "SELECT version FROM addon_releases WHERE version=$1",
          [next],
        )
      ).rowCount,
      0,
    );
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
  console.log(
    "Addon upload role and CSRF checks, ZIP limits, private download, immutable duplicates, concurrency and demotion passed.",
  );
} finally {
  if (formerPause === undefined) delete process.env.MEMBERSHIP_DECISIONS_PAUSED;
  else process.env.MEMBERSHIP_DECISIONS_PAUSED = formerPause;
  await h.stop();
}
