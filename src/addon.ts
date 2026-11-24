import Zip from "adm-zip";
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { transaction, type Pool } from "./db.js";
import type { PoolClient } from "pg";

export const addonArchiveLimit = 8_000_000;
export const stableVersion =
  /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const original =
  "05466fd4f0c90eb54ee732fa8018df7a1928df9ad07b49709806fe8d0032ffd5";
const releaseApi =
  "https://api.github.com/repos/Mytikas-Monster/OlympusMytikas/releases";
const folder = "OlympusMytikas/";
const tocPath = folder + "OlympusMytikas.toc";
const requiredScripts = [
  "Bootstrap.lua",
  "OlympusRecruit.lua",
  "KillOnSight.lua",
  "OlympusMytikas.lua",
];
const entryLimit = 2048;
const expandedLimit = 16_000_000;

export class AddonArchiveError extends Error {}

function readEntries(bytes: Buffer) {
  const paths = new Map<string, string>();
  // adm-zip constructs implicit parent directories while reading its index.
  // Bound and validate names during decoding, before those objects are created.
  const decoder = {
    encode: (s: string) => Buffer.from(s),
    decode(raw: Buffer) {
      if (raw.length > 512)
        throw new AddonArchiveError(
          "An addon path is too long. Shorten the folder or file name.",
        );
      const name = raw.toString("utf8");
      if (paths.get(name.replace(/\/$/, "").toLowerCase()) === name)
        return name;
      if (!name.startsWith(folder))
        throw new AddonArchiveError(
          "Invalid addon layout. Put OlympusMytikas/ at the top of the ZIP.",
        );
      const parts = name.replace(/\/$/, "").split("/");
      let path = "";
      for (const [i, part] of parts.entries()) {
        if (
          !/^[\w.-]+$/.test(part) ||
          part.endsWith(".") ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
        )
          throw new AddonArchiveError(
            "Invalid addon layout. Use Windows-compatible folder and file names.",
          );
        path += part;
        const key = path.toLowerCase();
        if (i < parts.length - 1 || name.endsWith("/")) path += "/";
        const previous = paths.get(key);
        if (previous !== undefined && previous !== path)
          throw new AddonArchiveError(
            "Invalid addon layout. Give each file and folder a distinct Windows-compatible path.",
          );
        paths.set(key, path);
      }
      if (paths.size > 2 * entryLimit)
        throw new AddonArchiveError(
          "The ZIP contains too many addon files and folders.",
        );
      return name;
    },
  };
  const options = { readEntries: false, decoder };
  const zip = new Zip(bytes, options);
  if (zip.getEntryCount() > entryLimit)
    throw new AddonArchiveError("The ZIP contains too many addon files.");
  return zip.getEntries();
}

function manifestVersion(bytes: Buffer) {
  let expanded = 0,
    compressed = 0,
    toc: Buffer | undefined;
  const files = new Set<string>();
  for (const entry of readEntries(bytes)) {
    const name = entry.entryName;
    const { size, compressedSize, method, flags, offset, crc } = entry.header;
    const fileType = (entry.attr >>> 16) & 0o170000;
    if (
      (fileType && fileType !== (entry.isDirectory ? 0o040000 : 0o100000)) ||
      entry.attr & 0x408 ||
      (entry.attr & 0x10 && !entry.isDirectory)
    )
      throw new AddonArchiveError(
        "The ZIP must contain only regular addon files and folders.",
      );
    if (flags & ~0x080e || (method !== 0 && method !== 8))
      throw new AddonArchiveError(
        "Use a ZIP with stored or deflated files and no encryption.",
      );
    expanded += size;
    compressed += compressedSize;
    if (
      expanded > expandedLimit ||
      compressed > bytes.length ||
      (name === tocPath && size > 1_000_000)
    )
      throw new AddonArchiveError(
        "The expanded addon files or TOC exceed the package size limit.",
      );
    const packed = entry.getCompressedData(); // Reads the local header and bounds the compressed slice.
    const nameSize = bytes.readUInt16LE(offset + 26);
    if (
      !bytes
        .subarray(offset + 30, offset + 30 + nameSize)
        .equals(entry.rawEntryName) ||
      bytes.readUInt16LE(offset + 6) !== flags ||
      bytes.readUInt16LE(offset + 8) !== method
    )
      throw new AddonArchiveError(
        "The ZIP contains inconsistent file headers. Rebuild it from the addon folder.",
      );
    const contents =
      method === 0
        ? packed
        : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
    if (
      contents.length !== size ||
      crc32(contents) !== crc ||
      (entry.isDirectory && size)
    )
      throw new AddonArchiveError(
        "A ZIP entry failed its integrity check. Rebuild the archive.",
      );
    if (!entry.isDirectory) files.add(name);
    if (name === tocPath) toc = contents;
  }
  if (!toc)
    throw new AddonArchiveError(
      "Missing addon manifest. Include OlympusMytikas/OlympusMytikas.toc.",
    );
  const lines = toc
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const versions = lines.filter((line) => /^##\s*Version\s*:/i.test(line));
  const version = /^##\s*Version\s*:\s*(\S+)$/i.exec(versions[0] ?? "")?.[1];
  if (versions.length !== 1 || !version || !stableVersion.test(version))
    throw new AddonArchiveError(
      "Set exactly one stable ## Version: X.Y.Z line in the addon manifest.",
    );
  const scripts = new Set(
    lines
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.replaceAll("\\", "/")),
  );
  for (const name of requiredScripts) {
    if (!scripts.has(name) || !files.has(folder + name))
      throw new AddonArchiveError(
        "The addon manifest must list " +
          name +
          " and the ZIP must include that file.",
      );
  }
  for (const name of scripts) {
    if (!files.has(folder + name))
      throw new AddonArchiveError(
        "The addon manifest references a missing file. Include every file listed in the TOC.",
      );
  }
  return version;
}

