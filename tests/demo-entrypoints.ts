import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { harness, listen, close, PASS } from "./harness.js";

const h = await harness();
const reservation = createServer();
const port = await listen(reservation);
await close(reservation);
const origin = "http://127.0.0.1:" + port;
const env = {
  ...process.env,
  DATABASE_URL: h.cfg.databaseUrl,
  SESSION_SECRET: h.cfg.sessionSecret,
  MYTIKAS_DEMO: "1",
  DEPLOYMENT_PROFILE: "demo",
  DEMO_PASSWORD: PASS,
  APP_ORIGIN: origin,
  PUBLIC_SITE_ORIGIN: origin,
  PORT: String(port),
  INGRESS_MODE: "none",
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  DISCORD_WEBHOOK_URL: "",
};
function launch(
  entry: string,
  args: string[] = [],
  extra: Record<string, string> = {},
) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/demo/" + entry + ".ts", ...args],
    {
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 25000,
      killSignal: "SIGKILL",
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const finished = once(child, "close").then(([code]) => ({ code, output }));
  return { child, finished };
}
async function command(
  entry: string,
  args: string[],
  code: number,
  expected: RegExp,
  extra = {},
) {
  const result = await launch(entry, args, extra).finished;
  assert.equal(result.code, code, "Unexpected demo process exit for " + entry);
  assert.match(result.output, expected);
  return result.output;
}
async function waitFor(check: () => Promise<boolean>) {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error("Demo process did not become ready.");
}

try {
  await command("seed", [], 1, /isolated demo deployment/, {
    DEPLOYMENT_PROFILE: "public",
  });
  await command("cli", ["accounts"], 1, /isolated demo deployment/, {
    MYTIKAS_DEMO: "0",
  });
  for (const [entry, args] of [
    ["cli", ["accounts"]],
    ["cli", ["summary"]],
    ["worker", []],
    ["server", []],
  ] as const) {
    const output = await command(
      entry,
      [...args],
      1,
      /dataset is missing or unsupported/,
    );
    assert.ok(!output.includes("admin@example.test") && !output.includes(PASS));
  }
  await h.pool.query("DELETE FROM users");
  await command("seed", [], 0, /Demo dataset ready/);
  await command("cli", ["ready"], 0, /Demo dataset ready/);
  await h.pool.query("INSERT INTO demo_dataset VALUES ('different-dataset')");
  await command("cli", ["ready"], 1, /dataset is missing or unsupported/);
  await command("seed", [], 1, /Unsupported demo dataset/);
  await h.pool.query(
    "DELETE FROM demo_dataset WHERE version='different-dataset'",
  );
  await command("cli", ["accounts"], 0, /admin@demo\.test/);
  await command("cli", ["summary"], 0, /outsider/);
  await command(
    "cli",
    ["armory", "approved@demo.test", "member"],
    0,
    /fixture updated/,
  );
  await command("cli", ["check", "approved@demo.test"], 0, /MATCH/);
  await command(
    "cli",
    ["armory", "reopened@demo.test", "unknown"],
    1,
    /State must be/,
  );
  await command(
    "cli",
    ["check", "missing@demo.test"],
    1,
    /Applicant not found/,
  );
  await command("cli", ["unknown"], 1, /Unknown demo command/);
  const server = launch("server");
  try {
    await waitFor(async () => {
      try {
        return (
          (await (await fetch(origin + "/api/runtime")).json()).mode === "demo"
        );
      } catch {
        return false;
      }
    });
  } finally {
    server.child.kill("SIGTERM");
    assert.equal((await server.finished).code, 0);
  }
  await h.pool.query(
    "INSERT INTO auth_limits VALUES('demo-worker-fixture', 1, now()-interval '1 day')",
  );
  const worker = launch("worker");
  try {
    await waitFor(
      async () =>
        (
          await h.pool.query(
            "SELECT 1 FROM auth_limits WHERE key='demo-worker-fixture'",
          )
        ).rowCount === 0,
    );
  } finally {
    worker.child.kill("SIGTERM");
    assert.equal((await worker.finished).code, 0);
  }
  console.log(
    "Demo processes enforce isolation and support the seeded CLI, real HTTP startup and graceful worker exit.",
  );
} finally {
  await h.stop();
}
