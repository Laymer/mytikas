// Isolated round trip: real images, PostgreSQL dumps/restores, volumes, grants and health.
// The connector is replaced by a sleeping local process; no real tunnel or webhook is used.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Machine } from '../scripts/machine/core.mjs';
import { inspectZip } from '../scripts/machine/archive.mjs';
const root=fs.mkdtempSync(join(tmpdir(),'mytikas-handoff-container-'));
const repo=resolve('.'),runID=randomBytes(6).toString('hex'),projects=new Map();
const c={EMAIL_OUTBOX_KEY:'12'.repeat(32),SMTP_HOST:'smtp.invalid',SMTP_PORT:'587',SMTP_USER:'',SMTP_PASSWORD:'',EMAIL_FROM:'guild@example.test',POSTGRES_PASSWORD:'a'.repeat(64),RUNTIME_DATABASE_PASSWORD:'b'.repeat(64),SESSION_SECRET:'c'.repeat(96),PUBLIC_UID:'501',PUBLIC_GID:'20',DISCORD_WEBHOOK_URL:'',tunnelToken:'d'.repeat(100)};
const originalFetch=globalThis.fetch;
globalThis.fetch=async url=>{assert.equal(url,'https://app.mytikas.monster/api/health');return {ok:true};};
class Isolated extends Machine {
  async source(_commit,dir) {fs.mkdirSync(join(dir,'scripts'),{recursive:true,mode:0o700});fs.cpSync(join(repo,'migrations'),join(dir,'migrations'),{recursive:true});for(const n of ['runtime-grants.sql','public-runtime-role.sql'])fs.copyFileSync(join(repo,'scripts',n),join(dir,'scripts',n));}
  writeDeployment(dir,c,m,project) {
    assert(project.startsWith('mytikas-'));const d=super.writeDeployment(dir,c,m,project);
    const compose=JSON.parse(fs.readFileSync(d.compose));
    compose.services.tunnel={image:m.images.db,init:true,entrypoint:['sleep','infinity'],network_mode:'service:app'};
    fs.writeFileSync(d.compose,JSON.stringify(compose));projects.set(d.project,{machine:this,d});return d;
  }
  async publicCheck() {
    // Equivalent proxied request from app's isolated namespace verifies actual session cookie.
    this.dc(this.state.transfer.next,['exec','-T','app','node','-e',`fetch('http://127.0.0.1:8080/api/auth/me',{headers:{'x-forwarded-proto':'https','x-forwarded-for':'192.0.2.1'}}).then(async r=>{let c=r.headers.get('set-cookie')||'';if(!r.ok||!c.includes('Secure')||!c.includes('HttpOnly'))process.exit(1)})`]);
  }
}
async function initial(machine,name,password=c.POSTGRES_PASSWORD) {
  const images={app:JSON.parse(machine.docker(['image','inspect',process.env.MACHINE_TEST_IMAGE||'mytikas-tested:latest']))[0].Id,db:JSON.parse(machine.docker(['image','inspect','postgres:18-bookworm']))[0].Id};images.tunnel=images.db;
  const d=machine.writeDeployment(join(machine.home,'initial'),{...c,POSTGRES_PASSWORD:password},{images},`mytikas-fixture-${runID}-${name}`);
  fs.writeFileSync(d.env,fs.readFileSync(d.env,'utf8').replace(/^PUBLIC_UID=.*$/m,'PUBLIC_UID=501').replace(/^PUBLIC_GID=.*$/m,'PUBLIC_GID=20'));
  d.commit=machine.run('git',['-C',repo,'rev-parse','HEAD']);machine.save({active:d,phase:'active'});
  machine.dc(d,['up','-d','--no-deps','--wait','--wait-timeout','180','db'],{timeout:240000});
  machine.dc(d,['run','--rm','-T','--no-deps','-e',`DATABASE_URL=postgres://mytikas_public:${password}@db:5432/mytikas_public`,'app','node','dist/migrate.js']);
  const id=machine.id(d,'db');machine.docker(['exec',id,'mkdir','/scripts']);
  for(const n of ['runtime-grants.sql','public-runtime-role.sql'])machine.docker(['cp',join(repo,'scripts',n),`${id}:/scripts/${n}`]);
  machine.dc(d,['exec','-T','-e','RUNTIME_DATABASE_PASSWORD','db','psql','-X','-q','-U','mytikas_public','-d','mytikas_public','-v','ON_ERROR_STOP=1','-f','/scripts/public-runtime-role.sql'],{env:{...machine.env,RUNTIME_DATABASE_PASSWORD:c.RUNTIME_DATABASE_PASSWORD}});
  const hash=machine.dc(d,['run','--rm','-T','--no-deps','app','node','-e',"require('argon2').hash('fixture-password-long').then(h=>console.log(h))"]);d.passwordHash=hash;
  machine.sql(d,`INSERT INTO users(id,email,password_hash,role,activation_exempt) VALUES ('00000000-0000-0000-0000-000000000001','${name}@fixture.test','${hash}','ADMIN',true); INSERT INTO sessions(sid,sess,expire) VALUES ('preserved-session','{"userId":"00000000-0000-0000-0000-000000000001","cookie":{"secure":true}}','2100-01-01');`);
  machine.sql(d,`INSERT INTO applications(id,user_id,character_name,character_key,status,next_check_at) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Fixture','fixture','APPROVED','2100-01-01');
    INSERT INTO submissions(id,application_id,revision,character_name,character_key,motivation,rules_id,actor_id) VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002',1,'Fixture','fixture','Fixture motivation',1,'00000000-0000-0000-0000-000000000001');
    INSERT INTO discord_jobs(submission_id,status,attempts,available_at,lease_token,lease_until) VALUES ('00000000-0000-0000-0000-000000000003','PENDING',3,'2100-01-01','00000000-0000-0000-0000-000000000004','2100-01-02');
    INSERT INTO events(application_id,actor_id,to_status,method) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','APPROVED','MANUAL');
    INSERT INTO role_events(user_id,actor_id,old_role,new_role) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','USER','ADMIN');`);
  machine.dc(d,['up','-d','--no-deps','--wait','--wait-timeout','180','app','worker'],{timeout:240000});machine.dc(d,['up','-d','--no-deps','tunnel']);return d;
}
try {
  const a=new Isolated(join(root,'wsl')),b=new Isolated(join(root,'mac'));
  await a.prepare();await b.prepare();
  const oldA=await initial(a,'source'),oldB=await initial(b,'destination','f'.repeat(64));
  await a.migrate();assert.equal(a.state.phase,'handed-off');assert.equal(a.dc(oldA,['ps','-a','-q']),'');
  const first=a.state.export.target;assert.equal(inspectZip(first).configuration.PUBLIC_UID,'501');
  // Exercise import over a deliberately stopped destination while retaining its volume.
  b.dc(oldB,['down']);
  await b.import(first);assert.equal(b.state.phase,'active');
  assert.equal(b.sql(b.state.active,"SELECT email || ':' || role || ':' || password_hash FROM users"),`source@fixture.test:ADMIN:${oldA.passwordHash}`);
  assert.equal(b.sql(oldB,'SELECT email FROM users'),'destination@fixture.test');
  assert.equal(b.sql(b.state.active,"SELECT count(*) FROM sessions WHERE sid='preserved-session'"),'1');
  assert(fs.existsSync(join(b.state.transfer.dir,'destination-safety.dump')));
  const before=b.state.active;await b.import(first);assert.deepEqual(b.state.active,before);
  await b.migrate();assert.equal(b.state.highest,2);await a.import(b.state.export.target);assert.equal(a.state.phase,'active');assert.equal(a.state.highest,2);
  assert.equal(a.sql(a.state.active,"SELECT email || ':' || role || ':' || password_hash FROM users"),`source@fixture.test:ADMIN:${oldA.passwordHash}`);
  assert.equal(a.sql(a.state.active,"SELECT count(*) FROM sessions WHERE sid='preserved-session'"),'1');
  assert.equal(a.sql(a.state.active,"SELECT attempts || ':' || lease_token FROM discord_jobs"),'3:00000000-0000-0000-0000-000000000004');
  assert.equal(a.sql(a.state.active,'SELECT count(*) FROM events'),'1');
  assert.equal(a.sql(a.state.active,'SELECT count(*) FROM role_events'),'1');
  a.dc(a.state.active,['exec','-T','app','node','-e',`(async()=>{const headers={'x-forwarded-proto':'https','x-forwarded-for':'192.0.2.2'};const me=await fetch('http://127.0.0.1:8080/api/auth/me',{headers});const token=(await me.json()).csrfToken;const cookie=me.headers.get('set-cookie').split(';')[0];const login=await fetch('http://127.0.0.1:8080/api/auth/login',{method:'POST',headers:{...headers,origin:'https://app.mytikas.monster','content-type':'application/json','x-csrf-token':token,cookie},body:JSON.stringify({email:'source@fixture.test',password:'fixture-password-long'})});if(!login.ok||(await login.json()).user.role!=='ADMIN')process.exit(1)})()`]);
  await assert.rejects(()=>a.import(first),/Stale/);
  console.log('Isolated WSL-style → Mac-style → return restore passed; previous data, administrator, password hash and session preserved. Actual macOS bootstrap remains a manual acceptance test.');
} finally {
  globalThis.fetch=originalFetch;
  for(const {machine,d} of projects.values())try{machine.dc(d,['down','--volumes'],{timeout:180000});}catch{}
  fs.rmSync(root,{recursive:true,force:true});
}
