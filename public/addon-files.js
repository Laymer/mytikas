import { $, action, api, bindForm, date, message, node } from "./common.js?v=publisher-1";

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function newUploadId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const id = hex(bytes);
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join("-");
}

export async function sha256(file) {
  if (!globalThis.crypto?.subtle)
    throw new Error("Use HTTPS to verify checksums, or choose Skip checksum verification.");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return hex(new Uint8Array(digest));
}

export function checksumToggle(form) {
  const button = node("button", "Skip checksum verification", "checksum-toggle");
  button.type = "button";
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => {
    button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") === "false"));
  });
  form.addEventListener("reset", () => button.setAttribute("aria-pressed", "false"));
  return button;
}

export async function showFiles(root, me) {
  const admin = me.user?.role === "ADMIN";
  const items = await api(admin ? "/api/admin/addon-files" : "/api/addon-files");
  root.replaceChildren(node("h2", "Addon files"));
  if (!items.length) {
    root.append(node("p", "No files available."));
    return;
  }
  const list = node("ul", undefined, "addon-file-list");
  for (const item of items) {
    const row = node("li"), title = node("span");
    function displayName() {
      if (!me.addonDownloadsPaused && (item.visibility === "public" || me.canDownloadAddon)) {
        const download = node("a", item.filename);
        download.href = "/api/addon-files/" + encodeURIComponent(item.id);
        title.replaceChildren(download);
      } else title.textContent = item.filename;
    }
    displayName();
    const visibility = node("span", item.visibility === "public" ? "Public" : "Private", "file-visibility");
    row.append(title, visibility);
    if (item.notes) row.append(node("p", item.notes, "plain"));
    const details = node("details");
    details.append(
      node("summary", "File details"),
      node("p", item.file_count + (item.file_count === 1 ? " file" : " files") + " · " + Number(item.byte_size).toLocaleString() + " bytes · " + date(item.published_at)),
      node("p", "SHA-256 " + item.sha256, "checksum"),
    );
    row.append(details);
    if (admin) {
      const change = action(item.visibility === "public" ? "Make private" : "Make public", async () => {
        const next = item.visibility === "public" ? "private" : "public";
        const updated = await api("/api/admin/addon-files/" + encodeURIComponent(item.id) + "/visibility", {visibility: next}, {}, "PATCH");
        item.visibility = updated.visibility;
        displayName();
        visibility.textContent = next === "public" ? "Public" : "Private";
        change.textContent = next === "public" ? "Make private" : "Make public";
        message(item.filename + " is now " + item.visibility + ".", true);
      });
      row.append(change);
    }
    list.append(row);
  }
  root.append(list);
}

export function filesForm(refresh) {
  const form = node("form");
  form.setAttribute("aria-label", "Publish addon files");
  form.innerHTML = `<fieldset>
    <label for="addon-files">Choose files</label>
    <input id="addon-files" type="file" multiple>
    <label for="addon-folder">Choose a folder</label>
    <input id="addon-folder" type="file" webkitdirectory multiple>
    <p class="meta">Up to 128 files and 8 MB total. Folders and multiple files download as a ZIP.</p>
    <label for="file-visibility">Visibility</label>
    <select id="file-visibility" name="visibility">
      <option value="private">Private · eligible members</option>
      <option value="public">Public · anyone</option>
    </select>
    <label for="file-notes">Notes (optional)</label>
    <textarea id="file-notes" name="notes" maxlength="2048" rows="2"></textarea>
    </fieldset><button type="submit">Publish files</button><p role="status"></p>`;
  const fields = $("fieldset", form), status = $("[role=status]", form);
  const toggle = checksumToggle(form);
  fields.append(toggle);
  let uploadId, unresolved = false;
  for (const event of ["input", "change"])
    form.addEventListener(event, () => {
      if (unresolved) status.textContent = "Your previous upload may already be published. Check its filename and visibility before publishing these changes.";
      unresolved = false;
      uploadId = undefined;
    });
  form.addEventListener("reset", () => { uploadId = undefined; unresolved = false; });
  bindForm(form, async data => {
    const files = [...$("#addon-files", form).files, ...$("#addon-folder", form).files];
    if (!files.length) throw new Error("Choose files or a folder to publish.");
    if (files.length > 128 || files.reduce((sum, file) => sum + file.size, 0) > 8_000_000)
      throw new Error("Select up to 128 files with a combined size of 8 MB or less.");
    const notes = data.get("notes");
    if (new TextEncoder().encode(notes).length > 2048)
      throw new Error("Shorten the notes to 2,048 UTF-8 bytes or fewer.");
    const paths = files.map(file => file.webkitRelativePath || file.name);
    if (new Set(paths).size !== paths.length) throw new Error("Choose each file path only once.");
    const manifest = {visibility: data.get("visibility"), notes, paths};
    const skip = toggle.getAttribute("aria-pressed") === "true";
    const payload = new FormData();
    fields.disabled = true;
    try {
      if (!skip) {
        status.textContent = "Calculating file checksums…";
        manifest.sha256 = await Promise.all(files.map(sha256));
      }
      payload.append("manifest", JSON.stringify(manifest));
      for (const file of files) payload.append("files", file, file.name);
      uploadId ||= newUploadId();
      status.textContent = "Uploading " + files.length + (files.length === 1 ? " file…" : " files…");
      const item = await api("/api/admin/addon-files", payload, {
        "X-Upload-ID": uploadId,
        "X-Addon-Checksum-Mode": skip ? "skip" : "verify",
      });
      form.reset();
      message("Published " + item.filename + " as " + item.visibility + ".", true);
      await refresh();
    } catch (error) {
      if (error.uncertain) {
        unresolved = true;
        error.uncertain = false;
        error.message = "Publication could not be confirmed. Retry without changing the selection to check the same upload.";
      }
      throw error;
    } finally {
      fields.disabled = false;
      status.textContent = "";
    }
  });
  return form;
}
