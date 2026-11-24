import express, { type Express, type RequestHandler } from "express";
import {
  AddonArchiveError,
  addonArchiveLimit,
  inspectAddonArchive,
  lockAddonVersion,
  stableVersion,
} from "./addon.js";
import { assertRole } from "./applications.js";
import { transaction, type Pool } from "./db.js";
import { HttpError } from "./validation.js";

export const addonUploadPath = "/admin/addon/releases";

export const addonSubmissionsEnabled = () => process.env.ADDON_SUBMISSIONS_ENABLED === "1";
const submissionsPath = "/api/admin/addon/submissions";
const metadata = "id, version, notes, sha256, created_at, status, archive_id, pr_number, detail, curseforge_file_id";

export function installAddonUpload(
  app: Express,
  pool: Pool,
  admin: RequestHandler,
) {
  const readZip = express.raw({
    type: "application/zip",
    limit: addonArchiveLimit,
    inflate: false,
  });
  app.get(submissionsPath, admin, async (_req, res) => {
    const result = await pool.query("SELECT " + metadata + " FROM addon_submissions ORDER BY id DESC");
    res.json(result.rows);
  });
  app.get(submissionsPath + "/:id", admin, async (req, res) => {
    const id = String(req.params.id);
    if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)
      throw new HttpError(404, "Submission unavailable.");
    const result = await pool.query("SELECT " + metadata + " FROM addon_submissions WHERE id=$1", [id]);
    if (!result.rowCount) throw new HttpError(404, "Submission unavailable.");
    res.json(result.rows[0]);
  });
  app.post(
    "/api" + addonUploadPath,
    admin,
    (req, res, next) => {
      if (!addonSubmissionsEnabled())
        throw new HttpError(503, "Olympus release submissions are paused.");
      if (!req.is("application/zip"))
        throw new HttpError(415, "Send the ZIP as application/zip.");
      readZip(req, res, (error?: { type?: string }) => {
        if (!error) return next();
        if (error.type === "entity.too.large")
          return next(
            new HttpError(
              413,
              "The ZIP exceeds the 8,000,000-byte upload limit.",
            ),
          );
        if (error.type === "encoding.unsupported")
          return next(
            new HttpError(
              415,
              "Send the ZIP without an additional content encoding.",
            ),
          );
        next(new HttpError(400, "Could not read the ZIP upload."));
      });
    },
    async (req, res) => {
      const expectedVersion = req.get("X-Addon-Version");
      if (!expectedVersion || !stableVersion.test(expectedVersion))
        throw new HttpError(400, "Enter a stable version in X.Y.Z format.");
      const checksumMode = req.get("X-Addon-Checksum-Mode") ?? "verify";
      if (checksumMode !== "verify" && checksumMode !== "skip")
        throw new HttpError(
          400,
          "Choose verify or skip for checksum comparison.",
        );
      const suppliedHash = req.get("X-Addon-SHA256");
      if (checksumMode === "skip" && suppliedHash !== undefined)
        throw new HttpError(
          400,
          "Omit the supplied SHA-256 when skipping checksum comparison.",
        );
      if (
        checksumMode === "verify" &&
        !/^[a-f0-9]{64}$/.test(suppliedHash ?? "")
      )
        throw new HttpError(
          400,
          "Supply the ZIP's lowercase SHA-256 checksum.",
        );
      let notes: string;
      try {
        notes = decodeURIComponent(req.get("X-Addon-Notes") ?? "");
      } catch {
        throw new HttpError(
          400,
          "Release notes must use UTF-8 percent encoding.",
        );
      }
      if (!notes.trim())
        throw new HttpError(400, "Describe the player-visible changes in the release notes.");
      if (
        Buffer.byteLength(notes) > 2048 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)
      )
        throw new HttpError(
          400,
          "Use up to 2,048 UTF-8 bytes of plain text for release notes.",
        );
      let version: string, sha256: string;
      try {
        ({ version, sha256 } = inspectAddonArchive(
          req.body,
          suppliedHash && "sha256:" + suppliedHash,
          expectedVersion,
        ));
      } catch (error) {
        if (error instanceof AddonArchiveError)
          throw new HttpError(400, error.message);
        throw error;
      }
      const release = await transaction(pool, async (client) => {
        // A role change may have taken place while the upload was being received.
        await assertRole(client, req.user!.id, true);
        await lockAddonVersion(client, version);
        const existing = (await client.query(
          "SELECT " + metadata + " FROM addon_submissions WHERE version=$1", [version],
        )).rows[0];
        if (existing) {
          if (existing.sha256 === sha256 && existing.notes === notes)
            return { code: 200, submission: existing };
          throw new HttpError(409, "Version " + version + " already has a submission with different ZIP bytes or notes.");
        }
        if ((await client.query("SELECT 1 FROM addon_releases WHERE version=$1", [version])).rowCount)
          throw new HttpError(409, "Version " + version + " has already been published.");
        const result = await client.query(
          `INSERT INTO addon_submissions(version,notes,sha256,archive,submitted_by)
           VALUES($1,$2,$3,$4,$5) RETURNING ` + metadata,
          [version, notes, sha256, req.body, req.user!.id],
        );
        return { code: 202, submission: result.rows[0] };
      });
      res.location(submissionsPath + "/" + release.submission.id).status(release.code).json(release.submission);
    },
  );
}
