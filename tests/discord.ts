import assert from "node:assert/strict";
import { discordPayload } from "../src/discord.js";
import { runLoop } from "../src/worker.js";
const submission = {
  id: "e64659d0-38d6-41bd-bfe0-dd0939d19e5a", application_id: "64db7b0b-e826-4e7c-a622-b547c89540c4",
  revision: 2, character_name: "**Character** @everyone", motivation: "<@123> [link](https://example.test) " + "*".repeat(300),
  rules_id: 7, accepted_at: "2026-11-09T12:00:00Z",
};
const payload = discordPayload(submission, "https://app.mytikas.monster");
assert.deepEqual(payload.allowed_mentions, { parse: [] });
assert.ok(payload.content.includes(`https://app.mytikas.monster/admin.html#${submission.application_id}`));
assert.ok(!payload.content.includes("@everyone"));
assert.ok(payload.embeds[0]!.fields[0]!.value.includes("@\u200b123"));
assert.ok(payload.embeds[0]!.fields[0]!.value.length <= 1024);
assert.ok(payload.embeds[0]!.fields[1]!.value.includes("revision 2"));
assert.ok(payload.embeds[0]!.fields[2]!.value.includes("Version 7"));
assert.deepEqual(Object.keys(payload).sort(), ["allowed_mentions", "content", "embeds"]);
assert.ok(payload.content.length < 2000);
const controller = new AbortController();
let calls = 0;
await runLoop("test", async () => { calls++; controller.abort(); }, controller.signal, 1);
assert.equal(calls, 1);
let unblock!: () => void;
const blocked = new Promise<void>((resolve) => { unblock = resolve; });
const stop = new AbortController();
const slow = runLoop("slow", () => blocked, stop.signal, 1);
let fastCalls = 0;
await runLoop("fast", async () => { if (++fastCalls === 3) stop.abort(); }, stop.signal, 1);
unblock();
await slow;
assert.equal(fastCalls, 3, "A blocked lane does not starve another lane");
console.log("Discord payload and worker scheduling tests passed.");
