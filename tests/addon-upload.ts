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
const previousGate = process.env.ADDON_SUBMISSIONS_ENABLED;
const formerPause = process.env.MEMBERSHIP_DECISIONS_PAUSED;
async function upload(
  actor: Client,
  archive = bytes,
  overrides: Record<string, string | undefined> = {},
  path = route,
) {
  const headers = new Headers({
    Cookie: actor.cookie,
    "X-CSRF-Token": actor.csrf,
    Origin: h.cfg.origin,
    "Content-Type": "application/zip",
    "X-Addon-Version": version,
    "X-Addon-Notes": "Player-visible fixes",
    "X-Addon-SHA256": sha(archive),
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) headers.delete(name);
    else headers.set(name, value);
  }
  return fetch(h.cfg.origin + path, {
    method: "POST",
    headers,
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
  const history = "/api/admin/addon/submissions";
  assert.equal((await anonymous.request(history)).status, 401);
  assert.equal((await moderator.request(history)).status, 403);
  assert.equal((await applicant.request(history)).status, 403);
  delete process.env.ADDON_SUBMISSIONS_ENABLED;
  assert.equal((await upload(admin)).status, 503);
  process.env.ADDON_SUBMISSIONS_ENABLED = "1";
  assert.equal((await upload(admin, bytes, {"X-Addon-Version": undefined})).status, 400);
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
  for (const notes of [undefined, "", "%20%0A", "%E0%A4", "%00", "a".repeat(2049)]) {
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
  const detected = { "X-Addon-Version": version };
  const skipped = {
    ...detected,
    "X-Addon-Checksum-Mode": "skip",
    "X-Addon-SHA256": undefined,
  };
  for (const [body, headers, expected] of [
    [bytes, { ...detected, "X-Addon-SHA256": undefined }, /supply.*SHA-256/i],
    [
      bytes,
      { ...detected, "X-Addon-Checksum-Mode": "other" },
      /verify or skip/,
    ],
    [
      bytes,
      { ...detected, "X-Addon-Checksum-Mode": "skip" },
      /omit the supplied SHA-256/i,
    ],
    [
      bytes,
      { ...skipped, "X-Addon-Version": "3.2.1" },
      /does not match.*2\.3\.4/,
    ],
    [packageZip("1.0.0"), { ...skipped, "X-Addon-Version": "1.0.0" }, /1\.0\.0 requires the original/],
    [
      packageZip(version, (z) => z.deleteFile(prefix + "OlympusMytikas.toc")),
      skipped,
      /Include OlympusMytikas\/OlympusMytikas\.toc/,
    ],
    [
      packageZip(version, (z) => z.deleteFile(prefix + "Bootstrap.lua")),
      detected,
      /include that file/,
    ],
    [packageZip("nightly"), detected, /stable ## Version: X\.Y\.Z/],
  ] as const) {
    const rejected = await upload(admin, body, headers);
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, expected);
  }
  assert.equal((await upload(moderator, bytes, skipped)).status, 403);
  assert.equal(
    (await h.pool.query("SELECT version FROM addon_releases")).rowCount,
    0,
  );

  process.env.MEMBERSHIP_DECISIONS_PAUSED = "1";
  const notes = "  Δοκιμή\n50% complete 🔧  ",
    created = await upload(admin, bytes, {
      ...detected,
      "X-Addon-Notes": encodeURIComponent(notes),
    });
  assert.equal(created.status, 202);
  assert.match(created.headers.get("cache-control")!, /no-store/);
  const metadata = await created.json();
  const statusUrl = created.headers.get("location");
  assert.equal(statusUrl, history + "/" + metadata.id);
  assert.deepEqual((await admin.request(statusUrl!)).data, metadata);
  assert.equal((await applicant.request(statusUrl!)).status, 403);
  assert.equal((await admin.request(history + "/0")).status, 404);
  assert.equal((await admin.request(history + "/9223372036854775808")).status, 404);
  assert.equal((await admin.request(history + "/10000")).status, 404);
  assert.equal(metadata.status, "queued");
  assert.equal(metadata.version, version);
  assert.equal(metadata.notes, notes);
  assert.equal(metadata.sha256, sha(bytes));
  assert.equal(metadata.archive_id, null);
  assert.ok(Number.isFinite(Date.parse(metadata.created_at)));
  assert.equal("archive" in metadata, false);
  assert.deepEqual((await admin.request(history)).data, [metadata]);
  delete process.env.MEMBERSHIP_DECISIONS_PAUSED;
  assert.deepEqual((await applicant.request("/api/addon")).data, []);
  assert.equal((await applicant.request("/api/addon/" + version)).status, 404);
  const retry = await upload(admin, bytes, { ...skipped, "X-Addon-Notes": encodeURIComponent(notes) });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), metadata);
  assert.equal((await upload(admin)).status, 409); // conflicting notes
  const alternative = packageZip(version, (zip) =>
    zip.updateFile(prefix + "Bootstrap.lua", Buffer.from("-- Different packaged bytes")),
  );
  assert.equal((await upload(admin, alternative)).status, 409);
  const stored = (await h.pool.query("SELECT submitted_by, archive FROM addon_submissions WHERE id=$1", [metadata.id])).rows[0];
  assert.equal(stored.submitted_by, h.admin.id);
  assert.deepEqual(stored.archive, bytes);
  await h.pool.query("INSERT INTO addon_releases VALUES ('1.1.2',now(),'Legacy',$1,$2)", [sha(bytes), bytes]);
  assert.equal((await upload(admin, packageZip("1.1.2"), { "X-Addon-Version": "1.1.2" })).status, 409);
  assert.equal((await applicant.request("/api/addon")).data.length, 1);
  const noComparison = packageZip("2.3.8");
  const noComparisonResponse = await upload(admin, noComparison, { ...skipped, "X-Addon-Version": "2.3.8" });
  assert.equal(noComparisonResponse.status, 202);
  const bypassedComparison = await noComparisonResponse.json();
  assert.equal(bypassedComparison.sha256, sha(noComparison));
  assert.ok(BigInt(bypassedComparison.id) > BigInt(metadata.id));

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
  assert.deepEqual(racers.map((r) => r.status).sort(), [202, 409]);
  const winner = await racers.find((r) => r.status === 202)!.json();
  assert.equal(
    (
      await h.pool.query("SELECT notes FROM addon_submissions WHERE version=$1", [
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
        202,
      );
      return new Response(new Uint8Array(upstream));
    };
    await syncReleases(h.pool);
    const afterSync = (
      await h.pool.query(
        "SELECT notes,archive FROM addon_submissions WHERE version=$1",
        [shared],
      )
    ).rows[0];
    assert.equal(afterSync.notes, "Uploaded");
    assert.deepEqual(afterSync.archive, uploaded);
    assert.equal((await h.pool.query("SELECT 1 FROM addon_releases WHERE version=$1", [shared])).rowCount, 0);
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
          "SELECT version FROM addon_submissions WHERE version=$1",
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
  if (previousGate === undefined) delete process.env.ADDON_SUBMISSIONS_ENABLED;
  else process.env.ADDON_SUBMISSIONS_ENABLED = previousGate;
  await h.stop();
}
