import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const oldImage='ghcr.io/laymer/mytikas@sha256:5c4e8aafcd24f1efeb2588b11e7ba3ce9b9cd0de19e3d292a3ebdf9bc6bd91ac';
const newImage=process.env.REHEARSAL_IMAGE || 'mytikas-tested:latest';
if(!/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]+$/.test(newImage))throw new Error('Invalid rehearsal image reference.');
const directory=mkdtempSync(join(tmpdir(),'mytikas-cloud-rehearsal-'));
const suffix=randomBytes(5).toString('hex');
const dbProject=`mytikas-rehearsal-db-${suffix}`;
const appProject=`mytikas-rehearsal-app-${suffix}`;
const network=`mytikas-rehearsal-${suffix}`;
const secret=()=>randomBytes(32).toString('hex');
const ownerPassword=secret(), runtimePassword=secret(), sessionSecret=secret();
const envFile=join(directory,'environment');
const dbFile=join(directory,'database.yaml');
const override=join(directory,'cloud-network.yaml');
const env={...process.env};
for(const key of Object.keys(env))if(/^(EMAIL_|SMTP_|DATABASE_|MIGRATION_|SESSION_|APP_ORIGIN$|PUBLIC_|DISCORD_|MYTIKAS_|DEPLOYMENT_|INGRESS_|COMPOSE_|POSTGRES_|DB_ADMIN_)/.test(key))delete env[key];
const dbArgs=['compose','-p',dbProject,'--env-file',envFile,'-f',dbFile];
const appArgs=['compose','-p',appProject,'--env-file',envFile,'-f',resolve('compose.cloud.yaml'),'-f',override];
let dbStarted=false, appStarted=false;
const adminPassword=secret();
function environment(image){
 writeFileSync(envFile,`DB_ADMIN_PASSWORD=${adminPassword}\nMYTIKAS_IMAGE=${image}\nDATABASE_URL=postgres://mytikas_runtime:${runtimePassword}@db:5432/mytikas\nMIGRATION_DATABASE_URL=postgres://mytikas_owner:${ownerPassword}@db:5432/mytikas\nSESSION_SECRET=${sessionSecret}\nDATABASE_CA_HOST_FILE=${join(directory,'ca.pem')}\nAPP_ORIGIN=https://app.mytikas.monster\nPUBLIC_SITE_ORIGIN=https://mytikas.monster\nEMAIL_OUTBOX_KEY=${'12'.repeat(32)}\nSMTP_HOST=smtp.invalid\nEMAIL_FROM=guild@example.test\nDISCORD_WEBHOOK_URL=\n`,{mode:0o600});
}
function command(binary,args,{input,timeout=180000,label=binary}={}){
 const result=spawnSync(binary,args,{cwd:directory,env,input,encoding:'utf8',timeout,maxBuffer:8*1024*1024});
 if(result.error || result.status!==0)throw new Error(`${label} failed (details suppressed to protect fixture secrets).`);
 return result.stdout;
}
const db=(args,options)=>command('docker',[...dbArgs,...args],options);
const app=(args,options)=>command('docker',[...appArgs,...args],options);
function ssl(args){command('openssl',args,{timeout:15000,label:'Ephemeral certificate generation'});}
function ensureImage(image){
 const inspected=spawnSync('docker',['image','inspect',image],{env,stdio:'pipe',timeout:15000});
 if(inspected.status!==0)command('docker',['pull',image],{timeout:300000,label:'Rehearsal image pull'});
 return command('docker',['image','inspect',image,'--format','{{.Id}}'],{label:'Image identity inspection'}).trim();
}
function psql(sql){return db(['exec','-T','db','psql','-X','-v','ON_ERROR_STOP=1','-U','rehearsal_admin','-d','mytikas','-f','-'],{input:sql,label:'Private database setup'});}
function verifyPorts(args){
 const rows=command('docker',[...args,'ps','--format','json'],{label:'Port isolation inspection'}).trim().split('\n').filter(Boolean).map(JSON.parse);
 for(const row of rows)assert(!row.Publishers?.some(p=>p.PublishedPort>0),'Rehearsal must not publish host ports');
}
const clientScript=String.raw`
import assert from 'node:assert/strict';
import {createPool} from './dist/db.js';
let cookie=fixture.previous?.cookie || '',csrf='';
async function request(path,body){
 const response=await fetch('http://127.0.0.1:8080'+path,{method:body===undefined?'GET':'POST',headers:{'X-Forwarded-Proto':'https',Origin:'https://app.mytikas.monster',Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf})},body:body===undefined?undefined:JSON.stringify(body)});
 const setCookie=response.headers.get('set-cookie');
 if(setCookie){assert.match(setCookie,/; Secure/);assert.match(setCookie,/; HttpOnly/);assert.match(setCookie,/; SameSite=Lax/);cookie=setCookie.split(';')[0];}
 const value=await response.json();assert(response.ok,'Fixture API request failed');if(value.csrfToken)csrf=value.csrfToken;return value;
}
let user=(await request('/api/auth/me')).user;
if(!fixture.previous){
 const rules=await request('/api/rules');
 const registration=await request('/api/auth/register',{email:'cloud.rehearsal@example.test',password:fixture.password,characterName:'Cloud Rehearsal',motivation:'Isolated published image portability test.',rulesId:rules.id,acceptRules:true});
 if(registration.pendingEmail) {
 const capture=createPool(process.env.DATABASE_URL);
 try {
  const {unseal}=await import('./dist/email.js');
  const job=(await capture.query("SELECT j.payload FROM email_jobs j JOIN users u ON u.id=j.user_id WHERE u.email='cloud.rehearsal@example.test' AND j.token_id IS NOT NULL ORDER BY j.created_at DESC LIMIT 1")).rows[0];
  const token=unseal(job.payload,process.env.EMAIL_OUTBOX_KEY).text.split('#verify=')[1].slice(0,64);
  await request('/api/auth/verify-email',{token});
  user=(await request('/api/auth/login',{email:'cloud.rehearsal@example.test',password:fixture.password})).user;
 }finally{await capture.end();}
 }else user=registration.user;
}else assert.deepEqual(user,fixture.previous.user,'Existing session must survive image replacement');
const detail=await request('/api/application');
assert.equal(detail.application.status,'SUBMITTED');assert.equal(detail.submissions.length,1);assert.ok(detail.events.length>=1);
if(fixture.previous){
 for(const [key,value] of Object.entries(fixture.previous.detail.application))assert.deepEqual(detail.application[key],value,'Existing application fields survive upgrade');
 assert.deepEqual(detail.submissions,fixture.previous.detail.submissions);assert.deepEqual(detail.events,fixture.previous.detail.events);
}
const originalCookie=cookie;
// A separate session validates password authentication without invalidating the original session.
cookie='';await request('/api/auth/me');
assert.deepEqual((await request('/api/auth/login',{email:'cloud.rehearsal@example.test',password:fixture.password})).user,user);
const pool=createPool(process.env.DATABASE_URL);
let migrations;
try{
 assert.equal((await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl,true);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tableowner=current_user")).rows[0].n,0);
 await assert.rejects(pool.query('CREATE TABLE forbidden_rehearsal(id integer)'),e=>e.code==='42501');
 migrations=(await pool.query('SELECT name,checksum FROM migrations ORDER BY name')).rows;
 if(fixture.previous)for(const migration of fixture.previous.migrations)assert.ok(migrations.some(m=>m.name===migration.name&&m.checksum===migration.checksum),'Applied migration checksums remain unchanged');
 if(migrations.some(m=>m.name==='004_activation_rosters.sql')){const u=(await pool.query('SELECT activation_exempt,email_verified_at FROM users WHERE id=$1',[user.id])).rows[0];assert.equal(u.activation_exempt,true);assert.equal(u.email_verified_at,null);}
}finally{await pool.end();}
console.log(JSON.stringify({cookie:originalCookie,user,detail,migrations}));
`;
function account(previous,password){
 const source=`const fixture=${JSON.stringify({previous,password})};\n${clientScript}`;
 return JSON.parse(app(['exec','-T','app','node','--input-type=module','-'],{input:source,label:'Private account/session/history/TLS verification'}));
}
try{
 environment(oldImage);
 const oldId=ensureImage(oldImage),newId=ensureImage(newImage);
 ssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Mytikas rehearsal CA','-addext','basicConstraints=critical,CA:TRUE']);
 ssl(['req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=db']);
 writeFileSync(join(directory,'server.ext'),'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:db\n');
 ssl(['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','server.pem','-days','1','-extfile','server.ext']);
 chmodSync(join(directory,'server.key'),0o600);chmodSync(join(directory,'ca.key'),0o600);chmodSync(join(directory,'ca.pem'),0o644);
 writeFileSync(dbFile,`services:
  db:
    image: postgres:18-bookworm
    environment:
      POSTGRES_USER: rehearsal_admin
      POSTGRES_DB: mytikas
      POSTGRES_PASSWORD: \${DB_ADMIN_PASSWORD}
    command: [sh, -ec, "cp /tls/server.key /tmp/rehearsal.key && cp /tls/server.pem /tmp/rehearsal.pem && chown postgres:postgres /tmp/rehearsal.key /tmp/rehearsal.pem && chmod 600 /tmp/rehearsal.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/rehearsal.pem -c ssl_key_file=/tmp/rehearsal.key"]
    volumes:
      - ${JSON.stringify(directory+':/tls:ro')}
      - data:/var/lib/postgresql
    healthcheck:
      test: [CMD-SHELL, "pg_isready -U rehearsal_admin -d mytikas"]
      interval: 2s
      timeout: 3s
      retries: 30
networks:
  default:
    name: ${network}
volumes:
  data:
`);
 writeFileSync(override,`networks:\n  default:\n    external: true\n    name: ${network}\n`);
 dbStarted=true;db(['up','-d','--wait','--wait-timeout','120'],{label:'Separate TLS PostgreSQL provisioning'});
 psql(`CREATE ROLE mytikas_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${ownerPassword}';\nCREATE ROLE mytikas_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${runtimePassword}';\nALTER DATABASE mytikas OWNER TO mytikas_owner;\nALTER SCHEMA public OWNER TO mytikas_owner;\n`);
 const grants=readFileSync(resolve('scripts/runtime-grants.sql'),'utf8');
 const grantSql=grants.replaceAll(':"runtime_role"','"mytikas_runtime"').replaceAll(':"database"','"mytikas"');
 function deploy(image){
  environment(image);appStarted=true;
  app(['--profile','migration','run','--rm','migrate'],{label:'Image migration against external TLS database'});
  const compatibleGrants=image===oldImage ? grantSql.replace(', email_tokens, email_jobs, email_limits, class_jobs','').replace(/GRANT SELECT, UPDATE ON rosters, roster_slots[^;]+;/,'') : grantSql;
  psql(compatibleGrants);
  app(['up','-d','--force-recreate','--wait','--wait-timeout','120','app','worker'],{label:'Cloud web/worker deployment'});
  app(['exec','-T','worker','node','dist/worker-health.js'],{label:'Cloud worker heartbeat'});
  verifyPorts(appArgs);verifyPorts(dbArgs);
 }
 deploy(oldImage);const password=secret();const baseline=account(undefined,password);
 console.log('Cloud rehearsal: published previous image registration, secure session, non-owner verified TLS and worker health passed.');
 app(['stop','app','worker'],{label:'Stop writers for pre-upgrade snapshot'});
 db(['exec','-T','db','pg_dump','-U','rehearsal_admin','-d','mytikas','-Fc','-f','/tmp/preupgrade.dump'],{label:'Private pre-upgrade snapshot'});
 deploy(newImage);account(baseline,password);
 console.log('Cloud rehearsal: upgraded image preserves password authentication, existing session, application and immutable history.');
 app(['stop','app','worker'],{label:'Stop writers before schema rollback'});
 db(['exec','-T','db','psql','-X','-v','ON_ERROR_STOP=1','-U','rehearsal_admin','-d','postgres','-c','DROP DATABASE mytikas WITH (FORCE)','-c','CREATE DATABASE mytikas OWNER mytikas_owner'],{label:'Recreate isolated rollback database'});
 db(['exec','-T','db','pg_restore','-U','rehearsal_admin','-d','mytikas','--exit-on-error','/tmp/preupgrade.dump'],{label:'Restore private pre-upgrade snapshot'});
 deploy(oldImage);account(baseline,password);
 console.log('Cloud rehearsal: pre-upgrade snapshot rollback preserves the original session and data.');
 console.log(JSON.stringify({oldImage,oldId,newImage,newId,migrations:baseline.migrations.map(m=>m.name),scope:'Isolated verified-TLS PostgreSQL; loopback ingress simulation; no host ports or live third-party calls; schema rollback uses a quiesced pre-upgrade snapshot.'}));
}finally{
 let cleanupError;
 if(appStarted)try{app(['down','--remove-orphans'],{label:'Rehearsal application cleanup'});}catch(e){cleanupError=e;}
 if(dbStarted)try{db(['down','--volumes','--remove-orphans'],{label:'Rehearsal database cleanup'});}catch(e){cleanupError=e;}
 if(cleanupError)throw cleanupError;
 rmSync(directory,{recursive:true,force:true});
}
