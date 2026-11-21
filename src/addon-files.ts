import { createHash } from "node:crypto";
import { posix } from "node:path";
import express, { type Express, type RequestHandler } from "express";
import Busboy from "busboy";
import Zip from "adm-zip";
import { addonArchiveLimit, eligibleSql } from "./addon.js";
import { assertRole } from "./applications.js";
import { transaction, type Pool } from "./db.js";
import { addonDownloadsPaused } from "./member.js";
import { HttpError, uuid } from "./validation.js";

export const addonFilesUploadPath = "/admin/addon-files";
const fileLimit = 128;
const metadata =
  "id,filename,visibility,notes,byte_size,sha256,file_count,published_at";
const visible = "(visibility='public' OR EXISTS (" + eligibleSql + "))";
type Part = { name: string; bytes: Buffer };
const invalid = (message: string) => new HttpError(400, message);

async function parseParts(buffer: Buffer, contentType: string) {
  let parts;
  try {
    parts = Busboy({
      headers: { "content-type": contentType },
      defParamCharset: "utf8",
      limits: {
        files: fileLimit,
        fields: 1,
        fieldSize: 160_000,
        parts: fileLimit + 2,
      },
    });
  } catch {
    throw invalid("Choose the files again and retry the upload.");
  }
  const files: Part[] = [];
  let manifest = "",
    total = 0;
  await new Promise<void>((resolve, reject) => {
    const malformed = () =>
      reject(invalid("Send one manifest and up to 128 files."));
    parts.on("error", malformed);
    parts.on("filesLimit", malformed);
    parts.on("fieldsLimit", malformed);
    parts.on("partsLimit", malformed);
    parts.on("field", (name, value, info) => {
      if (name !== "manifest" || info.valueTruncated) return malformed();
      manifest = value;
    });
    parts.on("file", (field, stream, info) => {
      stream.on("error", malformed);
      if (field !== "files") {
        stream.resume();
        return malformed();
      }
      const part = { name: info.filename, bytes: Buffer.alloc(0) } as Part;
      files.push(part);
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > addonArchiveLimit) {
          reject(new HttpError(413, "Choose files totaling at most 8 MB."));
        } else chunks.push(chunk);
      });
      stream.on("end", () => {
        part.bytes = Buffer.concat(chunks);
      });
    });
    parts.once("close", resolve);
    parts.end(buffer);
  });
  let data;
  try {
    data = JSON.parse(manifest);
  } catch {
    throw invalid("The file list is missing or invalid.");
  }
  if (
    !data ||
    !Array.isArray(data.paths) ||
    files.length === 0 ||
    files.length !== data.paths.length
  )
    throw invalid("The selected files do not match the file list.");
  return { files, data };
}

function portablePath(value: unknown, filename: string) {
  if (typeof value !== "string" || typeof filename !== "string")
    throw invalid("Each file needs a relative name.");
  const relative = value.normalize("NFC");
  const pieces = relative.split("/");
  if (
    Buffer.byteLength(relative) > 768 ||
    pieces.some(
      (piece) =>
        !piece ||
        Buffer.byteLength(piece) > 255 ||
        /[. ]$/.test(piece) ||
        /[<>:"\\|?*\u0000-\u001f\u007f]/.test(piece) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(piece),
    ) ||
    pieces.at(-1) !== filename.normalize("NFC")
  )
    throw invalid(
      "Use portable relative file and folder names without reserved characters.",
    );
  return relative;
}

function checkDistinctPaths(paths: string[]) {
  const names = new Set(paths.map((p) => p.toLowerCase()));
  const folders = new Map<string, string>();
  const conflict =
    "Each file and folder needs a distinct name on Windows and macOS.";
  if (names.size !== paths.length) throw invalid(conflict);
  for (const path of paths) {
    let parent = "";
    for (const piece of path.split("/").slice(0, -1)) {
      parent = parent ? parent + "/" + piece : piece;
      const key = parent.toLowerCase();
      if (names.has(key) || (folders.has(key) && folders.get(key) !== parent))
        throw invalid(conflict);
      folders.set(key, parent);
    }
  }
}

function makePackage(files: Part[], paths: string[]) {
  if (files.length === 1 && !paths[0]!.includes("/"))
    return { filename: paths[0]!, bytes: files[0]!.bytes };
  const zip = new Zip();
  for (const [i, f] of files.entries()) zip.addFile(paths[i]!, f.bytes);
  const folder = paths[0]!.split("/")[0];
  const filename =
    Buffer.byteLength(folder + ".zip") <= 255 &&
    paths.every((p) => p.startsWith(folder + "/"))
      ? folder + ".zip"
      : "Addon-files.zip";
  return { filename, bytes: zip.toBuffer() };
}

async function readUpload(buffer: Buffer, contentType: string, mode: string) {
  const { files, data } = await parseParts(buffer, contentType);
  if (data.visibility !== "private" && data.visibility !== "public")
    throw invalid("Choose public or private access.");
  const notes = data.notes ?? "";
  if (
    typeof notes !== "string" ||
    Buffer.byteLength(notes) > 2048 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)
  )
    throw invalid("Use up to 2,048 UTF-8 bytes of plain text for the notes.");
  const paths = files.map((f, i) => portablePath(data.paths[i], f.name));
  checkDistinctPaths(paths);
  const hashes = files.map((f) =>
    createHash("sha256").update(f.bytes).digest("hex"),
  );
  if (
    mode === "verify" &&
    (!Array.isArray(data.sha256) ||
      data.sha256.length !== files.length ||
      hashes.some((h, i) => data.sha256[i] !== h))
  )
    throw invalid("File checksum verification failed. Select the files again.");
  if (mode === "skip" && data.sha256 !== undefined)
    throw invalid("Omit checksums when skipping verification.");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([data.visibility, notes, paths, hashes]))
    .digest("hex");
  return {
    ...makePackage(files, paths),
    fingerprint,
    visibility: data.visibility as string,
    notes,
    count: files.length,
  };
}

