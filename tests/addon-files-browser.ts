import { expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Zip from "adm-zip";

export async function loseUploadResponse(page: Page, path: string) {
  await page.evaluate(path => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      if (String(args[0]) === path) {
        window.fetch = original;
        await original(...args);
        throw new TypeError("Fixture connection interrupted after the server response");
      }
      return original(...args);
    };
  }, path);
}

export async function publishFiles(page: Page) {
  const panel = page.getByRole("complementary", {name: "Admin publishing"});
  const form = panel.getByRole("form", {name: "Publish addon files"});
  const files = form.getByLabel("Choose files"), folder = form.getByLabel("Choose a folder");
  const visibility = form.getByLabel("Visibility"), notes = form.getByLabel("Notes (optional)");
  const skip = form.getByRole("button", {name:"Skip checksum verification"});
  const submit = form.getByRole("button", {name:"Publish files"}), alert = page.locator("#message");
  const path = "/api/admin/addon-files";
  const upload = () => page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(path));
  const privateFile = {name:"officer-list.txt", mimeType:"text/plain", buffer:Buffer.from("synthetic private list")};
  const publicFile = {name:"guild-setup.lua", mimeType:"application/octet-stream", buffer:Buffer.from("-- synthetic addon")};

  await expect(panel.getByLabel("Upload type")).toHaveValue("files");
  await page.setViewportSize({width:1440,height:940});
  const submitBox = (await submit.boundingBox())!;
  expect(submitBox.height).toBeGreaterThanOrEqual(40);
  expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(940);
  const catalogue = page.getByRole("heading", {name:"Addon files", exact:true});
  await expect(catalogue).toBeVisible();
  const panelBox = (await panel.boundingBox())!;
  expect((await catalogue.boundingBox())!.x).toBeGreaterThanOrEqual(panelBox.x + panelBox.width);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.setViewportSize({width:1280,height:720});
  await expect(visibility).toHaveValue("private");
  await submit.click();
  await expect(alert).toHaveText("Choose files or a folder to publish.");
  await files.setInputFiles({...privateFile, buffer:Buffer.alloc(8_000_001)});
  await submit.click();
  await expect(alert).toContainText("8 MB");
  await files.setInputFiles([privateFile, privateFile]);
  await submit.click();
  await expect(alert).toContainText("Choose each file path only once.");
  await files.setInputFiles(privateFile);
  await notes.fill("é".repeat(1025));
  await submit.click();
  await expect(alert).toContainText("2,048 UTF-8 bytes");
  await notes.fill("Staff setup notes");
  const verified = upload();
  await submit.click();
  const result = await verified;
  expect(result.status()).toBe(201);
  expect(result.request().headers()["x-addon-checksum-mode"]).toBe("verify");
  await expect(alert).toHaveText("Published officer-list.txt as private.");
  const privateRow = page.getByRole("listitem").filter({has:page.getByRole("link",{name:privateFile.name})});
  await expect(privateRow).toContainText("Staff setup notes");
  await privateRow.getByText("File details").click();
  await expect(privateRow).toContainText("1 file ·");
  await expect(privateRow).toContainText("SHA-256 ");

  await files.setInputFiles(publicFile);
  await visibility.selectOption("public");
  await page.evaluate(() => {
    Object.defineProperty(crypto, "subtle", {configurable:true, value:undefined});
    Object.defineProperty(crypto, "randomUUID", {configurable:true, value:undefined});
  });
  try {
    await submit.click();
    await expect(alert).toContainText("Use HTTPS to verify checksums");
    await skip.focus();
    await page.keyboard.press("Space");
    await expect(skip).toHaveAttribute("aria-pressed","true");
    await loseUploadResponse(page, path);
    const interrupted = upload();
    await submit.click();
    const first = await interrupted;
    expect(first.status()).toBe(201);
    expect(first.request().headers()["x-addon-checksum-mode"]).toBe("skip");
    expect(first.request().headers()["x-addon-sha256"]).toBeUndefined();
    await expect(alert).toContainText("Retry without changing the selection");
    await page.evaluate(() => Reflect.deleteProperty(crypto, "subtle"));
    await skip.click();
    const resumed = upload();
    await submit.click();
    const retry = await resumed;
    expect(retry.status()).toBe(200);
    expect(retry.request().headers()["x-addon-checksum-mode"]).toBe("verify");
    expect(retry.request().headers()["x-upload-id"]).toBe(first.request().headers()["x-upload-id"]);
    await expect(alert).toHaveText("Published guild-setup.lua as public.");
  } finally {
    await page.evaluate(() => {
      Reflect.deleteProperty(crypto, "subtle");
      Reflect.deleteProperty(crypto, "randomUUID");
    });
  }
  await expect(skip).toHaveAttribute("aria-pressed","false");
  await expect(visibility).toHaveValue("private");
  await files.setInputFiles({...privateFile, name:"draft.txt"});
  await page.route("**/api/admin/addon-files", route => route.abort(), {times:1});
  const failed = page.waitForRequest(r => r.method() === "POST" && r.url().endsWith(path));
  await submit.click();
  const previousId = (await failed).headers()["x-upload-id"];
  await expect(alert).toContainText("Retry without changing the selection");
  await notes.fill("Revised notes");
  await expect(form.getByRole("status")).toContainText("Check its filename and visibility");
  const newUpload = upload();
  await submit.click();
  const replacement = await newUpload;
  expect(replacement.status()).toBe(201);
  expect(replacement.request().headers()["x-upload-id"]).not.toBe(previousId);
  await expect(alert).toHaveText("Published draft.txt as private.");

  const publicRow = page.getByRole("listitem").filter({has:page.getByRole("link",{name:publicFile.name})});
  const publicPath = await publicRow.getByRole("link",{name:publicFile.name}).getAttribute("href");
  const privatePath = await privateRow.getByRole("link",{name:privateFile.name}).getAttribute("href");
  const visitor = await page.context().browser()!.newContext();
  const origin = new URL(page.url()).origin;
  try {
    const download = () => visitor.request.get(new URL(publicPath!,origin).href);
    expect(await (await download()).body()).toEqual(publicFile.buffer);
    expect((await visitor.request.get(new URL(privatePath!, origin).href)).status()).toBe(404);
    await publicRow.getByRole("button",{name:"Make private"}).click();
    await expect(alert).toHaveText("guild-setup.lua is now private.");
    expect((await download()).status()).toBe(404);
    await publicRow.getByRole("button",{name:"Make public"}).click();
    await expect(alert).toHaveText("guild-setup.lua is now public.");
    expect(await (await download()).body()).toEqual(publicFile.buffer);
  } finally { await visitor.close(); }

  const directory = await mkdtemp(join(tmpdir(),"mytikas-generic-upload-"));
  try {
    const root = join(directory,"GuildPack");
    await mkdir(join(root,"nested"),{recursive:true});
    await writeFile(join(root,"nested","settings.txt"),"directory fixture");
    await folder.setInputFiles(root);
    await files.setInputFiles([
      {name:"schedule.json", mimeType:"application/json", buffer:Buffer.from("{}")},
      {name:"art.dat", mimeType:"application/octet-stream", buffer:Buffer.from([0,1,255])},
    ]);
    const packed = upload();
    await submit.click();
    const response = await packed;
    expect(response.status()).toBe(201);
    const item = await response.json();
    expect(item.file_count).toBe(3);
    expect(item.visibility).toBe("private");
    const download = await page.context().request.get(origin + "/api/addon-files/" + item.id);
    const zip = new Zip(await download.body());
    expect(zip.readAsText("GuildPack/nested/settings.txt")).toBe("directory fixture");
    expect(zip.readAsText("schedule.json")).toBe("{}");
    expect(zip.readFile("art.dat")).toEqual(Buffer.from([0,1,255]));
    await expect(alert).toHaveText("Published " + item.filename + " as private.");
  } finally { await rm(directory, {recursive:true,force:true}); }
}
