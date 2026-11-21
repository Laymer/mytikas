import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import Zip from "adm-zip";
import { importReport } from "../src/blacklist.js";
import { transaction } from "../src/db.js";
import { Client, PASS, harness } from "./harness.js";

const h = await harness();
const origin = h.cfg.origin;
const catalog = "/api/addon-files",
  publish = "/api/admin/addon-files";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const previous = process.env.ADDON_DOWNLOADS_PAUSED;
process.env.ADDON_DOWNLOADS_PAUSED = "0";

function file(path: string, contents: string | Buffer) {
  return { path, name: path.split("/").at(-1)!, bytes: Buffer.from(contents) };
}
type Selected = ReturnType<typeof file>;
type UploadOptions = {
  mode?: string;
  manifest?: Record<string, unknown>;
  headers?: Record<string, string>;
};

function upload(
  client: Client,
  id: string,
  files: Selected[],
  options: UploadOptions = {},
) {
  const body = new FormData();
  const data = {
    paths: files.map((f) => f.path),
    visibility: "private",
    notes: "Guild fixture",
    ...(options.mode === "skip"
      ? {}
      : { sha256: files.map((f) => sha(f.bytes)) }),
    ...options.manifest,
  };
  body.append("manifest", JSON.stringify(data));
  for (const f of files)
    body.append("files", new Blob([new Uint8Array(f.bytes)]), f.name);
  return fetch(origin + publish, {
    method: "POST",
    headers: {
      Cookie: client.cookie,
      Origin: origin,
      "X-CSRF-Token": client.csrf,
      "X-Upload-ID": id,
      ...(options.mode ? { "X-Addon-Checksum-Mode": options.mode } : {}),
      ...options.headers,
    },
    body,
  });
}

function visibility(
  client: Client,
  id: string,
  access: string,
  headers: Record<string, string> = {},
) {
  return fetch(origin + publish + "/" + id + "/visibility", {
    method: "PATCH",
    headers: {
      Cookie: client.cookie,
      Origin: origin,
      "Content-Type": "application/json",
      "X-CSRF-Token": client.csrf,
      ...headers,
    },
    body: JSON.stringify({ visibility: access }),
  });
}
function download(client: Client, id: string) {
  return fetch(origin + catalog + "/" + id, {
    headers: { Cookie: client.cookie },
  });
}
async function visibleIds(client: Client) {
  const result = await client.request(catalog);
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control")!, /no-store/);
  return result.data.map((item: { id: string }) => item.id).sort();
}

