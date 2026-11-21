import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "linux" || process.arch !== "x64") process.exit(0);
const root = await mkdtemp(join(tmpdir(), "mytikas-pg-tools-"));
const cli = resolve("scripts/prepare-pg-tools.mjs");
const docker = join(root, "docker"), log = join(root, "calls");
const destination = join(root, "owner's recovery tools");
const id = "a".repeat(64);
function prepare(args, mode = "") {
  return spawnSync(process.execPath, [cli,...args], {
    env: { ...process.env, PATH: root + ":" + process.env.PATH, FIXTURE_MODE: mode, FIXTURE_LOG: log },
    encoding: "utf8",
  });
}
try {
  // Exercise the extraction CLI with a deterministic Docker executable. Actual
  // PostgreSQL 18 clients and restores run in the separate recovery container suite.
  await writeFile(docker, `#!/bin/sh
set -eu
echo "$1" >> "$FIXTURE_LOG"
case "$1" in
  create) echo "${id}" ;;
  rm) test "$2" = "${id}" ;;
  cp)
    if [ "$FIXTURE_MODE" = unavailable ]; then exit 1; fi
    case "$4" in
      */native/*)
        cat > "$4" <<'CLIENT'
#!/bin/sh
if [ "$1" = "--version" ]; then
  if [ "$FIXTURE_MODE" = wrong ]; then echo 'client (PostgreSQL) 17.0'; else echo 'client (PostgreSQL) 18.0'; fi
else
  printf '%s\\n' "$LD_LIBRARY_PATH" "$@"
fi
CLIENT
        chmod 700 "$4" ;;
      *) : > "$4" ;;
    esac ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  assert.match(prepare([]).stderr, /Usage/);
  await mkdir(destination);
  for (const mode of ["unavailable","wrong"]) {
    const r = prepare([destination],mode);
    assert.equal(r.status, 1);
    assert.deepEqual(await readdir(destination),[]);
    assert.equal((await readFile(log,"utf8")).trim().split("\n").at(-1),"rm");
  }
  const r = prepare([destination]);
  assert.equal(r.status,0);
  const result = JSON.parse(r.stdout);
  for (const name of ["pg_dump","pg_restore","psql"]) {
    const executable = join(result.bin,name);
    assert.equal((await stat(executable)).mode & 0o777,0o700);
    const wrapper = spawnSync(executable,["first argument","second"],{encoding:"utf8"});
    assert.equal(wrapper.status,0);
    assert.deepEqual(wrapper.stdout.trim().split("\n"),[result.lib,"first argument","second"]);
  }
  assert.equal((await readFile(log,"utf8")).trim().split("\n").at(-1),"rm");
  assert.match(prepare([destination]).stderr,/must be empty/);
  assert.deepEqual((await readdir(destination)).sort(),["bin","lib","native"]);
  console.log("PostgreSQL tool preparation preserves existing files, cleans failed extractions and produces working wrappers.");
} finally { await rm(root,{force:true,recursive:true}); }
