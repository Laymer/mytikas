import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

const root = await mkdtemp(join(tmpdir(), "mytikas-credential-tools-"));
const secrets = resolve("scripts/secrets.mjs"),
  audit = resolve("scripts/audit-history.mjs");
function run(cwd, program, args, status = 0) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, status, "Unexpected exit from " + program);
  return result.stdout + result.stderr;
}

try {
  const generated = [];
  for (const name of ["first", "second"]) {
    const dir = join(root, name),
      file = join(dir, ".env");
    await mkdir(dir);
    const output = run(dir, process.execPath, [secrets]);
    const original = await readFile(file, "utf8");
    const env = parseEnv(original);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(env.POSTGRES_PASSWORD, /^[a-f0-9]{64}$/);
    assert.match(env.EMAIL_OUTBOX_KEY, /^[a-f0-9]{64}$/);
    assert.match(env.SESSION_SECRET, /^[a-f0-9]{96}$/);
    assert.equal(new URL(env.DATABASE_URL).password, env.POSTGRES_PASSWORD);
    assert.equal(env.SMTP_PASSWORD, "");
    const retry = run(dir, process.execPath, [secrets], 1);
    assert.equal(await readFile(file, "utf8"), original);
    for (const key of [
      env.EMAIL_OUTBOX_KEY,
      env.SESSION_SECRET,
      env.POSTGRES_PASSWORD,
    ]) {
      assert.ok(
        !output.includes(key) && !retry.includes(key),
        "Generated credential appeared in console output.",
      );
      generated.push(key);
    }
  }
  assert.equal(new Set(generated).size, 6);

  const repo = join(root, "history");
  await mkdir(repo);
  const git = (...args) =>
    run(repo, "git", [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
  git("init", "-q");
  await writeFile(join(repo, ".env.example"), "EXAMPLE=template\n");
  git("add", ".env.example");
  git("commit", "-qm", "Template");
  assert.match(run(repo, process.execPath, [audit]), /0 pattern findings/);
  await writeFile(
    join(repo, ".env"),
    "An ordinary fixture sentence, with no credentials.\n",
  );
  git("add", "-f", ".env");
  git("commit", "-qm", "Local fixture");
  git("rm", "-q", ".env");
  git("commit", "-qm", "Remove fixture");
  assert.match(
    run(repo, process.execPath, [audit], 1),
    /Review sensitive filename: \.env/,
  );
  console.log(
    "Credential generation, private permissions, non-overwrite, redaction and historical-file checks passed.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
