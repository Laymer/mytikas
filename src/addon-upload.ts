import express, { type Express, type RequestHandler } from "express";
import {
  AddonArchiveError,
  addonArchiveLimit,
  inspectAddonArchive,
  stableVersion,
} from "./addon.js";
import { assertRole } from "./applications.js";
import { transaction, type Pool } from "./db.js";
import { HttpError } from "./validation.js";

export const addonUploadPath = "/admin/addon/releases";

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
  app.post(
    "/api" + addonUploadPath,
    admin,
    (req, res, next) => {
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
      if (expectedVersion !== undefined && !stableVersion.test(expectedVersion))
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
        const result = await client.query(
          `INSERT INTO addon_releases(version,published_at,notes,sha256,archive)
         VALUES($1,now(),$2,$3,$4) ON CONFLICT (version) DO NOTHING
         RETURNING version,published_at,notes,sha256`,
          [version, notes, sha256, req.body],
        );
        if (!result.rowCount)
          throw new HttpError(
            409,
            "Version " + version + " has already been published.",
          );
        return result.rows[0];
      });
      res.status(201).json(release);
    },
  );
}
