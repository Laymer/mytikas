import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileDigest, writeZip, inspectZip, extractZip } from '../scripts/machine/archive.mjs';
import { configuration, validateConfiguration, validateTransfer, Machine } from '../scripts/machine/core.mjs';
const root=fs.mkdtempSync(join(tmpdir(),'mytikas-machine-test-'));
const c={POSTGRES_PASSWORD:'a'.repeat(64),RUNTIME_DATABASE_PASSWORD:'b'.repeat(64),SESSION_SECRET:'c'.repeat(96),PUBLIC_UID:'1000',PUBLIC_GID:'1000',DISCORD_WEBHOOK_URL:'',tunnelToken:'d'.repeat(100)};
const images={app:'sha256:'+'a'.repeat(64),db:'sha256:'+'b'.repeat(64),tunnel:'sha256:'+'c'.repeat(64)};
fs.writeFileSync(join(root,'migration'),'fixture');
const migrations={'001_initial.sql':fileDigest(join(root,'migration')).sha256};
const manifest={format:1,id:'1'.repeat(32),lineage:'2'.repeat(32),generation:1,commit:'3'.repeat(40),platform:'linux/amd64',images,migrations,fingerprint:'e'.repeat(64),files:{}};
function archive(id='1',generation=1,change=()=>{}) {
  const dir=join(root,`archive-${id}-${generation}`);fs.mkdirSync(dir);
  fs.writeFileSync(join(dir,'database.dump'),'PGDMP-fixture');fs.writeFileSync(join(dir,'images.tar'),'fixture-images');fs.writeFileSync(join(dir,'configuration.json'),JSON.stringify(c));
  const m=structuredClone(manifest);m.id=id.repeat(32);m.generation=generation;
  for(const name of ['database.dump','images.tar','configuration.json']){const f=fileDigest(join(dir,name));m.files[name]={sha256:f.sha256,size:f.size};}
  change(m);fs.writeFileSync(join(dir,'manifest.json'),JSON.stringify(m));const zip=dir+'.zip';writeZip(dir,zip);return zip;
}
class Fake extends Machine {
  constructor(home){super(home,root);this.calls=[];this.restoreCount=0;this.failWorker=false;}
  space(){} engineSpace(){}
  async source(_commit,dir){fs.mkdirSync(join(dir,'migrations'),{recursive:true});fs.writeFileSync(join(dir,'migrations/001_initial.sql'),'fixture');}
  docker(args){this.calls.push(args);if(args[0]==='image'&&args[1]==='inspect')return JSON.stringify([{Id:args[2],Os:'linux',Architecture:'amd64'}]);return '';}
  imageMigrations(){return migrations;}
  dc(d,args){this.calls.push([d.project,...args]);if(this.failWorker&&args[0]==='up'&&args.includes('worker'))throw new Error('worker failure');return '';}
  async restore(){this.restoreCount++;}
  fingerprint(){return manifest.fingerprint;}
  migrations(){return migrations;}
  async publicCheck(){}
}
try {
  const zip=archive();const info=inspectZip(zip);validateTransfer(info);
  assert.equal(fs.statSync(zip).mode&0o777,0o600);
  const extracted=join(root,'extract');fs.mkdirSync(extracted);extractZip(zip,extracted);
  assert.equal(fs.readFileSync(join(extracted,'database.dump'),'utf8'),'PGDMP-fixture');
  const text=Object.entries(c).filter(([k])=>k!=='tunnelToken').map(([k,v])=>`${k}=${v}`).join('\n');assert.deepEqual(configuration(text,c.tunnelToken),c);
  for(const bad of [text+'\nSESSION_SECRET=x',text+'\nCF_API_TOKEN=secret',text.replace('a'.repeat(64),'$(touch /tmp/no)'),text.replace('PUBLIC_UID=1000','PUBLIC_UID=-1')])assert.throws(()=>configuration(bad,c.tunnelToken));
  assert.throws(()=>validateConfiguration({...c,tunnelToken:'bad\ntoken'}));
  for(const mutate of [m=>m.platform='linux/arm64',m=>m.files['database.dump'].sha256='0'.repeat(64),m=>m.commit='https://evil.test',m=>m.generation=-1,m=>m.images.app='latest',m=>m.migrations={'../x.sql':'a'.repeat(64)}]){
    const bad=structuredClone(info);mutate(bad.manifest);assert.throws(()=>validateTransfer(bad));
  }
  // Alter directory and local headers to exercise path, symlink, duplicate, compression and overlap rejection.
  const bytes=fs.readFileSync(zip),central=bytes.readUInt32LE(bytes.length-6);
  const corrupt=(name,fn)=>{const b=Buffer.from(bytes);fn(b);const p=join(root,name+'.zip');fs.writeFileSync(p,b);assert.throws(()=>inspectZip(p),name);};
  corrupt('traversal',b=>{b.write('../evil.dump',30);b.write('../evil.dump',central+46);});
  corrupt('symlink',b=>b.writeUInt32LE((0o120777<<16)>>>0,central+38));
  corrupt('compressed',b=>b.writeUInt16LE(8,central+10));
  corrupt('overlap',b=>b.writeUInt32LE(1,central+42));
  corrupt('payload',b=>b[43]^=1);
  corrupt('duplicate',b=>{let at=central;for(let i=0;i<3;i++)at+=46+b.readUInt16LE(at+28);b.write('images.tar',at+46);});
  corrupt('directory',b=>b.writeUInt32LE(0xffffffff,b.length-6));
  const a=new Fake(join(root,'a'));await a.import(zip);assert.equal(a.state.phase,'active');assert.equal(a.restoreCount,1);
  const config=JSON.parse(fs.readFileSync(a.state.active.compose));assert.equal(config.services.app.environment.SESSION_SECRET,c.SESSION_SECRET);assert.equal(config.services.tunnel.user,`${process.getuid()}:${process.getgid()}`);assert(!config.services.app.ports);
  const worker=a.calls.findIndex(v=>v.includes('up')&&v.includes('worker')),tunnel=a.calls.findIndex(v=>v.includes('up')&&v.includes('tunnel'));
  assert(worker>0&&tunnel>worker);await a.import(zip);assert.equal(a.restoreCount,1);
  a.save({phase:'handed-off',highest:2});await assert.rejects(()=>a.import(zip),/Stale/);
  const next=archive('4',3);await a.import(next);assert.equal(a.state.phase,'active');assert.equal(a.state.highest,3);
  const b=new Fake(join(root,'b'));b.failWorker=true;await assert.rejects(()=>b.import(zip),/worker failure/);assert.equal(b.state.phase,'import-writers');assert.equal(b.state.transfer.writers,true);
  await assert.rejects(()=>b.recover('previous'),/forbidden/);b.failWorker=false;b.space=()=>{throw new Error('No room for another extraction');};await b.import(zip);assert.equal(b.restoreCount,1);assert.equal(b.state.phase,'active');
  const d=new Fake(join(root,'d'));d.fingerprint=()=> '0'.repeat(64);await assert.rejects(()=>d.import(zip),/fingerprint/);assert.equal(d.state.transfer.writers,false);assert(!d.calls.some(v=>v.includes('up')&&v.includes('worker')));
  d.fingerprint=()=>manifest.fingerprint;await d.import(zip);assert.equal(d.restoreCount,2);
  const stopped=new Fake(join(root,'stopped'));stopped.id=(_d,s)=>s;stopped.inspect=()=>({State:{Running:false,OOMKilled:false,ExitCode:137}});await assert.rejects(()=>stopped.stop({project:'fixture'}),/did not drain/);
  assert(stopped.calls[0].includes('tunnel'));assert(stopped.calls[1].includes('worker'));
  // Existing public helpers must neither build nor revive a handed-off checkout.
  const helperHome=join(root,'helper-home');fs.mkdirSync(join(helperHome,'.mytikas'),{recursive:true});fs.writeFileSync(join(helperHome,'.mytikas/machine.json'),JSON.stringify({phase:'handed-off'}));
  const result=spawnSync(process.execPath,['scripts/public.mjs','up'],{encoding:'utf8',env:{...process.env,HOME:helperHome}});assert.equal(result.status,1);assert.match(result.stderr,/handed off/);
  assert.equal(spawnSync('bash',['-n','mytikas-machine.sh']).status,0);
  const standalone=spawnSync('bash',['mytikas-machine.sh','status'],{encoding:'utf8',env:{...process.env,HOME:join(root,'standalone-home')}});
  assert.equal(standalone.status,0,standalone.stderr);assert.equal(JSON.parse(standalone.stdout).phase,'idle');
  assert.equal(spawnSync(process.execPath,['scripts/build-machine.mjs','--check']).status,0);
  console.log('Machine archive validation, credential preservation, staging, resume, stale transfer and write-barrier tests passed.');
} finally {fs.rmSync(root,{recursive:true,force:true});}
