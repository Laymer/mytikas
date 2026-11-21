import Zip from "adm-zip";
import { createHash } from "node:crypto";
import type { Pool } from "./db.js";

const original =
  "05466fd4f0c90eb54ee732fa8018df7a1928df9ad07b49709806fe8d0032ffd5";
const releaseApi =
  "https://api.github.com/repos/Mytikas-Monster/OlympusMytikas/releases";
export function validateArchive(
  bytes: Buffer,
  version: string,
  digest: string,
) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  if ("sha256:" + hash !== digest || (version === "1.0.0" && hash !== original))
    throw new Error("Addon checksum mismatch");
  const zip = new Zip(bytes),
    entries = zip.getEntries(),
    names = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    total += entry.header.size;
    const parts = name.replace(/\/$/, "").split("/");
    if (
      parts[0] !== "OlympusMytikas" ||
      parts.some(
        (p) => !p || p === "." || p === ".." || !/^[\w.-]+$/.test(p),
      ) ||
      names.has(name) ||
      ((entry.attr >>> 16) & 0xf000) === 0xa000 ||
      total > 16_000_000
    )
      throw new Error("Invalid addon layout");
    names.add(name);
  }
  const toc = zip.readAsText("OlympusMytikas/OlympusMytikas.toc");
  const lines = toc.split(/\r?\n/).map((s) => s.trim());
  if (
    !lines.includes("## Version: " + version) ||
    ![
      "Bootstrap.lua",
      "OlympusRecruit.lua",
      "KillOnSight.lua",
      "OlympusMytikas.lua",
    ].every((f) => lines.includes(f)) ||
    !lines
      .filter((l) => l && !l.startsWith("#"))
      .every((f) => names.has("OlympusMytikas/" + f.replaceAll("\\", "/"))) ||
    !zip.test()
  )
    throw new Error("Invalid addon manifest");
  return hash;
}
export async function syncReleases(pool: Pool) {
  const token = process.env.ADDON_RELEASE_TOKEN;
  if (!token) return;
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
  };
  for (let page = 1; ; page++) {
    const res = await fetch(releaseApi + "?per_page=100&page=" + page, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error("Release list unavailable");
    const list = await res.json();
    for (const r of list) {
      if (
        r.draft ||
        r.prerelease ||
        !/^v(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(
          r.tag_name,
        )
      )
        continue;
      const version = r.tag_name.slice(1);
      if (
        (
          await pool.query("SELECT 1 FROM addon_releases WHERE version=$1", [
            version,
          ])
        ).rowCount
      )
        continue;
      const assets = r.assets.filter(
        (a: any) =>
          a.name === "OlympusMytikas-" + version + ".zip" &&
          a.state === "uploaded",
      );
      if (assets.length !== 1 || assets[0].size > 8_000_000)
        throw new Error("Missing or oversized release asset");
      const asset = assets[0];
      const download = await fetch(releaseApi + "/assets/" + asset.id, {
        headers: { ...headers, Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(20000),
      });
      if (!download.ok) throw new Error("Release download unavailable");
      const bytes = Buffer.from(await download.arrayBuffer());
      if (bytes.length !== asset.size)
        throw new Error("Incomplete release asset");
      const hash = validateArchive(bytes, version, asset.digest);
      await pool.query(
        "INSERT INTO addon_releases VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [version, r.published_at, r.body || "", hash, bytes],
      );
    }
    if (list.length < 100) return;
  }
}
export const eligibleSql = `SELECT 1 FROM users u LEFT JOIN applications a ON a.user_id=u.id WHERE u.id=$1
  AND (u.email_verified_at IS NOT NULL OR u.activation_exempt)
  AND (a.id IS NOT NULL OR u.role='ADMIN' OR u.activation_exempt)
  AND a.status IS DISTINCT FROM 'BLACKLISTED' AND NOT EXISTS
  (SELECT 1 FROM blacklist_reports r WHERE r.character_key=a.character_key AND r.voided_at IS NULL)`;
