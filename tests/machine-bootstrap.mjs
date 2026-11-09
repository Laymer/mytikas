import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=mkdtempSync(join(tmpdir(),'mytikas-bootstrap-test-')),bin=join(root,'bin');mkdirSync(bin);
const script=(name,body)=>writeFileSync(join(bin,name),'#!/bin/bash\n'+body+'\n',{mode:0o700});
script('uname','if [[ $1 == -m ]]; then echo x86_64; else echo "$FAKE_OS"; fi');
script('node',`if [[ $1 == -p ]]; then echo "\${NODE_OLD:-24}"; else cat >/dev/null; echo payload >> "$RECORD"; fi`);
script('docker',`echo "docker $*" >> "$RECORD"; [[ $FAKE_DOCKER == ready || -f "$HOME/ready" ]]`);
script('curl',`echo curl >> "$RECORD"; while [[ $# -gt 0 ]]; do if [[ $1 == --output ]]; then shift; echo fixture > "$1"; fi; shift; done`);
script('shasum',`if [[ $BAD_HASH == 1 ]]; then echo 'bad  file'; elif [[ $3 == */node.tar.gz ]]; then echo '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9  file'; else echo '96b53f9a4a807b6be6207d18f360b9778ff481e1d94b5027bdf1ae2a22d837cb  file'; fi`);
for(const name of ['hdiutil','codesign','spctl','sudo'])script(name,`echo '${name}' >> "$RECORD"`);
script('tar',`stage="$4"; mkdir -p "$stage/node-v24.22.2-linux-x64/bin"; printf '#!/bin/bash\\nif [[ $1 == -p ]]; then echo 24; else cat >/dev/null; echo installed-node >> "$RECORD"; fi\\n' > "$stage/node-v24.22.2-linux-x64/bin/node"; chmod 700 "$stage/node-v24.22.2-linux-x64/bin/node"`);
script('open','echo open >> "$RECORD"; touch "$HOME/ready"');
try {
  let n=0;
  function run(os,docker,extra={}) {
    const home=join(root,String(n++));mkdirSync(home);const record=join(home,'calls');writeFileSync(record,'');
    const result=spawnSync('bash',[resolve('mytikas-machine.sh'),'prepare'],{encoding:'utf8',env:{...process.env,HOME:home,PATH:bin+':/usr/bin:/bin',FAKE_OS:os,FAKE_DOCKER:docker,RECORD:record,...extra}});
    return {...result,calls:readFileSync(record,'utf8')};
  }
  const reuse=run('Linux','ready');assert.equal(reuse.status,0);assert(!reuse.calls.includes('curl'));assert(reuse.calls.includes('payload'));
  const nodeInstall=run('Linux','ready',{NODE_OLD:'22'});assert.equal(nodeInstall.status,0,nodeInstall.stderr);assert(nodeInstall.calls.includes('installed-node'));
  const wsl=run('Linux','missing');assert.equal(wsl.status,1);assert.match(wsl.stderr,/WSL Integration/);assert(!wsl.calls.includes('curl'));
  const mac=run('Darwin','missing');assert.equal(mac.status,0,mac.stderr);assert.match(mac.calls,/curl\nhdiutil\ncodesign\nspctl\nsudo\nhdiutil\nopen/);
  const bad=run('Darwin','missing',{BAD_HASH:'1'});assert.equal(bad.status,1);assert.match(bad.stderr,/checksum mismatch/);assert(!bad.calls.includes('sudo'));
  console.log('Bootstrap engine reuse, WSL remediation, Intel installer verification and checksum rejection tested with isolated command doubles.');
} finally {rmSync(root,{recursive:true,force:true});}
