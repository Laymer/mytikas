import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = await mkdtemp(join(tmpdir(),'mytikas-helper-'));
try {
  await mkdir(join(root,'bin')); await mkdir(join(root,'scripts'));
  await copyFile('mytikas.sh',join(root,'mytikas.sh'));
  await copyFile('scripts/init-env.mjs',join(root,'scripts/init-env.mjs'));
  for (const name of ['dirname','bash','cat','mkdir','rm']) await symlink(`/usr/bin/${name}`,join(root,'bin',name));
  const env = {...process.env,PATH:join(root,'bin')};
  const run = (...args) => spawnSync('/usr/bin/bash',[join(root,'mytikas.sh'),...args],{cwd:'/tmp',env,encoding:'utf8'});
  assert.equal(run('help').status,0);
  assert.notEqual(run('unknown').status,0);
  assert.match(run('status').stderr,/Docker required/);
  assert.match(run('init').stderr,/Node.js 24 required/);
  await symlink(process.execPath,join(root,'bin','node'));
  assert.equal(run('init').status,0);
  const initial = await readFile(join(root,'.env'),'utf8');
  assert.equal(run('init').status,0);
  assert.equal(await readFile(join(root,'.env'),'utf8'),initial);
  await writeFile(join(root,'bin','docker'),`#!/usr/bin/bash
if [[ $1 == compose && $2 == version ]]; then echo 2.24.4; exit; fi
if [[ $1 == info ]]; then exit; fi
printf '%s\\n' "$@" > '${root}/args'
if [[ " $* " == *" config "* ]]; then exit; fi
exit 37
`,{mode:0o700});
  assert.equal(run('db','-c',"SELECT 'a b';").status,37);
  assert((await readFile(join(root,'args'),'utf8')).includes("SELECT 'a b';\n"));
  assert.equal(run('logs','--bad').status,1);
  assert.equal(run('backup',join(root,'failed.dump')).status,37);
  await assert.rejects(readFile(join(root,'failed.dump')), {code:'ENOENT'});
  console.log('✓ Helper external-directory invocation, missing prerequisites, init preservation, quoting, invalid commands and failure propagation');
} finally { await rm(root,{recursive:true,force:true}); }
