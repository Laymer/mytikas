import { $, api, date, message, node } from "./common.js";
import { rosterNavigation } from "./roster.js";

api("/api/auth/me").then(rosterNavigation).catch(() => rosterNavigation({}));

function pageLink(label, page) {
  const link = node("a", label);
  link.href = `?page=${page}`;
  return link;
}

const results = $("#fighter-results");
try {
  const requested = new URLSearchParams(location.search).get("page") || "1";
  const { fighters, page, pageCount, total, stale, updatedAt } =
    await api(`/api/fighters?page=${encodeURIComponent(requested)}`);

  const query = page === 1 ? "" : `?page=${page}`;
  if (location.search !== query)
    history.replaceState(null, "", location.pathname + query + location.hash);

  $("#fighter-total").textContent = `${total} guild member${total === 1 ? "" : "s"}`;
  results.replaceChildren();
  if (stale) results.append(node("p", `Showing the armory roster from ${date(updatedAt)}.`, "meta"));
  if (total === 0) {
    results.append(node("p", "No guild members are visible in the armory."));
  } else {
    const grid = node("ul", undefined, "fighter-grid");
    for (const fighter of fighters) {
      const item = node("li");
      const card = node("a", undefined, "roster-cell");
      card.href = fighter.armoryUrl;
      card.append(
        node("strong", fighter.name, `class-${fighter.class || "unknown"}`),
        node("span", fighter.class || "Unknown class", "meta"),
        node("span", `Level ${fighter.level}`, "meta"),
      );
      item.append(card);
      grid.append(item);
    }
    results.append(grid);
  }
  if (pageCount > 1) {
    const pages = node("nav", undefined, "fighter-pages");
    pages.setAttribute("aria-label", "Fighter pages");
    if (page > 1) pages.append(pageLink("Previous", page - 1));
    pages.append(node("span", `Page ${page} of ${pageCount}`, "meta"));
    if (page < pageCount) pages.append(pageLink("Next", page + 1));
    results.append(pages);
  }
} catch (error) {
  const retry = node("a", "Try again", "button");
  retry.href = location.href;
  results.replaceChildren(retry);
  message(error.message);
}
