import {expect,type Page} from "@playwright/test";
import {type harness} from "./harness.js";
import {transaction} from "../src/db.js";
import {importReport} from "../src/blacklist.js";

export async function memberBrowser(page:Page,h:Awaited<ReturnType<typeof harness>>) {
  const url=h.cfg.origin;
  await page.goto(url+"/addon.html");
  await expect(page.getByText("Waiting for the first verified release.")).toBeVisible();
  await h.pool.query("INSERT INTO addon_releases VALUES('1.0.1',now(),'Window update',$1,$2),('1.0.0',now(),'Original',$1,$2)",["0".repeat(64),Buffer.from("browser fixture")]);
  await page.reload();
  await expect(page.getByRole("link",{name:"Download OlympusMytikas-1.0.0.zip"})).toBeVisible();
  await page.goto(url+"/blacklist.html");
  await expect(page.getByText("No matching reports.")).toBeVisible();
  await transaction(h.pool,async c=>{
    await importReport(c,{id:"12345",channel_id:"12",author:{id:"432"},timestamp:new Date(),content:"Name: Absent\nSurname: Character\nReason: Officer fixture"},"34","12");
  });
  await page.reload();
  await expect(page.getByText("Officer fixture")).toBeVisible();
  await page.getByLabel("Character name").fill("Absent");await page.getByRole("button",{name:"Search"}).click();
  await page.getByLabel("Correction reason").fill("Wrong character");await page.getByRole("button",{name:"Void mistaken report"}).click();
  await expect(page.getByText(/Voided by/)).toBeVisible();
  for(const width of [390,1200]){
    await page.setViewportSize({width,height:844});await page.goto(url+"/account.html?discord=cancelled");
    await expect(page.getByRole("heading",{name:"Member Home"})).toBeVisible();
    await expect(page.getByText("Current release · 1.0.1")).toBeVisible();
  }
  await page.route("**/api/discord",route=>route.fulfill({json:{configured:true,invite:"https://discord.gg/fixture",membership:"confirmed",link:{username:"BrowserFixture"},checkedAt:new Date().toISOString()}}));
  await page.reload();await page.getByRole("button",{name:"Unlink Discord"}).click();
  await page.unroute("**/api/discord");
  await page.route("**/api/discord",route=>route.fulfill({json:{configured:true,invite:"https://discord.gg/fixture"}}));
  await page.route("**/api/discord/link",route=>route.fulfill({json:{url:url+"/account.html?discord=linked"}}));
  await page.reload();await page.getByRole("button",{name:"Link Discord account"}).click();
  await expect(page.getByText("Discord account linked.")).toBeVisible();
  await page.unroute("**/api/discord");await page.unroute("**/api/discord/link");
  // Exercise direct visits when the session expires.
  for(const name of ["addon","blacklist"]){
    await page.route("**/api/"+name+"*",route=>route.fulfill({status:403,json:{error:"Denied"}}));
    await page.goto(url+"/"+name+".html");await expect(page.getByText("Denied")).toBeVisible();
    await page.unroute("**/api/"+name+"*");
  }
  await page.setViewportSize({width:390,height:844});
  await page.goto(url+"/account.html");
}
