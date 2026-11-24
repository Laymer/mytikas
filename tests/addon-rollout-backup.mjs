// Rehearse against disposable PostgreSQL containers on the current local Docker engine.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Machine } from '../scripts/machine/core.mjs';
import { backupForRollout } from '../scripts/addon-rollout-backup.mjs';

const home=fs.mkdtempSync(join(tmpdir(),'mytikas-rollout-test-'));
const machine=new Machine(home,home);
const d={root:home,project:'mytikas-rollout-test-'+randomUUID(),compose:join(home,'compose.json'),env:join(home,'.env.public'),token:join(home,'tunnel-token')};
const write=(file,value)=>fs.writeFileSync(file,value,{mode:0o600});
const image='postgres:18-bookworm';
const database=(name,vol)=>({image,network_mode:'none',volumes:[vol+':/var/lib/postgresql'],
  environment:{POSTGRES_USER:name,POSTGRES_DB:name,POSTGRES_HOST_AUTH_METHOD:'trust'},
  healthcheck:{test:['CMD','pg_isready','-h','127.0.0.1','-U',name],interval:'1s',timeout:'3s',retries:120}});
const dormant={image,network_mode:'none',entrypoint:['sleep','3600']};
const path=join(home,'backups');
fs.mkdirSync(path,{mode:0o700});
fs.mkdirSync(join(home,'.public'),{mode:0o700});
write(d.compose,JSON.stringify({services:{db:database('mytikas_public','data'),app:dormant,worker:dormant,tunnel:dormant},volumes:{data:{}}}));
write(d.env,'');write(d.token,'fixture-token');
try {
  await machine.prepare();
  machine.dc(d,['up','-d','--wait','--pull','never']);
  machine.dc(d,['stop','app','worker','tunnel']);
  machine.sql(d,"CREATE TABLE fixture(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, data bytea); INSERT INTO fixture(data) VALUES(decode('00ff','hex'));");
  for (const pair of [false,true]) {
    if(pair) {
      write(machine.addonOverlay(d),JSON.stringify({services:{'archive-db':database('mytikas_archive','archive')},volumes:{archive:{}}}));
      machine.dc(d,['up','-d','--wait','--no-deps','--pull','never','archive-db']);
      machine.sql(d,"CREATE TABLE releases(id bigint GENERATED ALWAYS AS IDENTITY, archive bytea); INSERT INTO releases(archive) VALUES(decode('504b0304','hex'));",true);
    }
    const dir=fs.mkdtempSync(join(path,'fixture-'));
    const m=await backupForRollout(machine,d,dir);
    assert.equal(m.databases.length,pair?2:1);
    assert.equal(fs.existsSync(join(dir,'archive.dump')),pair);
    assert.equal(m.files['database.dump'].sha256.length,64);
    for(const name of fs.readdirSync(dir))assert.equal(fs.statSync(join(dir,name)).mode & 0o777,0o600);
    assert.equal(machine.sql(d,'SELECT count(*) FROM fixture'),'1');
  }
  const original=machine.fingerprint.bind(machine);
  machine.fingerprint=(dep,archive)=>dep.project===d.project?original(dep,archive):'a'.repeat(64);
  const dir=fs.mkdtempSync(join(path,'mismatch-'));
  await assert.rejects(backupForRollout(machine,d,dir),/rows or sequences differ/);
  assert.equal(fs.existsSync(join(dir,'manifest.json')),false);
  assert.equal(machine.sql(d,'SELECT count(*) FROM fixture'),'1');
  assert.equal(machine.sql(d,'SELECT count(*) FROM releases',true),'1');
  console.log('Single and paired rollout dumps restored and verified. Fingerprint failure preserved the original volumes.');
} finally {
  try {machine.dc(d,['down','--volumes']);} finally {fs.rmSync(home,{recursive:true,force:true});}
}
