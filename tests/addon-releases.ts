import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type Zip from "adm-zip";
import { packageZip, prefix, scripts } from "./addon-fixture.js";
import { syncReleases, validateArchive } from "../src/addon.js";
import { Client, PASS, harness, mailToken } from "./harness.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = (bytes: Buffer) => "sha256:" + sha(bytes);
const version = "1.10.0";
for (const [configure, error] of [
  [
    (zip: Zip) =>
      zip.addFile("Standalone/OldAddon.toc", Buffer.from("old addon")),
    /layout/,
  ],
  [(zip: Zip) => zip.deleteFile(prefix + "Bootstrap.lua"), /manifest/],
  [
    (zip: Zip) =>
      zip.updateFile(
        prefix + "OlympusMytikas.toc",
        Buffer.from(
          ["## Version: " + version, "## Version: 1.9.0", ...scripts].join(
            "\n",
          ),
        ),
      ),
    /manifest/,
  ],
] as const) {
  const bytes = packageZip(version, configure);
  assert.throws(() => validateArchive(bytes, version, digest(bytes)), error);
}

const h = await harness();
const originalFetch = globalThis.fetch;
const oldToken = process.env.ADDON_RELEASE_TOKEN;
try {
  const archives = new Map<number, Buffer>();
  function release(id: number, value: string) {
    const bytes = packageZip(value);
    archives.set(id, bytes);
    return {
      tag_name: "v" + value,
      published_at: "2026-01-01T00:00:00Z",
      body: "Fixture notes for " + value,
      draft: false,
      prerelease: false,
      assets: [
        {
          id,
          name: "OlympusMytikas-" + value + ".zip",
          size: bytes.length,
          state: "uploaded",
          digest: digest(bytes),
        },
      ],
    };
  }
  const current = release(10, version),
    previous = release(9, "1.9.0");
  const invalid = release(11, "1.11.0");
  const draft = { ...release(20, "2.0.0"), draft: true };
  const preview = { ...release(30, "3.0.0"), prerelease: true };
  const ignored = { ...release(1, "0.0.1"), tag_name: "nightly" };
  const pages = [
    [invalid, draft, preview, current, ...Array(96).fill(ignored)],
    [previous],
  ];
  let listStatus = 200,
    assetStatus = 200;
  const requestedPages: number[] = [],
    downloaded: number[] = [];
  globalThis.fetch = async (resource, options) => {
    const url = new URL(String(resource));
    if (url.origin === h.cfg.origin) return originalFetch(resource, options);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(
      new Headers(options?.headers).get("authorization"),
      "Bearer fixture-only",
    );
    const routes = "/repos/Mytikas-Monster/OlympusMytikas/releases";
    if (url.pathname === routes) {
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      return Response.json(pages[page - 1], { status: listStatus });
    }
    assert.ok(url.pathname.startsWith(routes + "/assets/"));
    const id = Number(url.pathname.split("/").at(-1));
    downloaded.push(id);
    const bytes = archives.get(id);
    assert.ok(bytes);
    return new Response(new Uint8Array(bytes), { status: assetStatus });
  };

  delete process.env.ADDON_RELEASE_TOKEN;
  await syncReleases(h.pool);
  assert.deepEqual(requestedPages, []);
  process.env.ADDON_RELEASE_TOKEN = "fixture-only";
  invalid.assets[0]!.size++;
  await assert.rejects(syncReleases(h.pool), /Incomplete release asset/);
  assert.deepEqual(requestedPages, [1, 2]);
  assert.deepEqual(downloaded, [11, 10, 9]);
  assert.deepEqual(
    (await h.pool.query("SELECT version FROM addon_releases ORDER BY version"))
      .rows,
    [{ version: "1.10.0" }, { version: "1.9.0" }],
  );

  const admin = new Client(h.cfg.origin);
  await h.pool.query(
    "UPDATE users SET activation_exempt=false, email_verified_at=now() WHERE id=$1",
    [h.admin.id],
  );
  await admin.login();
  const bookmarked = "/api/addon/" + version;
  async function assertAccess(client: Client, expected: number) {
    const { data } = await client.request("/api/auth/me");
    assert.equal(data.canDownloadAddon, expected === 200);
    const listing = await client.request("/api/addon");
    assert.equal(listing.status, expected);
    const download = await originalFetch(h.cfg.origin + bookmarked, {
      headers: { Cookie: client.cookie },
    });
    assert.equal(download.status, expected);
    assert.match(download.headers.get("cache-control") || "", /no-store/);
    if (expected === 200) {
      assert.deepEqual(
        listing.data.map((row: { version: string }) => row.version),
        [version, "1.9.0"],
      );
      assert.deepEqual(listing.data[0], {
        version,
        published_at: current.published_at.replace("Z", ".000Z"),
        notes: current.body,
        sha256: sha(archives.get(10)!),
      });
      assert.match(listing.headers.get("cache-control")!, /private/);
      assert.equal(
        download.headers.get("content-disposition"),
        "attachment; filename=OlympusMytikas-1.10.0.zip",
      );
      assert.deepEqual(
        Buffer.from(await download.arrayBuffer()),
        archives.get(10),
      );
    }
  }
  // The last verified bytes must survive both a listing outage and an unavailable asset.
  listStatus = 503;
  await assert.rejects(syncReleases(h.pool), /Release list unavailable/);
  await assertAccess(admin, 200);
  listStatus = 200;
  assetStatus = 503;
  downloaded.length = 0;
  await assert.rejects(syncReleases(h.pool), /Release download unavailable/);
  assert.deepEqual(downloaded, [11]);
  await assertAccess(admin, 200);

  const applicant = new Client(h.cfg.origin);
  await applicant.init();
  await assertAccess(applicant, 401);
  const address = "release@example.test";
  const { data: rules } = await applicant.request("/api/rules");
  assert.equal(
    (
      await applicant.request("/api/auth/register", {
        email: address,
        password: PASS,
        characterName: "Release Applicant",
        motivation: "Guild recruitment",
        acceptRules: true,
        rulesId: rules.id,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await applicant.request("/api/auth/login", {
        email: address,
        password: PASS,
      })
    ).status,
    403,
  );
  await assertAccess(applicant, 401);
  assert.equal(
    (
      await applicant.request("/api/auth/verify-email", {
        token: await mailToken(h.pool, address),
      })
    ).status,
    200,
  );
  await applicant.login(address);
  await assertAccess(applicant, 200);
  const id = (await applicant.application()).application.id;
  for (const transition of ["approve", "join"]) {
    assert.equal(
      (
        await admin.request(
          "/api/admin/applications/" + id + "/" + transition,
          {},
        )
      ).status,
      200,
    );
    await assertAccess(applicant, 200);
  }

  await h.pool.query(
    `INSERT INTO users(email,password_hash,activation_exempt)
    SELECT 'legacy@example.test',password_hash,true FROM users WHERE id=$1`,
    [h.admin.id],
  );
  const legacy = new Client(h.cfg.origin);
  await legacy.login("legacy@example.test");
  await assertAccess(legacy, 200);
  await h.pool.query(
    "UPDATE users SET activation_exempt=false, email_verified_at=now() WHERE email=$1",
    ["legacy@example.test"],
  );
  await assertAccess(legacy, 403);

  // A report itself revokes a bookmarked download even if stale application status says JOINED.
  await h.pool
    .query(`INSERT INTO blacklist_reports(message_id,guild_id,channel_id,reporter_id,reported_at,character_name,character_key,reason)
    VALUES ('42','1','2','3',now(),'Release Applicant','release applicant','Fixture report')`);
  await assertAccess(applicant, 403);
  await h.pool.query("UPDATE users SET role='ADMIN' WHERE email=$1", [address]);
  await assertAccess(applicant, 403);
  await assertAccess(admin, 200);
  assert.equal((await admin.request("/api/addon/0.1.0")).status, 404);

  assetStatus = 200;
  invalid.assets[0]!.size--;
  downloaded.length = 0;
  await syncReleases(h.pool);
  await syncReleases(h.pool);
  assert.deepEqual(downloaded, [11]);
  assert.deepEqual(
    (await admin.request("/api/addon")).data.map(
      (r: { version: string }) => r.version,
    ),
    ["1.11.0", version, "1.9.0"],
  );
  console.log(
    "Release package validation, paginated sync recovery, metadata, private downloads and account eligibility passed.",
  );
} finally {
  globalThis.fetch = originalFetch;
  if (oldToken === undefined) delete process.env.ADDON_RELEASE_TOKEN;
  else process.env.ADDON_RELEASE_TOKEN = oldToken;
  await h.stop();
}
