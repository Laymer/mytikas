import { $, api, bindForm, node, message, date } from "./common.js?v=publisher-1";
import { rosterNavigation } from "./roster.js?v=publisher-1";
import { link } from "./member.js";
import { checksumToggle, filesForm, sha256, showFiles } from "./addon-files.js?v=publisher-1";
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
  return releases;
}

function uploadForm(refresh) {
  const form = node("form");
  form.setAttribute("aria-label", "Publish an addon release");
  form.innerHTML = `<fieldset>
      <label for="release-file">Addon ZIP</label>
      <input id="release-file" name="archive" type="file" accept=".zip,application/zip" required aria-describedby="archive-help">
      <p id="archive-help" class="meta">Choose a ZIP up to 8 MB. The version comes from OlympusMytikas/OlympusMytikas.toc inside the archive.</p>
      <label for="release-notes">Release notes (optional)</label>
      <textarea id="release-notes" name="notes" maxlength="2048" rows="3"></textarea>
    </fieldset><button type="submit">Publish release</button><p role="status"></p>`;
  const fields = $("fieldset", form), status = $("[role=status]", form);
  const toggle = checksumToggle(form);
  fields.append(toggle);
  bindForm(form, async (data) => {
    const file = data.get("archive"), notes = data.get("notes");
    if (!file.size || file.size > 8_000_000) throw new Error("Choose a ZIP between 1 byte and 8 MB.");
    if (new TextEncoder().encode(notes).length > 2048) throw new Error("Shorten the release notes to 2,048 UTF-8 bytes or fewer.");
    const skip = toggle.getAttribute("aria-pressed") === "true";
    let checksum, release;
    fields.disabled = true;
    try {
      const headers = {"X-Addon-Notes": encodeURIComponent(notes), "X-Addon-Checksum-Mode": skip ? "skip" : "verify"};
      if (!skip) {
        status.textContent = "Calculating the ZIP checksum…";
        checksum = await sha256(file);
        headers["X-Addon-SHA256"] = checksum;
      }
      status.textContent = "Uploading and verifying " + file.name + "…";
      release = await api("/api/admin/addon/releases", file, headers);
    } catch (error) {
      if (error.status === 409 || error.uncertain) {
        status.textContent = "Checking published releases for this ZIP…";
        const releases = await refresh();
        const existing = releases?.find(entry => entry.sha256 === checksum);
        if (existing) {
          message("Version " + existing.version + " is already published with this ZIP.", true);
          if (error.uncertain) form.reset();
          return;
        }
        if (error.status === 409) {
          error.message += " To publish different files, update the version in OlympusMytikas.toc and rebuild the ZIP.";
        } else {
          // Published versions are immutable, so retrying this file cannot overwrite a release.
          error.uncertain = false;
          error.message = "Publication could not be confirmed. Retry the same ZIP. Each version can be published only once.";
        }
      }
      throw error;
    } finally {
      fields.disabled = false;
      status.textContent = "";
    }
    form.reset();
    message("Published addon version " + release.version + ".", true);
    await refresh();
  });
  return form;
}

function publisher(refreshFiles, refreshReleases) {
  const panel = node("aside", undefined, "addon-publisher card");
  panel.setAttribute("aria-label", "Admin publishing");
  panel.innerHTML = `<h2>Publish</h2><label for="upload-type">Upload type</label>
    <select id="upload-type"><option value="files">Addon files</option><option value="release">Olympus release</option></select>`;
  const select = $("select", panel), files = filesForm(refreshFiles), release = uploadForm(refreshReleases);
  release.hidden = true;
  select.addEventListener("change", () => {
    files.hidden = select.value !== "files";
    release.hidden = select.value !== "release";
  });
  panel.append(files, release);
  return panel;
}

async function render() {
  const me = await api("/api/auth/me");
  rosterNavigation(me);
  const root = $("#workspace"), catalogue = node("div"), files = node("section", undefined, "card"), releases = node("div");
  root.className = "addon-layout";
  root.replaceChildren(catalogue);
  async function refresh(target, load, allowed) {
    if (!allowed) return;
    try { return await load(target); }
    catch (error) {
      const notice = node("p", error.message);
      notice.setAttribute("role", "alert");
      target.replaceChildren(notice, link("Member Home", "/account.html"));
    }
  }
  const admin = me.user?.role === "ADMIN";
  const refreshFiles = () => refresh(files, target => showFiles(target, me), admin || !me.addonDownloadsPaused);
  const refreshReleases = () => refresh(releases, showReleases, me.canDownloadAddon);
  if (admin) root.prepend(publisher(refreshFiles, refreshReleases));
  if (me.addonDownloadsPaused) {
    catalogue.append(node("p", "Addon downloads are temporarily paused."), link("Member Home", "/account.html"));
    if (admin) {
      catalogue.append(files);
      await refreshFiles();
    }
    return;
  }
  catalogue.append(files);
  if (me.canDownloadAddon) {
    const guide = node("section", undefined, "card");
    guide.append(node("h2", "Olympus releases"),
      node("p", "Extract the ZIP into _forever_/Interface/AddOns. Disable the standalone OlympusRecruit and KillOnSight addons, then reload World of Warcraft."));
    catalogue.append(guide, releases);
  } else {
    catalogue.append(node("p", me.user ? "Member releases are unavailable for this account." : "Sign in to see member releases."),
      link("Member Home", "/account.html"));
  }
  await Promise.all([refreshFiles(), refreshReleases()]);
}
render().catch((e) => {
  $("#workspace").replaceChildren(link("Member Home", "/account.html"));
  message(e.message);
});
