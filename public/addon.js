import { $, action, api, bindForm, node, message, date } from "./common.js?v=publisher-1";
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

const submissionStates = {
  queued: "Queued", stored: "Archive stored", review: "Awaiting PR review",
  blocked: "Needs attention", closed: "PR closed", published: "Published",
};
const repository = "https://github.com/Mytikas-Monster/OlympusMytikas";

async function showSubmissions(root) {
  const submissions = await api("/api/admin/addon/submissions");
  const list = node("ul", undefined, "addon-file-list");
  for (const s of submissions) {
    const item = node("li");
    item.append(node("strong", "Version " + s.version + " · " + submissionStates[s.status]));
    item.id = "submission-" + s.id;
    const identity = node("p");
    identity.append(link("Submission #" + s.id, "#" + item.id));
    if (s.archive_id) identity.append(" · Archive #" + s.archive_id);
    item.append(identity);
    if (s.pr_number) item.append(link("Pull request #" + s.pr_number, repository + "/pull/" + s.pr_number));
    if (s.status === "published") {
      const release = node("p");
      release.append(link("GitHub release v" + s.version, repository + "/releases/tag/v" + s.version));
      item.append(release);
    }
    if (s.curseforge_file_id) item.append(node("p", "CurseForge file #" + s.curseforge_file_id));
    if (s.detail) item.append(node("p", s.detail));
    list.append(item);
  }
  root.replaceChildren(submissions.length ? list : node("p", "No submissions yet."));
  return submissions;
}

function uploadForm(refresh) {
  const form = node("form");
  form.setAttribute("aria-label", "Submit an Olympus release");
  form.innerHTML = `<fieldset>
      <label for="release-version">Release version</label>
      <input id="release-version" name="version" required maxlength="26" placeholder="1.2.3" aria-describedby="archive-help">
      <label for="release-file">Addon ZIP</label>
      <input id="release-file" name="archive" type="file" accept=".zip,application/zip" required aria-describedby="archive-help">
      <p id="archive-help" class="meta">Choose a ZIP up to 8 MB. The version must match OlympusMytikas/OlympusMytikas.toc in the ZIP.</p>
      <label for="release-notes">Release notes for players</label>
      <textarea id="release-notes" name="notes" required maxlength="2048" rows="3"></textarea>
    </fieldset><button type="submit">Submit for review</button><p role="status"></p>`;
  const fields = $("fieldset", form), status = $("[role=status]", form);
  const toggle = checksumToggle(form);
  fields.append(toggle);
  bindForm(form, async (data) => {
    const file = data.get("archive"), notes = data.get("notes"), version = data.get("version").trim();
    if (!file.size || file.size > 8_000_000) throw new Error("Choose a ZIP between 1 byte and 8 MB.");
    if (!notes.trim()) throw new Error("Describe the player-visible changes in the release notes.");
    if (new TextEncoder().encode(notes).length > 2048) throw new Error("Shorten the release notes to 2,048 UTF-8 bytes or fewer.");
    const skip = toggle.getAttribute("aria-pressed") === "true";
    fields.disabled = true;
    try {
      const headers = {"X-Addon-Version": version, "X-Addon-Notes": encodeURIComponent(notes), "X-Addon-Checksum-Mode": skip ? "skip" : "verify"};
      if (!skip) {
        status.textContent = "Calculating the ZIP checksum…";
        headers["X-Addon-SHA256"] = await sha256(file);
      }
      status.textContent = "Uploading and verifying " + file.name + "…";
      const submission = await api("/api/admin/addon/releases", file, headers);
      form.reset();
      message("Version " + submission.version + " · " + submissionStates[submission.status] + " (submission #" + submission.id + ").", true);
    } catch (error) {
      if (error.uncertain && error.status !== 503) {
        error.message = "Submission could not be confirmed. Retry the same ZIP, version and notes to recover its status.";
      }
      error.uncertain = false;
      throw error;
    } finally {
      fields.disabled = false;
      status.textContent = "";
      await refresh();
    }
  });
  return form;
}

function publisher(refreshFiles, submissionsEnabled, submissions, refreshSubmissions) {
  const panel = node("aside", undefined, "addon-publisher card");
  panel.setAttribute("aria-label", "Admin publishing");
  panel.innerHTML = `<h2>Publish</h2><label for="upload-type">Upload type</label>
    <select id="upload-type"><option value="files">Addon files</option><option value="release">Olympus release</option></select>`;
  const select = $("select", panel), files = filesForm(refreshFiles), release = node("section");
  release.append(submissionsEnabled ? uploadForm(refreshSubmissions) : node("p", "Olympus release submissions are paused."));
  release.append(node("h3", "Submission history"), action("Refresh status", refreshSubmissions), submissions);
  release.hidden = true;
  select.addEventListener("change", () => {
    files.hidden = select.value !== "files";
    release.hidden = select.value !== "release";
    if (!release.hidden) refreshSubmissions();
  });
  if (/^#submission-[1-9]\d*$/.test(location.hash)) {
    select.value = "release";
    files.hidden = true;
    release.hidden = false;
    refreshSubmissions().then(() => document.getElementById(location.hash.slice(1))?.scrollIntoView());
  }
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
  if (admin) {
    const submissions = node("div");
    const refreshSubmissions = () => refresh(submissions, showSubmissions, true);
    root.prepend(publisher(refreshFiles, me.addonSubmissionsEnabled, submissions, refreshSubmissions));
  }
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