export function installAddonFiles(
  app: Express,
  pool: Pool,
  admin: RequestHandler,
) {
  // Check eligibility in the same database snapshot that selects the private bytes or metadata.
  app.use("/api/addon-files", (_req, _res, next) => {
    if (addonDownloadsPaused())
      throw new HttpError(503, "Addon downloads are temporarily paused.");
    next();
  });
  app.get("/api/addon-files", async (req, res) => {
    const items = await pool.query(
      "SELECT " +
        metadata +
        " FROM addon_files WHERE " +
        visible +
        " ORDER BY published_at DESC,id",
      [req.user?.id ?? null],
    );
    res.json(items.rows);
  });
  app.get("/api/addon-files/:id", async (req, res) => {
    const {
      rows: [file],
    } = await pool.query(
      "SELECT filename,content FROM addon_files WHERE id=$2 AND " + visible,
      [req.user?.id ?? null, uuid(req.params.id)],
    );
    if (!file) throw new HttpError(404, "File unavailable.");
    res.set("Content-Security-Policy", "sandbox; default-src 'none'");
    res
      .attachment(file.filename)
      .type("application/octet-stream")
      .send(file.content);
  });

  app.get("/api" + addonFilesUploadPath, admin, async (_req, res) => {
    const result = await pool.query(
      "SELECT " + metadata + " FROM addon_files ORDER BY published_at DESC,id",
    );
    res.json(result.rows);
  });
  app.patch(
    "/api" + addonFilesUploadPath + "/:id/visibility",
    admin,
    async (req, res) => {
      const id = uuid(req.params.id);
      const visibility = req.body.visibility;
      if (visibility !== "public" && visibility !== "private")
        throw invalid("Choose public or private access.");
      const item = await transaction(pool, async (client) => {
        await assertRole(client, req.user!.id, true);
        const {
          rows: [file],
        } = await client.query(
          "UPDATE addon_files SET visibility=$2 WHERE id=$1 RETURNING " +
            metadata,
          [id, visibility],
        );
        if (!file) throw new HttpError(404, "File unavailable.");
        return file;
      });
      res.json(item);
    },
  );

  const raw = express.raw({
    type: "multipart/form-data",
    limit: addonArchiveLimit + 350_000,
    inflate: false,
  });
  app.post(
    "/api" + addonFilesUploadPath,
    admin,
    (req, res, next) => {
      if (!req.is("multipart/form-data"))
        throw new HttpError(415, "Choose one or more files to upload.");
      raw(req, res, (err?: { type?: string }) => {
        if (!err) return next();
        if (err.type === "entity.too.large")
          return next(
            new HttpError(413, "Choose files totaling at most 8 MB."),
          );
        if (err.type === "encoding.unsupported")
          return next(
            new HttpError(415, "Send the form without content encoding."),
          );
        next(invalid("Could not read the file upload."));
      });
    },
    async (req, res) => {
      const mode = req.get("X-Addon-Checksum-Mode") ?? "verify";
      if (mode !== "verify" && mode !== "skip")
        throw invalid("Choose verify or skip for checksums.");
      const id = uuid(req.get("X-Upload-ID"));
      const user = req.user!.id;
      const item = await readUpload(req.body, req.get("Content-Type")!, mode);
      const result = await transaction(pool, async (client) => {
        await assertRole(client, user, true);
        const inserted = await client.query(
          "INSERT INTO addon_files(id,uploaded_by,filename,visibility,notes,file_count,request_sha256,content) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING RETURNING " +
            metadata,
          [
            id,
            user,
            item.filename,
            item.visibility,
            item.notes,
            item.count,
            item.fingerprint,
            item.bytes,
          ],
        );
        if (inserted.rowCount) return { status: 201, file: inserted.rows[0] };
        const {
          rows: [prior],
        } = await client.query(
          "SELECT " +
            metadata +
            " FROM addon_files WHERE id=$1 AND uploaded_by=$2 AND request_sha256=$3",
          [id, user, item.fingerprint],
        );
        if (!prior)
          throw new HttpError(
            409,
            "This upload reference was already used for different files or settings.",
          );
        return { status: 200, file: prior };
      });
      res.status(result.status).json(result.file);
    },
  );
}