export function inspectAddonArchive(
  bytes: Buffer,
  expectedDigest: string | undefined,
  expectedVersion?: string,
) {
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > addonArchiveLimit
  )
    throw new AddonArchiveError(
      "Select a nonempty ZIP no larger than 8,000,000 bytes.",
    );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedDigest !== undefined && "sha256:" + sha256 !== expectedDigest)
    throw new AddonArchiveError(
      "The ZIP checksum does not match the supplied SHA-256.",
    );
  let version: string;
  try {
    version = manifestVersion(bytes);
  } catch (error) {
    if (error instanceof AddonArchiveError) throw error;
    throw new AddonArchiveError(
      "Could not read the ZIP files. Rebuild the archive from the OlympusMytikas folder.",
    );
  }
  if (expectedVersion !== undefined && expectedVersion !== version)
    throw new AddonArchiveError(
      "The supplied version does not match the addon manifest version " +
        version +
        ".",
    );
  if (version === "1.0.0" && sha256 !== original)
    throw new AddonArchiveError(
      "Version 1.0.0 requires the original release ZIP. Use a new version for changed files.",
    );
  return { version, sha256 };
}

export function validateArchive(
  bytes: Buffer,
  version: string,
  digest: string,
) {
  if (typeof digest !== "string")
    throw new AddonArchiveError("The release is missing its SHA-256 checksum.");
  return inspectAddonArchive(bytes, digest, version).sha256;
}
type ReleaseAsset = {
  id: number;
  name: string;
  state: string;
  size: number;
  digest: string;
};
async function boundedBody(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Release response exceeds its size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Release response is empty");
  const bytes = Buffer.allocUnsafe(limit);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes.subarray(0, size);
      if (value.byteLength > limit - size)
        throw new Error("Release response exceeds its size limit");
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function downloadRelease(
  assets: ReleaseAsset[],
  version: string,
  headers: Record<string, string>,
) {
  const matching = assets.filter(
    (a) =>
      a.name === "OlympusMytikas-" + version + ".zip" && a.state === "uploaded",
  );
  if (
    matching.length !== 1 ||
    !Number.isSafeInteger(matching[0]!.size) ||
    matching[0]!.size < 1 ||
    matching[0]!.size > addonArchiveLimit
  )
    throw new Error("Missing or oversized release asset");
  const asset = matching[0]!;
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
  )
    throw new Error("Missing release asset ID or SHA-256 digest");
  const download = await fetch(releaseApi + "/assets/" + asset.id, {
    headers: { ...headers, Accept: "application/octet-stream" },
    signal: AbortSignal.timeout(20000),
  });
  if (!download.ok) {
    await download.body?.cancel();
    throw new Error("Release download unavailable");
  }
  const bytes = await boundedBody(download, asset.size);
  if (bytes.length !== asset.size) throw new Error("Incomplete release asset");
  return { bytes, hash: validateArchive(bytes, version, asset.digest) };
}
// Serialize version reservations with legacy GitHub imports in the application DB.
export async function lockAddonVersion(client: PoolClient, version: string) {
  await client.query("SELECT pg_advisory_xact_lock(7284, hashtext($1))", [version]);
}
export async function syncReleases(pool: Pool) {
  const token = process.env.ADDON_RELEASE_TOKEN;
  if (!token) return;
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
  };
  let failure: Error | undefined;
  for (let page = 1; ; page++) {
    const res = await fetch(releaseApi + "?per_page=100&page=" + page, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error("Release list unavailable");
    }
    const list = JSON.parse(
      (await boundedBody(res, addonArchiveLimit)).toString("utf8"),
    );
    if (!Array.isArray(list) || list.length > 100)
      throw new Error("Invalid release list");
    for (const r of list) {
      if (
        r.draft ||
        r.prerelease ||
        typeof r.tag_name !== "string" ||
        !r.tag_name.startsWith("v") ||
        !stableVersion.test(r.tag_name.slice(1))
      )
        continue;
      const version = r.tag_name.slice(1);
      if (
        (
          await pool.query("SELECT 1 FROM addon_releases WHERE version=$1 UNION ALL SELECT 1 FROM addon_submissions WHERE version=$1", [
            version,
          ])
        ).rowCount
      )
        continue;
      let verified;
      try {
        verified = await downloadRelease(r.assets, version, headers);
      } catch (error) {
        // A bad package must not prevent verification of other published versions.
        failure ??=
          error instanceof Error ? error : new Error("Release unavailable");
        continue;
      }
      await transaction(pool, async (client) => {
        await lockAddonVersion(client, version);
        await client.query(
          `INSERT INTO addon_releases(version,published_at,notes,sha256,archive)
           SELECT $1::text,$2::timestamptz,$3::text,$4::text,$5::bytea WHERE NOT EXISTS
             (SELECT 1 FROM addon_submissions WHERE version=$1)
           ON CONFLICT (version) DO NOTHING`,
          [version, r.published_at, r.body || "", verified.hash, verified.bytes],
        );
      });
    }
    if (list.length < 100) break;
  }
  if (failure) throw failure;
}
export const eligibleSql = `SELECT 1 FROM users u LEFT JOIN applications a ON a.user_id=u.id WHERE u.id=$1
  AND (u.email_verified_at IS NOT NULL OR u.activation_exempt)
  AND a.status IS DISTINCT FROM 'BLACKLISTED' AND NOT EXISTS
  (SELECT 1 FROM blacklist_reports r WHERE r.character_key=a.character_key AND r.voided_at IS NULL)`;
