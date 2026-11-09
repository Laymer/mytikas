import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const directory = mkdtempSync(join(tmpdir(), 'mytikas-public-smoke-'));
const project = `mytikas-public-smoke-${randomBytes(5).toString('hex')}`;
const envfile=join(directory,'env');
writeFileSync(envfile,`POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\nRUNTIME_DATABASE_PASSWORD=${randomBytes(32).toString('hex')}\nSESSION_SECRET=${randomBytes(48).toString('hex')}\nEMAIL_OUTBOX_KEY=${randomBytes(32).toString('hex')}\nSMTP_HOST=smtp.invalid\nEMAIL_FROM=guild@example.test\nPUBLIC_UID=${process.getuid()}\nPUBLIC_GID=${process.getgid()}\n`,{mode:0o600});
const env={...process.env};
for(const key of Object.keys(env))if(/^(POSTGRES_|RUNTIME_DATABASE_|SESSION_|EMAIL_|SMTP_|PUBLIC_|DISCORD_|COMPOSE_)/.test(key))delete env[key];
const override=join(directory,'compose.yaml');
writeFileSync(override,`services:\n  app:\n    image: ${project}:test\n  worker:\n    image: ${project}:test\n  migrate:\n    image: ${project}:test\n`);
const base=['compose','-p',project,'--env-file',envfile,'-f',resolve('compose.public.yaml'),'-f',override];
function dc(args, capture=false){
 const r=spawnSync('docker',[...base,...args],{env,encoding:'utf8',stdio:capture?'pipe':'inherit'});
 if(r.status!==0)throw new Error(`Public container smoke failed: ${args[0]}`);
 return r.stdout;
}
try{
 dc(['build','app']);
 dc(['up','-d','--no-build','--wait','--wait-timeout','180','app','worker']);
 dc(['exec','-T','app','node','-e',"fetch('http://127.0.0.1:8080/api/health').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())})"]);
 dc(['exec','-T','worker','node','dist/worker-health.js']);
 const expectedImage=spawnSync('docker',['image','inspect','--format','{{.Id}}',`${project}:test`],{encoding:'utf8'});
 assert.equal(expectedImage.status,0);
 for(const service of ['app','worker','migrate']){
  const id=dc(['ps','-a','-q',service],true).trim();
  assert(id);
  const actual=spawnSync('docker',['inspect','--format','{{.Image}}',id],{encoding:'utf8'});
  assert.equal(actual.status,0);
  assert.equal(actual.stdout.trim(),expectedImage.stdout.trim(),'Every process must run the exact image archived for publication');
 }

 for(const service of ['app','worker'])dc(['exec','-T',service,'node','--input-type=module','-e',`
  import assert from 'node:assert/strict';
  import {createPool} from './dist/db.js';
  const pool=createPool(process.env.DATABASE_URL);
  try{
   const role=(await pool.query('SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
   assert.deepEqual(role,{name:'mytikas_runtime',rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false});
   for(const sql of ['CREATE TABLE forbidden(id int)','UPDATE migrations SET checksum=checksum','DELETE FROM events'])
    await assert.rejects(pool.query(sql),e=>e.code==='42501');
  }finally{await pool.end();}
 `]);
 const containers=dc(['ps','--format','json'],true).trim().split('\n').filter(Boolean).map(JSON.parse);
 for(const c of containers) assert(!c.Publishers?.some(p=>p.PublishedPort>0));
 dc(['exec','-T','db','psql','-U','mytikas_public','-d','mytikas_public','-c',"CREATE TABLE smoke_marker(value text); INSERT INTO smoke_marker VALUES ('persistent');"],true);
 // Provisioning is repeatable and must not silently rotate the existing role password.
 dc(['exec','-T','db','psql','-U','mytikas_public','-d','mytikas_public','-c','ALTER ROLE mytikas_runtime REPLICATION'],true);
 try{assert.throws(()=>dc(['run','--rm','--no-deps','runtime-grants'],true),/smoke failed/);}
 finally{dc(['exec','-T','db','psql','-U','mytikas_public','-d','mytikas_public','-c','ALTER ROLE mytikas_runtime NOREPLICATION'],true);}
 const fingerprint=dc(['exec','-T','db','psql','-U','mytikas_public','-d','mytikas_public','-tAc',"SELECT md5(rolpassword) FROM pg_authid WHERE rolname='mytikas_runtime'"],true).trim();
 const originalEnvironment=readFileSync(envfile,'utf8');
 try{
  writeFileSync(envfile,originalEnvironment.replace(/^RUNTIME_DATABASE_PASSWORD=.*$/m,'RUNTIME_DATABASE_PASSWORD='+randomBytes(32).toString('hex')));
  dc(['run','--rm','--no-deps','runtime-grants'],true);
  dc(['run','--rm','--no-deps','app','node','--input-type=module','-e',`
   import assert from 'node:assert/strict';import {createPool} from './dist/db.js';
   const pool=createPool(process.env.DATABASE_URL);
   try{await assert.rejects(pool.query('SELECT 1'),e=>e.code==='28P01');}finally{await pool.end();}
  `],true);
  writeFileSync(envfile,originalEnvironment.replace(/^RUNTIME_DATABASE_PASSWORD=.*$/m,'RUNTIME_DATABASE_PASSWORD=invalid-fixture'));
  assert.throws(()=>dc(['run','--rm','--no-deps','runtime-grants'],true),/smoke failed/);
 }finally{writeFileSync(envfile,originalEnvironment);}
 assert.equal(dc(['exec','-T','db','psql','-U','mytikas_public','-d','mytikas_public','-tAc',"SELECT md5(rolpassword) FROM pg_authid WHERE rolname='mytikas_runtime'"],true).trim(),fingerprint);
 dc(['up','-d','--force-recreate','--wait','--wait-timeout','180','app','worker']);
 const marker=dc(['exec','-T','db','psql','-U','mytikas_public','-d','mytikas_public','-tAc','SELECT value FROM smoke_marker'],true).trim();
 assert.equal(marker,'persistent');
 dc(['exec','-T','worker','node','dist/worker-health.js']);
 const logs=dc(['logs','--no-color','db','runtime-grants'],true);
 for(const match of readFileSync(envfile,'utf8').matchAll(/^(?:POSTGRES_PASSWORD|RUNTIME_DATABASE_PASSWORD|SESSION_SECRET)=(.+)$/gm))
  assert(!logs.includes(match[1]),'Database provisioning logs must not contain configured secrets');
 if(process.env.IMAGE_ARCHIVE){
  for(const args of [['tag',`${project}:test`,'mytikas-tested:latest'],['save','-o',resolve(process.env.IMAGE_ARCHIVE),'mytikas-tested:latest']]){
   assert.equal(spawnSync('docker',args,{stdio:'inherit'}).status,0);
  }
 }
 console.log('Public Compose non-owner runtime privileges, secret-preserving grants, readiness, no published ports, and recreated-container persistence passed. Tunnel intentionally excluded.');
}finally{
 try{dc(['down','--volumes','--remove-orphans']);}finally{rmSync(directory,{recursive:true,force:true});}
}
