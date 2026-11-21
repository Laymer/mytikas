import { $, api, bindForm, node, message, date } from "./common.js";
import { rosterNavigation } from "./roster.js";
import { link } from "./member.js";
async function showReleases(root) {
  const releases = await api("/api/addon");
  root.replaceChildren();
  if (!releases.length) root.append(node("p", "Waiting for the first verified release."));
  for (const [index, r] of releases.entries()) {
    const card = node("section", undefined, "card");
    card.append(
      node("h2", (index === 0 ? "Current release · " : "Version ") + r.version),
      node("p", date(r.published_at), "meta"),
      node("p", r.notes, "plain"),
      link(
        "Download OlympusMytikas-" + r.version + ".zip",
        "/api/addon/" + r.version,
      ),
      node("p", "SHA-256 " + r.sha256, "checksum"),
    );
    root.append(card);
  }
}

function uploadForm(refresh) {
  const card = node("section", undefined, "card");
  card.innerHTML = `<h2 id="upload-heading">Publish an addon release</h2>
    <form aria-labelledby="upload-heading">
      <label for="release-version">Release version</label>
      <input id="release-version" name="version" required pattern="(0|[1-9][0-9]{0,7})\\.(0|[1-9][0-9]{0,7})\\.(0|[1-9][0-9]{0,7})" maxlength="26" aria-describedby="version-help">
      <p id="version-help" class="meta">Use the version from OlympusMytikas.toc, for example 1.2.0.</p>
      <label for="release-file">Addon ZIP</label>
      <input id="release-file" name="archive" type="file" accept=".zip,application/zip" required aria-describedby="archive-help">
      <p id="archive-help" class="meta">Choose a ZIP containing the OlympusMytikas folder, up to 8 MB.</p>
      <label for="release-notes">Release notes (optional)</label>
      <textarea id="release-notes" name="notes" maxlength="2048" rows="3"></textarea>
      <button type="submit">Publish release</button>
      <p role="status"></p>
    </form>`;
  const form = $("form", card), status = $("[role=status]", form);
  bindForm(form, async (data) => {
    const file = data.get("archive"), version = data.get("version"), notes = data.get("notes");
    if (!file.size || file.size > 8_000_000) throw new Error("Choose a ZIP between 1 byte and 8 MB.");
    if (new TextEncoder().encode(notes).length > 2048) throw new Error("Shorten the release notes to 2,048 UTF-8 bytes or fewer.");
    if (!globalThis.crypto?.subtle) throw new Error("Use an HTTPS connection to verify the ZIP checksum.");
    try {
      status.textContent = "Calculating the ZIP checksum…";
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      status.textContent = "Uploading and verifying version " + version + "…";
      await api("/api/admin/addon/releases", file, {
        "X-Addon-Version": version,
        "X-Addon-Notes": encodeURIComponent(notes),
        "X-Addon-SHA256": checksum,
      });
    } finally {
      status.textContent = "";
    }
    form.reset();
    message("Published addon version " + version + ".", true);
    await refresh();
  });
  return card;
}

async function render() {
  const me = await api("/api/auth/me");
  rosterNavigation(me);
  const root = $("#workspace"), list = node("div");
  root.replaceChildren(list);
  const refresh = async () => {
    if (me.canDownloadAddon) {
      try { await showReleases(list); }
      catch (error) {
        const notice = node("p", error.message);
        notice.setAttribute("role", "alert");
        list.replaceChildren(notice, link("Member Home", "/account.html"));
      }
    }
  };
  if (me.canDownloadAddon) await refresh();
  else {
    if (!me.user) message("Sign in to see available addon releases.");
    else if (me.addonDownloadsPaused) list.append(node("p", "Addon downloads are temporarily paused."));
    else message("Addon access is unavailable.");
    list.append(link("Member Home", "/account.html"));
  }
  if (me.user?.role === "ADMIN") root.prepend(uploadForm(refresh));
}
render().catch((e) => {
  $("#workspace").replaceChildren(link("Member Home", "/account.html"));
  message(e.message);
});
