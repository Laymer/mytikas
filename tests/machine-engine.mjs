import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Machine } from '../scripts/machine/core.mjs';
import { inspectZip, fileDigest } from '../scripts/machine/archive.mjs';
const root=fs.mkdtempSync(join(tmpdir(),'mytikas-engine-test-'));
const c={POSTGRES_PASSWORD:'a'.repeat(64),RUNTIME_DATABASE_PASSWORD:'b'.repeat(64),SESSION_SECRET:'c'.repeat(96),PUBLIC_UID:'501',PUBLIC_GID:'20',DISCORD_WEBHOOK_URL:'',tunnelToken:'d'.repeat(100)};
const images={app:'sha256:'+'a'.repeat(64),db:'sha256:'+'b'.repeat(64),tunnel:'sha256:'+'c'.repeat(64)};
const sha='a'.repeat(40),d={root:join(root,'checkout'),project:'mytikas-public',compose:join(root,'checkout/compose.public.yaml'),env:join(root,'checkout/.env.public'),token:join(root,'checkout/.public/tunnel-token')};
fs.mkdirSync(join(d.root,'.public'),{recursive:true,mode:0o700});fs.writeFileSync(d.env,Object.entries(c).filter(([k])=>k!=='tunnelToken').map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});fs.writeFileSync(d.token,c.tunnelToken,{mode:0o600});fs.writeFileSync(d.compose,'{}');
const migrations={'001_test.sql':null};const sqlText='SELECT 1;';fs.writeFileSync(join(root,'migration'),sqlText);migrations['001_test.sql']=fileDigest(join(root,'migration')).sha256;
class Engine extends Machine {
  constructor(home){super(home,d.root);this.calls=[];this.save({context:'fixture'});}
  docker(args,options={}) {
    this.calls.push(args);
    if(args[0]==='info')return JSON.stringify({OSType:'linux',Architecture:'amd64'});
    if(args[0]==='run')return '9999999999';
    if(args[0]==='volume'&&args[1]==='inspect') {
      if(this.missingVolume)throw new Error('Previous volume absent');
      return JSON.stringify([{Name:args[2]}]);
    }
    if(args[0]==='image'&&args[1]==='inspect')return JSON.stringify([{Os:'linux',Architecture:'amd64',Size:10}]);
    if(args[0]==='image'&&args[1]==='save'){fs.writeFileSync(args[3],'saved-image-fixture');return '';}
    if(args[0]==='create')return 'f'.repeat(64);
    if(args[0]==='cp'&&args[1].endsWith(':/app/migrations')){fs.mkdirSync(join(args[2],'migrations'));fs.writeFileSync(join(args[2],'migrations/001_test.sql'),sqlText);return '';}
    if(args[0]==='inspect') {
      const s={'a':'app','b':'worker','c':'db','d':'tunnel'}[args[1][0]];
      return JSON.stringify([{Image:images[s==='worker'?'app':s],State:{Running:!this.stopped,ExitCode:this.badExit||0,OOMKilled:false},Config:{Labels:{'com.docker.compose.project':d.project},Env:s==='db'?[`POSTGRES_PASSWORD=${c.POSTGRES_PASSWORD}`]:[`DEPLOYMENT_PROFILE=public`,`APP_ORIGIN=https://app.mytikas.monster`,`SESSION_SECRET=${c.SESSION_SECRET}`,'DISCORD_WEBHOOK_URL=',`DATABASE_URL=postgres://mytikas_runtime:${c.RUNTIME_DATABASE_PASSWORD}@db:5432/mytikas_public`]}}]);
    }
    if(args[0]==='compose') {
      const command=args[7],tail=args.slice(8);
      if(command==='config'&&tail.includes('json'))return JSON.stringify({services:{db:{volumes:[{type:'volume',source:'data',target:'/var/lib/postgresql'}]}},volumes:{data:{name:'previous-data'}}});
      if(command==='ps'&&tail.at(-1)==='db'&&this.dbRemoved)return '';
      if(command==='ps')return ({app:'a',worker:'b',db:'c',tunnel:'d'}[tail.at(-1)]||'a').repeat(64);
      if(command==='up'&&tail.includes('tunnel')&&this.failTunnel)throw new Error('Recovery tunnel failed');
      if(command==='stop'&&tail.includes('app'))this.stopped=true;
      if(command==='exec'&&tail.includes('pg_dump'))fs.writeSync(options.stdio[1],'PGDMP-fixture');
      if(command==='exec'&&tail.includes('psql')) {
        const query=tail.at(-1);
        if(query.includes('pg_database_size'))return '100';
        if(query.includes('json_object_agg'))return JSON.stringify(migrations);
        if(query.includes('pg_tables'))return '["users","sessions"]';
        if(query.includes('pg_sequences'))return '[]';
        if(query.includes('count(*)'))return '1:abc';
      }
      return '';
    }
    return '';
  }
  run(binary,args,options) {
    if(binary==='git')return sha;
    if(binary==='docker'&&args.includes('context'))return args.includes('inspect')?'[{"Endpoints":{"docker":{"Host":"unix:///fixture"}}}]':'fixture';
    if(binary==='curl'){fs.writeFileSync(args[args.indexOf('--output')+1],'tar-fixture');return '';}
    if(binary==='tar') {const target=args.at(-1);fs.mkdirSync(join(target,'scripts'));fs.mkdirSync(join(target,'migrations'));fs.writeFileSync(join(target,'migrations/001_test.sql'),sqlText);for(const n of ['runtime-grants.sql','public-runtime-role.sql'])fs.writeFileSync(join(target,'scripts',n),'SELECT 1;');return '';}
    return super.run(binary,args,options);
  }
}
const savedFetch=globalThis.fetch;
try {
  globalThis.fetch=async()=>({ok:true,json:async()=>({ready:true}),headers:{get:()=> 's=x; Secure; HttpOnly; SameSite=Lax'}});
  const machine=new Engine(join(root,'machine'));await machine.prepare();assert.equal(machine.config(d).SESSION_SECRET,c.SESSION_SECRET);
  assert.equal(machine.run(process.execPath,['-e','process.stdout.write("ok")']),'ok');assert.throws(()=>machine.run(process.execPath,['-e','process.exit(1)']),/failed/);
  await machine.publicCheck();await machine.migrate();assert.equal(machine.state.phase,'handed-off');
  const manifest=inspectZip(machine.state.export.target).manifest;assert.equal(manifest.commit,sha);assert.deepEqual(manifest.images,images);assert.equal(manifest.generation,1);
  assert(fs.existsSync(join(d.root,'.public/machine-handoff.json')));
  assert(machine.calls.some(a=>a.includes('pg_restore')&&a.includes('--single-transaction')));
  assert(machine.calls.some(a=>a.includes('down')&&!a.includes('--volumes')));
  await assert.rejects(()=>machine.migrate(),/handed off/);await assert.rejects(()=>machine.recover('source'),/before/);
  machine.save({phase:'export-stopped'});await machine.recover('source');assert.equal(machine.state.phase,'active');assert(!fs.existsSync(join(d.root,'.public/machine-handoff.json')));
  const before=machine.state.active;machine.save({phase:'import-verified',previous:before,transfer:{next:before,writers:false}});
  fs.writeFileSync(join(before.root,'.public/machine-handoff.json'),'{}');
  await machine.recover('previous');assert.equal(machine.state.phase,'active');
  assert(!fs.existsSync(join(before.root,'.public/machine-handoff.json')),'Successful previous recovery must release the checkout startup guard');
  const failedRecovery=new Engine(join(root,'failed-recovery'));failedRecovery.save({phase:'import-verified',previous:before,transfer:{next:before,writers:false}});failedRecovery.failTunnel=true;
  fs.writeFileSync(join(before.root,'.public/machine-handoff.json'),'{}');
  await assert.rejects(()=>failedRecovery.recover('previous'),/Recovery tunnel failed/);
  assert(fs.existsSync(join(before.root,'.public/machine-handoff.json')),'Failed activation must retain the startup guard');
  failedRecovery.failTunnel=false;await failedRecovery.recover('previous');
  assert(!fs.existsSync(join(before.root,'.public/machine-handoff.json')));
  machine.save({phase:'import-writers',transfer:{next:before,writers:true}});await machine.failureStop();assert(machine.calls.at(-1).includes('stop'));
  globalThis.fetch=async()=>({ok:false});await assert.rejects(()=>machine.publicCheck(),/HTTPS/);
  globalThis.fetch=async()=>({ok:true,json:async()=>({ready:true}),headers:{get:()=>null}});await assert.rejects(()=>machine.publicCheck(),/cookie/);
  const broken=new Engine(join(root,'broken'));broken.badExit=1;globalThis.fetch=async()=>({ok:true});await assert.rejects(()=>broken.migrate(),/drain/);assert.equal(broken.state.phase,'export-stopping');
  assert(!broken.calls.some(a=>a.includes('pg_dump')));
  const noSpace=new Engine(join(root,'no-space'));assert.throws(()=>noSpace.space(root,Number.MAX_SAFE_INTEGER),/free disk/);
  const unsafe=new Engine(join(root,'unsafe'));unsafe.run=()=> '[{"Endpoints":{"docker":{"Host":"tcp://remote:2375"}}}]';await assert.rejects(()=>unsafe.prepare(),/local Docker/);
  for(const dbRemoved of [false,true]) {
    const stopped=new Engine(join(root,dbRemoved?'previous-down':'previous-stopped'));stopped.stopped=true;stopped.dbRemoved=dbRemoved;
    stopped.backupPrevious(d,join(stopped.home,'safety.dump'));
    const inspected=stopped.calls.findIndex(a=>a[0]==='volume'&&a[1]==='inspect');
    const up=stopped.calls.findIndex(a=>a.includes('up'));
    const dump=stopped.calls.findIndex(a=>a.includes('pg_dump'));
    assert(inspected>=0&&up>inspected&&dump>up);
    assert.deepEqual(stopped.calls[up].slice(7),['up','-d','--no-deps','--no-recreate','--wait','--wait-timeout','180','db']);
    assert(!stopped.calls.some(a=>a.includes('up')&&(a.includes('app')||a.includes('worker')||a.includes('tunnel'))));
  }
  const running=new Engine(join(root,'previous-running'));running.backupPrevious(d,join(running.home,'safety.dump'));
  assert(!running.calls.some(a=>a.includes('up')),'A running previous database must not be recreated');
  const missing=new Engine(join(root,'previous-missing'));missing.dbRemoved=true;missing.missingVolume=true;
  assert.throws(()=>missing.backupPrevious(d,join(missing.home,'safety.dump')),/volume is unavailable/);
  assert(!missing.calls.some(a=>a.includes('up')||a.includes('pg_dump')),'A missing previous volume must never be initialized');
  // Run the real CLI status/help/error paths in a private HOME, never the developer's machine state.
  for(const [args,status] of [[['status'],0],[['help'],0],[['wrong'],1],[['import'],1]]) {
    const r=spawnSync(process.execPath,[resolve('scripts/machine/core.mjs'),...args],{env:{...process.env,HOME:root},encoding:'utf8'});assert.equal(r.status,status,r.stderr);
  }
  console.log('Machine engine orchestration: preflight, graceful export, isolated validation, source recovery, previous recovery and command redaction passed.');
} finally {globalThis.fetch=savedFetch;fs.rmSync(root,{recursive:true,force:true});}