try {
  const admin = new Client(origin),
    mod = new Client(origin),
    member = new Client(origin);
  const anonymous = new Client(origin),
    pending = new Client(origin);
  await admin.login();
  await mod.login("mod@example.test");
  await member.signup("File Reader");
  await anonymous.init();
  await pending.init();
  const pendingAddress = "files.pending@example.test";
  const registration = await pending.request("/api/auth/register", {
    email: pendingAddress,
    password: PASS,
    characterName: "Pending Reader",
    motivation: "Guild files",
    rulesId: (await pending.request("/api/rules")).data.id,
    acceptRules: true,
  });
  assert.equal(registration.status, 201);
  assert.equal(
    (
      await pending.request("/api/auth/login", {
        email: pendingAddress,
        password: PASS,
      })
    ).status,
    403,
  );
  const opaque = file("Guild 雪.dat", Buffer.from([0, 255, 32, 8, 0, 193, 11]));
  const publicId = randomUUID(),
    privateId = randomUUID();
  for (const [actor, status] of [
    [anonymous, 401],
    [member, 403],
    [mod, 403],
  ] as const)
    assert.equal((await upload(actor, publicId, [opaque])).status, status);
  for (const headers of [
    { "X-CSRF-Token": "" },
    { Origin: "https://elsewhere.example" },
  ] as Record<string, string>[])
    assert.equal(
      (await upload(admin, publicId, [opaque], { headers })).status,
      403,
    );
  assert.equal((await admin.request(publish, {})).status, 415);
  assert.equal(
    (
      await upload(admin, publicId, [opaque], {
        headers: { "Content-Encoding": "gzip" },
      })
    ).status,
    415,
  );

  const uploaded = await upload(admin, publicId, [opaque], {
    mode: "skip",
    manifest: { visibility: "public" },
  });
  assert.equal(uploaded.status, 201);
  const item = await uploaded.json();
  assert.equal(item.id, publicId);
  assert.equal(item.filename, opaque.name);
  assert.equal(item.visibility, "public");
  assert.equal(item.file_count, 1);
  assert.equal(item.notes, "Guild fixture");
  assert.equal(item.sha256, sha(opaque.bytes));
  assert.equal(item.byte_size, opaque.bytes.length);
  assert.ok(Date.parse(item.published_at));
  assert.deepEqual(
    Object.keys(item).sort(),
    [
      "id",
      "filename",
      "visibility",
      "notes",
      "byte_size",
      "sha256",
      "file_count",
      "published_at",
    ].sort(),
  );

  const bundle = [
    file("Raid Notes/Read me.txt", "Bring potions."),
    file("Raid Notes/Maps/Routes.dat", Buffer.from([1, 0, 255])),
    file("Raid Notes/Empty.lua", ""),
  ];
  const simultaneous = await Promise.all(
    Array.from({ length: 3 }, () => upload(admin, privateId, bundle)),
  );
  assert.deepEqual(simultaneous.map((r) => r.status).sort(), [200, 200, 201]);
  const [folder, ...replayed] = await Promise.all(
    simultaneous.map((r) => r.json()),
  );
  for (const replay of replayed) assert.deepEqual(replay, folder);
  assert.equal(folder.filename, "Raid Notes.zip");
  assert.equal(folder.file_count, 3);
  assert.equal(
    (
      await upload(admin, privateId, bundle, {
        manifest: { notes: "Changed notes" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await upload(admin, privateId, bundle, {
        manifest: { visibility: "public" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await upload(admin, privateId, [
        ...bundle.slice(0, -1),
        file("Raid Notes/Empty.lua", "Changed bytes"),
      ])
    ).status,
    409,
  );
  await h.pool.query("UPDATE users SET role='ADMIN' WHERE id=$1", [
    h.moderator.id,
  ]);
  try {
    assert.equal((await upload(mod, privateId, bundle)).status, 409);
  } finally {
    await h.pool.query("UPDATE users SET role='MODERATOR' WHERE id=$1", [
      h.moderator.id,
    ]);
  }

  for (const client of [anonymous, pending, member, mod, admin]) {
    const eligible = [member, mod, admin].includes(client);
    assert.deepEqual(
      await visibleIds(client),
      (eligible ? [publicId, privateId] : [publicId]).sort(),
    );
    const publicFile = await download(client, publicId);
    assert.equal(publicFile.status, 200);
    assert.match(
      publicFile.headers.get("content-disposition")!,
      /filename\*=UTF-8''Guild%20%E9%9B%AA.dat/i,
    );
    assert.match(
      publicFile.headers.get("content-type")!,
      /application\/octet-stream/,
    );
    assert.match(publicFile.headers.get("cache-control")!, /no-store/);
    assert.deepEqual(Buffer.from(await publicFile.arrayBuffer()), opaque.bytes);
    const privateFile = await download(client, privateId);
    assert.match(privateFile.headers.get("cache-control")!, /no-store/);
    assert.equal(privateFile.status, eligible ? 200 : 404);
    if (eligible) {
      const packageBytes = Buffer.from(await privateFile.arrayBuffer());
      assert.equal(folder.sha256, sha(packageBytes));
      assert.equal(folder.byte_size, packageBytes.length);
      const zip = new Zip(packageBytes);
      assert.deepEqual(
        zip
          .getEntries()
          .filter((e) => !e.isDirectory)
          .map((e) => e.entryName)
          .sort(),
        bundle.map((f) => f.path).sort(),
      );
      for (const f of bundle) assert.deepEqual(zip.readFile(f.path), f.bytes);
    }
  }

  await transaction(h.pool, (c) =>
    importReport(
      c,
      {
        id: "340",
        channel_id: "12",
        author: { id: "123" },
        timestamp: new Date().toISOString(),
        content: "Name: File\nSurname: Reader\nReason: Officer fixture",
      },
      "34",
      "12",
    ),
  );
  assert.deepEqual(await visibleIds(member), [publicId]);
  assert.equal((await download(member, privateId)).status, 404);
  assert.equal((await download(member, publicId)).status, 200);

  for (const [actor, status] of [
    [anonymous, 401],
    [member, 403],
    [mod, 403],
  ] as const)
    assert.equal((await visibility(actor, privateId, "public")).status, status);
  assert.equal(
    (await visibility(admin, privateId, "public", { "X-CSRF-Token": "" }))
      .status,
    403,
  );
  assert.equal((await visibility(admin, privateId, "invalid")).status, 400);
  assert.equal((await visibility(admin, randomUUID(), "private")).status, 404);
  const changed = await visibility(admin, privateId, "public");
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { ...folder, visibility: "public" });
  assert.deepEqual(await visibleIds(anonymous), [publicId, privateId].sort());
  assert.equal((await download(anonymous, privateId)).status, 200);
  const replayAfterChange = await upload(admin, privateId, bundle);
  assert.equal(replayAfterChange.status, 200);
  assert.equal((await replayAfterChange.json()).visibility, "public");
  assert.equal((await visibility(admin, privateId, "private")).status, 200);
  assert.deepEqual(await visibleIds(anonymous), [publicId]);
  assert.equal((await download(anonymous, privateId)).status, 404);

  // The original references stay immutable even when a later input fails.
  const invalidId = randomUUID();
  const rejected: [Selected[], UploadOptions, number][] = [
    [[opaque], { manifest: { sha256: ["0".repeat(64)] } }, 400],
    [[opaque], { manifest: { sha256: [] } }, 400],
    [
      [opaque],
      { mode: "skip", manifest: { sha256: [sha(opaque.bytes)] } },
      400,
    ],
    [[opaque], { mode: "unknown" }, 400],
    [[], {}, 400],
    [[opaque], { manifest: { paths: ["Different name.dat"] } }, 400],
    [[opaque], { manifest: { visibility: "unspecified" } }, 400],
    [[opaque], { manifest: { notes: "é".repeat(1025) } }, 400],
    [[file("Readme.txt", "1"), file("README.txt", "2")], {}, 400],
    [[file("Manual", "index"), file("Manual/Notes.txt", "notes")], {}, 400],
    [
      [
        file("First/Settings/readme.txt", "a"),
        file("First/settings/Guide.txt", "b"),
      ],
      {},
      400,
    ],
    [Array.from({ length: 129 }, (_, i) => file("item-" + i, "")), {}, 400],
    [
      [
        file("part-one.dat", Buffer.alloc(4_000_000)),
        file("part-two.dat", Buffer.alloc(4_000_001)),
      ],
      { mode: "skip" },
      413,
    ],
  ];
  for (const [files, options, status] of rejected) {
    const response = await upload(admin, invalidId, files, options);
    assert.equal(
      response.status,
      status,
      files
        .map((f) => f.path)
        .slice(0, 3)
        .join(", "),
    );
  }
  assert.equal((await download(admin, invalidId)).status, 404);
  assert.equal(
    (await h.pool.query("SELECT count(*)::int AS count FROM addon_files"))
      .rows[0].count,
    2,
  );
  const atCountLimit = Array.from({ length: 128 }, (_, i) =>
    file("Batch/item-" + i, ""),
  );
  const atLimit = await upload(admin, randomUUID(), atCountLimit);
  assert.equal(atLimit.status, 201);
  const batch = await atLimit.json();
  assert.equal(batch.file_count, 128);

  const mixedId = randomUUID();
  const mixedFiles = [
    file("Notes.txt", "help"),
    file("Utilities/Macro.lua", "--fixture"),
  ];
  await h.pool.query(
    "ALTER TABLE addon_files ADD CONSTRAINT fixture_interrupt CHECK (notes <> 'Storage interruption fixture')",
  );
  try {
    const interrupted = await upload(admin, mixedId, mixedFiles, {
      manifest: { notes: "Storage interruption fixture" },
    });
    assert.equal(interrupted.status, 500);
    assert.equal(
      (await h.pool.query("SELECT 1 FROM addon_files WHERE id=$1", [mixedId]))
        .rowCount,
      0,
    );
  } finally {
    await h.pool.query(
      "ALTER TABLE addon_files DROP CONSTRAINT fixture_interrupt",
    );
  }
  process.env.ADDON_DOWNLOADS_PAUSED = "1";
  assert.equal((await anonymous.request(catalog)).status, 503);
  assert.equal((await download(admin, privateId)).status, 503);
  const mixed = await upload(admin, mixedId, mixedFiles);
  assert.equal(mixed.status, 201);
  const mixedItem = await mixed.json();
  assert.equal(mixedItem.filename, "Addon-files.zip");

  for (const [actor, status] of [
    [anonymous, 401],
    [pending, 401],
    [member, 403],
    [mod, 403],
  ] as const) {
    const denied = await actor.request(publish);
    assert.equal(denied.status, status);
    assert.deepEqual(Object.keys(denied.data), ["error"]);
  }
  const management = await admin.request(publish);
  assert.equal(management.status, 200);
  assert.match(management.headers.get("cache-control")!, /no-store/);
  assert.deepEqual(
    new Map(management.data.map((entry: { id: string }) => [entry.id, entry])),
    new Map([item, folder, batch, mixedItem].map(entry => [entry.id, entry])),
  );
  assert.equal((await visibility(admin, publicId, "private")).status, 200);
  assert.equal((await visibility(admin, mixedId, "public")).status, 200);
  assert.equal((await download(anonymous, mixedId)).status, 503);
  process.env.ADDON_DOWNLOADS_PAUSED = "0";
  const newCatalog = await visibleIds(anonymous);
  assert.deepEqual(newCatalog, [mixedId]);
  assert.equal((await download(anonymous, publicId)).status, 404);
  assert.equal((await download(member, publicId)).status, 404);
  assert.equal((await download(anonymous, mixedId)).status, 200);
  console.log(
    "Addon file publishing, Unicode downloads, folder contents, concurrent replay, access changes, privacy and limits passed.",
  );
} finally {
  if (previous === undefined) delete process.env.ADDON_DOWNLOADS_PAUSED;
  else process.env.ADDON_DOWNLOADS_PAUSED = previous;
  await h.stop();
}
