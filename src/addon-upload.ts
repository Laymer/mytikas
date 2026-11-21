import express, { type Express, type RequestHandler } from "express";
import { addonArchiveLimit, stableVersion, validateArchive } from "./addon.js";
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
      const version = req.get("X-Addon-Version") ?? "";
      if (!stableVersion.test(version))
        throw new HttpError(400, "Enter a stable version in X.Y.Z format.");
      const sha256 = req.get("X-Addon-SHA256") ?? "";
      if (!/^[a-f0-9]{64}$/.test(sha256))
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
      try {
        validateArchive(req.body, version, "sha256:" + sha256);
      } catch {
        throw new HttpError(
          400,
          "ZIP validation failed. Check the SHA-256, addon files and manifest version.",
        );
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
          throw new HttpError(409, "That version has already been published.");
        return result.rows[0];
      });
      res.status(201).json(release);
    },
  );
}
