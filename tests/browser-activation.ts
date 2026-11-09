import { expect, type Page } from "@playwright/test";
import type { Pool } from "../src/db.js";
import { mailToken, PASS } from "./harness.js";
export async function activateBrowser(
  page: Page,
  pool: Pool,
  origin: string,
  address: string,
  checkpoint: () => Promise<void> = async () => {},
) {
  const token = await mailToken(pool, address);
  await checkpoint();
  await page.goto(`${origin}/email.html#verify=${token}`);
  await expect(
    page.getByRole("button", { name: "Verify email", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${origin}/email.html`);
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page.locator("#message")).toContainText("Email verified");
  await checkpoint();
  await page.getByRole("link", { name: "Return to sign in" }).click();
  await page.locator("#login-email").fill(address);
  await page.locator("#login-password").fill(PASS);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".tag")).toHaveText("SUBMITTED");
}
