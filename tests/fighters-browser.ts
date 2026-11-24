import { expect, type Page } from "@playwright/test";
import assert from "node:assert/strict";

export async function fightersBrowser(page: Page, origin: string, checkpoint: () => Promise<void>) {
  const fighters = Array.from({ length: 26 }, (_, index) => ({
    name: `Summit ${index + 1}`, class: index === 25 ? "Hunter" : "Warrior", level: 60,
    armoryUrl: `https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/character/summit-${index + 1}`,
  }));
  const updatedAt = "2026-11-20T12:00:00.000Z";
  let roster = fighters;
  let state: "fresh" | "stale" | "unavailable" = "fresh";
  const pattern = `${origin}/api/fighters?*`;
  await page.route(pattern, async route => {
    const request = route.request();
    assert.equal(request.method(), "GET");
    const requested = Number(new URL(request.url()).searchParams.get("page"));
    assert.ok(Number.isInteger(requested) && requested > 0);
    if (state === "unavailable") {
      return route.fulfill({status: 503, json: {error: "Armory unavailable."}});
    }
    const pageCount = Math.max(1, Math.ceil(roster.length / 25));
    const current = Math.min(requested, pageCount);
    return route.fulfill({json: {
      fighters: roster.slice((current - 1) * 25, current * 25),
      total: roster.length, page: current, pageCount, updatedAt, stale: state === "stale",
    }});
  });
  const viewport = page.viewportSize();
  const cards = page.locator(".fighter-grid").getByRole("link");
  const next = page.getByRole("link", { name: "Next", exact: true });
  const previous = page.getByRole("link", { name: "Previous", exact: true });
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  const directoryURL = origin + "/fighters.html";
  await checkpoint();
  await page.getByRole("navigation").getByRole("link", {name: "Our fighters"}).click();
  await expect(page).toHaveURL(directoryURL);
  await expect(page.getByRole("heading", {name: "Our fighters", level: 1})).toBeVisible();
  await expect(page.locator("#fighter-total")).toHaveText("26 guild members");
  await expect(cards).toHaveCount(25);
  await expect(cards.first()).toHaveAccessibleName(/Summit 1.*Warrior.*Level 60/i);
  await expect(cards.last()).toHaveAttribute("href", fighters[24]!.armoryUrl);
  await expect(page.getByText("Page 1 of 2", {exact: true})).toBeVisible();
  await expect(previous).toHaveCount(0);
  assert.ok(await noOverflow(), "Desktop directory overflows");
  // The card itself is keyboard-accessible and leads to the official profile.
  // Fulfil only that navigation locally so this suite never contacts the armory.
  await page.context().route(fighters[0]!.armoryUrl, route => route.fulfill({contentType: "text/html", body: "<title>Isolated armory</title>"}));
  await cards.first().focus();
  await page.keyboard.press("Tab");
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cards.first()).toBeFocused();
  await expect(cards.first()).toHaveAttribute("href", fighters[0]!.armoryUrl);
  await checkpoint();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(fighters[0]!.armoryUrl);
  await page.goBack();
  await expect(cards).toHaveCount(25);
  await page.setViewportSize({width: 390, height: 844});
  assert.ok(await noOverflow(), "Mobile directory overflows");
  await next.focus();
  await checkpoint();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(directoryURL + "?page=2");
  await expect(page.getByText("Page 2 of 2", {exact: true})).toBeVisible();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAccessibleName(/Summit 26.*Hunter.*Level 60/i);
  await expect(next).toHaveCount(0);
  await expect(previous).toBeVisible();
  await expect(page.locator("#fighter-total")).toHaveText("26 guild members");
  await checkpoint();
  await page.goBack();
  await expect(cards).toHaveCount(25);
  state = "stale";
  await checkpoint();
  await page.reload();
  await expect(cards).toHaveCount(25);
  const formattedDate = await page.evaluate(value => new Date(value).toLocaleString(), updatedAt);
  await expect(page.getByText(`Showing the armory roster from ${formattedDate}.`)).toBeVisible();
  state = "unavailable";
  await checkpoint();
  await page.reload();
  await expect(page.getByRole("link", {name:"Try again"})).toBeVisible();
  await expect(page.getByText(/No guild members are visible/)).toHaveCount(0);
  await expect(cards).toHaveCount(0);
  state = "fresh";
  roster = [];
  await checkpoint();
  await page.getByRole("link", {name:"Try again"}).click();
  await expect(page.getByText(/No guild members are visible/)).toBeVisible();
  await expect(cards).toHaveCount(0);
  await expect(page.locator("#fighter-total")).toHaveText("0 guild members");
  // A saved link beyond the current last page follows the page returned by the
  // API. The public roster still works when optional account navigation fails.
  roster = [{...fighters[0]!, class: ""}];
  await page.route(`${origin}/api/auth/me`, route => route.fulfill({status: 503, json: {error: "Unavailable"}}), {times: 1});
  await checkpoint();
  await page.goto(directoryURL + "?page=99");
  await expect(page).toHaveURL(directoryURL);
  await expect(page.locator("#fighter-total")).toHaveText("1 guild member");
  await expect(cards.first()).toHaveAccessibleName(/Summit 1.*Unknown class.*Level 60/i);
  await expect(page.getByRole("navigation", {name: "Main navigation"}).getByRole("link", {name: "Mytikas Addon"})).toBeVisible();
  await page.unroute(pattern);
  await page.context().unroute(fighters[0]!.armoryUrl);
  if (viewport) await page.setViewportSize(viewport);
  await checkpoint();
  await page.goto(origin);
  console.log("✓ Public fighters roster, keyboard profile links, responsive paging, browser Back, stale, retry and empty states");
}
