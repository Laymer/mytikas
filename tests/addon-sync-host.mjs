import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const home=fs.mkdtempSync(join(tmpdir(),'addon-sync-host-'));
const machine=join(home,'.mytikas'), deployment=join(home,'deployment'), privatePath=join(deployment,'.public');
const configDir=join(machine,'integrations'), inputs=join(configDir,'addon-sync.json');
const image='ghcr.io/mytikas-monster/mytikas@sha256:'+'1'.repeat(64), commit='a'.repeat(40);
const write=(path,value)=>fs.writeFileSync(path,JSON.stringify(value),{mode:0o600});
const read=path=>JSON.parse(fs.readFileSync(path,'utf8'));
const overlay=join(privatePath,'addon-sync.json');
const host={root:deployment,project:'fixture',env:join(deployment,'.env.public'),compose:join(deployment,'compose.json'),token:join(privatePath,'tunnel-token')};
const privateKey=join(configDir,'fixture.pem'), journal=join(home,'calls.jsonl'), state=join(machine,'machine.json');
const calls=()=>fs.readFileSync(journal,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const optsFile=join(home,'fixture.json');
const original={services:{db:{environment:{POSTGRES_PASSWORD:'b'.repeat(64)}},app:{image:'old',environment:{DATABASE_URL:'postgres://runtime:'+'c'.repeat(64)+'@db/app',SESSION_SECRET:'d'.repeat(96)}},worker:{image:'old',environment:{}},tunnel:{user:'1000:1000'}}};
original.services.app.environment.APP_ORIGIN='https://app.mytikas.monster';
original.services.app.environment.DEPLOYMENT_PROFILE='public';
original.services.db.volumes=[{type:'volume',source:'data',target:'/var/lib/postgresql'}];
original.volumes={data:{name:'fixture-data'}};
const releaseCommit='895dfd8e5f1ff649ee87f524bdb218b37df07315';
const cfg={image:'ghcr.io/mytikas-monster/mytikas-synchronizer@sha256:'+'2'.repeat(64),GITHUB_APP_ID:'42',GITHUB_FORK_INSTALLATION_ID:'43',GITHUB_UPSTREAM_INSTALLATION_ID:'44',GITHUB_APP_PRIVATE_KEY_FILE:privateKey};
const opts={};
function run(args) {
  write(optsFile,opts);
  fs.writeFileSync(journal,'');
  return spawnSync(process.execPath,['scripts/addon-sync.mjs',...args],{
    env:{...process.env,HOME:home,PATH:join(home,'bin')+':'+process.env.PATH,HOST_FIXTURE:home},
    encoding:'utf8',timeout:60000
  });
}
function ok(...args){const r=run(args);assert.equal(r.status,0,r.stderr);}
function fails(pattern,...args){const r=run(args);assert.notEqual(r.status,0);assert.match(r.stderr,pattern);}
try {
  for(const dir of [configDir,privatePath,join(home,'bin'),join(machine,'sources',commit)])fs.mkdirSync(dir,{recursive:true,mode:0o700});
  write(state,{phase:'active',context:'local',active:host});
  write(host.compose,original);
  fs.writeFileSync(host.env,'',{mode:0o600});
  fs.writeFileSync(host.token,'x'.repeat(30),{mode:0o600});
  fs.writeFileSync(join(machine,'sources',commit,'.complete'),commit);
  fs.writeFileSync(privateKey,generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}}).privateKey,{mode:0o600});
  write(inputs,cfg);
  const applied=Object.fromEntries(fs.readdirSync('migrations').filter(n=>n.endsWith('.sql')&&!n.startsWith('009_')).map(n=>[n,createHash('sha256').update(fs.readFileSync(join('migrations',n))).digest('hex')]));
  write(join(home,'applied.json'),applied);
  fs.copyFileSync('scripts/addon-sync-grants.sql',join(home,'expected-grants.sql'));
  // Use a disposable local engine façade. The real CLI resolves its machine pointer,
  // validates credentials, checks actual migration file hashes and persists its overlay.
  fs.writeFileSync(join(home,'bin/docker'),`#!/usr/bin/env python3
import sys, os, json, shutil, hashlib
from pathlib import Path
a=sys.argv[1:]
p=Path(os.environ['HOST_FIXTURE'])
cfg=json.loads((p/'fixture.json').read_text())
with (p/'calls.jsonl').open('a') as f:
 f.write(json.dumps({'args':a, 'has_owner_url':bool(os.environ.get('DATABASE_URL') or os.environ.get('ARCHIVE_DATABASE_URL')),'has_role_password':bool(os.environ.get('SYNC_PASSWORD'))})+'\\n')
if a[0]=='--context': a=a[2:]
services=['db','app','worker','tunnel','archive-db','synchronizer']
ids={name:format(i+1,'x')*32 for i,name in enumerate(services)}
def service_id(s): return ids.get(s,'1'*32)
if a[0]=='ps' and cfg.get('checkout') and 'label=com.docker.compose.service=db' in a: print(ids['db'] if not cfg.get('no_host') else '')
elif a[0]=='ps': pass
elif a[0]=='pull' and cfg.get('pull_denied'): sys.exit(1)
elif a[0]=='run' and a[-1]=='preflight' and cfg.get('preflight_failure'): sys.exit(1)
elif a[:2]==['context','inspect']: print('[{"Endpoints":{"docker":{"Host":"unix:///fixture"}}}]')
elif a[0]=='info': print('{"OSType":"linux","Architecture":"amd64"}')
elif a[:2]==['volume','ls']:
 if (p/'retained').exists(): print('fixture_addon-archive-data')
elif a[0]=='create': print('1'*32)
elif a[0]=='cp' and a[1].endswith(':/app/migrations'):
 shutil.copytree(str(p/'candidate-migrations'),str(Path(a[2])/'migrations'))
elif a[:2]==['image','inspect']: print(json.dumps([{'Id':a[-1] if cfg.get('wrong_digest') else 'sha256:'+'e'*64}]))
elif a[0]=='inspect' and cfg.get('rollout'):
 service=next((name for name,id in ids.items() if id==a[1]),'db')
 running=service=='db' or not (p/'stopped').exists()
 overlay=p/'deployment'/'.public'/'addon-sync.json'
 settings=json.loads((p/'.mytikas'/'integrations'/'addon-sync.json').read_text())
 env=[k+'='+v for k,v in settings.items() if k.startswith('GITHUB_')]
 if overlay.exists(): env.append('ADDON_SUBMISSIONS_ENABLED='+json.loads(overlay.read_text())['services']['app']['environment']['ADDON_SUBMISSIONS_ENABLED'])
 labels={'com.docker.compose.project':'mytikas-public' if cfg.get('checkout') else 'fixture',
  'com.docker.compose.service':service,'com.docker.compose.project.working_dir':str(p/'deployment'),
  'com.docker.compose.project.config_files':str(p/'deployment'/'compose.public.yaml')}
 mounts=([{'Type':'volume','Name':cfg.get('volume','fixture-data'),'Destination':'/var/lib/postgresql'}] if service=='db' else
   [{'Source':settings['GITHUB_APP_PRIVATE_KEY_FILE'],'Destination':'/run/secrets/github.pem','RW':False}])
 print(json.dumps([{'Image':'sha256:'+'f'*64 if service in ['db','archive-db'] else 'sha256:'+'e'*64,'Mounts':mounts,
  'Config':{'Labels':labels,'Env':env},'State':{'Running':running,'ExitCode':0,'OOMKilled':False,'Health':{'Status':'healthy'}}}]))
elif a[0]=='inspect': print('[{"Image":"fixture-db-image","State":{"Running":false,"OOMKilled":false,"ExitCode":0}}]')
elif a[0]=='compose':
 if '--format' in a and 'config' in a:
  compose=json.loads((p/'deployment'/'compose.json').read_text())
  if 'MYTIKAS_IMAGE' in os.environ:
   for name in ['app','worker','migrate']:compose.setdefault('services',{}).setdefault(name,{})['image']=os.environ['MYTIKAS_IMAGE']
  print(json.dumps(compose))
 if 'ps' in a: print(service_id(a[-1]))
 if 'stop' in a and 'app' in a: (p/'stopped').touch()
 if ('up' in a or 'start' in a) and 'app' in a: (p/'stopped').unlink(missing_ok=True)
 if 'exec' in a and 'pg_dump' in a:
  if cfg.get('backup_failure'): sys.exit(1)
  print('PGDMP-fixture')
 if 'exec' in a and 'psql' in a and 'SYNC_PASSWORD' in a:
  # Read the actual child stdin. An empty stream succeeds in real psql.
  data=sys.stdin.buffer.read()
  if data==(p/'expected-grants.sql').read_bytes():
   (p/('role-'+a[a.index('psql')-1])).write_text(hashlib.sha256(os.environ['SYNC_PASSWORD'].encode()).hexdigest())
 if 'exec' in a and '/scripts/public-runtime-role.sql' in a and cfg.get('grant_failure'): sys.exit(1)
 if 'exec' in a and 'psql' in a and '-c' in a:
  q=a[-1]
  if 'has_column_privilege' in q:
   service=a[a.index('psql')-1]
   role=p/('role-'+service)
   if not role.exists() or role.read_text()!=hashlib.sha256(os.environ.get('PGPASSWORD','').encode()).hexdigest() or cfg.get('login_failure')==service: sys.exit(2)
   print('f' if cfg.get('bad_grants')==service else 't')
  elif 'json_object_agg' in q: print((p/'applied.json').read_text())
  elif 'to_regclass' in q: print(cfg.get('schema','t'))
  elif 'pg_tables' in q: print('["fixture"]')
  elif 'pg_sequences' in q: print('[]')
  elif 'count(*)' in q: print(cfg.get('existing','0'))
 if 'up' in a and a[-1]=='archive-db': (p/'retained').touch()
 if a[-1]=='preflight' and cfg.get('preflight_failure'): sys.exit(1)
`,{mode:0o700});
  fs.cpSync(resolve('migrations'),join(home,'candidate-migrations'),{recursive:true});
  fails(/Usage/,'invalid');
  fails(/No archive database/,'pause');
  fails(/full upstream commit/,'upgrade-managed-web',image,'invalid');
  opts.wrong_digest=true;
  fails(/commit image/,'upgrade-managed-web',image,commit);
  delete opts.wrong_digest;
  fs.appendFileSync(join(home,'candidate-migrations','008_account_recovery_email.sql'),'-- changed');
  fails(/match installed/,'upgrade-managed-web',image,commit);
  assert(!calls().some(c=>c.args.includes('stop')));
  fs.copyFileSync('migrations/008_account_recovery_email.sql',join(home,'candidate-migrations','008_account_recovery_email.sql'));
  ok('upgrade-managed-web',image,commit);
  assert.equal(read(state).active.commit,commit);
  for(const s of ['app','worker'])assert.equal(read(host.compose).services[s].image,image);
  assert.equal(read(join(deployment,'compose-before-009-'+commit+'.json')).services.app.image,'old');
  assert(calls().some(c=>c.args.includes('dist/migrate.js') && c.has_owner_url));
  assert(calls().some(c=>c.args.includes('/scripts/public-runtime-role.sql')));
  fs.chmodSync(inputs,0o644);fails(/owner-only/,'enable');fs.chmodSync(inputs,0o600);
  write(inputs,{...cfg,GITHUB_FORK_INSTALLATION_ID:'0'});fails(/numeric GitHub App/,'enable');
  write(inputs,{...cfg,image:'latest'});fails(/published synchronizer image/,'enable');
  write(inputs,cfg);opts.schema='f';fails(/Upgrade the application/,'enable');delete opts.schema;
  opts.existing='1';fails(/Recover the existing archive/,'enable');delete opts.existing;
  opts.login_failure='db';fails(/verify the synchronizer login.*mytikas_public/,'enable');
  assert(!calls().some(c=>c.args.at(-1)==='preflight'));
  delete opts.login_failure;
  opts.bad_grants='archive-db';fails(/incorrect privileges on mytikas_archive/,'enable');
  assert.equal(read(overlay).services.app.environment.ADDON_SUBMISSIONS_ENABLED,'0');
  assert(!calls().some(c=>c.args.includes('up')&&c.args.at(-1)==='synchronizer'));
  delete opts.bad_grants;
  opts.preflight_failure=true;fails(/operation failed/,'enable');
  assert.equal(read(overlay).services.app.environment.ADDON_SUBMISSIONS_ENABLED,'0');
  assert(!calls().some(c=>c.args.includes('up')&&c.args.at(-1)==='synchronizer'));
  delete opts.preflight_failure;
  ok('enable');
  const worker=read(overlay).services.synchronizer;
  assert.equal(worker.volumes[0].source,privateKey);
  assert.equal(worker.volumes[0].read_only,true);
  assert.equal(worker.image,cfg.image);
  assert.match(worker.environment.ARCHIVE_DATABASE_URL,/mytikas_sync:.*@archive-db/);
  assert.equal(read(overlay).services.app.environment.ADDON_SUBMISSIONS_ENABLED,'1');
  const sequence=calls();
  assert.equal(sequence.filter(c=>c.has_role_password && c.args.includes('psql')).length,2);
  for(const service of ['db','archive-db']) {
    const probe=sequence.find(c=>c.args.includes('PGPASSWORD') && c.args.includes(service));
    assert(probe);
    assert.equal(probe.args[probe.args.indexOf('-h')+1],service);
    assert.equal(probe.args[probe.args.indexOf('-U')+1],'mytikas_sync');
  }
  const preflight=sequence.findIndex(c=>c.args.at(-1)==='preflight');
  const workerStart=sequence.findIndex(c=>c.args.includes('up')&&c.args.at(-1)==='synchronizer');
  const webStart=sequence.findIndex(c=>c.args.includes('up')&&c.args.at(-1)==='app');
  assert(preflight>=0 && preflight<workerStart && workerStart<webStart);
  const credential=read(overlay)['x-sync-password'];
  assert(!JSON.stringify(sequence).includes(credential));
  ok('pause');
  assert.equal(read(overlay).services.synchronizer,undefined);
  assert.equal(read(overlay).services.app.environment.ADDON_SUBMISSIONS_ENABLED,'0');
  assert.equal(read(overlay)['x-sync-password'],credential);
  ok('pause');
  fs.rmSync(join(home,'retained'));
  fails(/Retained archive volume missing/,'enable');
  fails(/before archive storage/,'upgrade-managed-web',image,commit);
  fs.writeFileSync(join(privatePath,'machine-handoff.json'),'{}');
  fails(/currently active host/,'enable');
  write(state,{phase:'import-stopping',active:host});
  fails(/current host transfer/,'enable');
  // Rehearse using the published release and the actual CLI from another checkout.
  opts.rollout=true;
  write(state,{phase:'active',context:'local',active:host});
  write(host.compose,original);
  write(inputs,cfg);
  fs.rmSync(join(privatePath,'machine-handoff.json'));
  fs.rmSync(overlay);
  fs.mkdirSync(join(machine,'sources',releaseCommit),{recursive:true});
  fs.writeFileSync(join(machine,'sources',releaseCommit,'.complete'),releaseCommit);
  opts.volume='other-volume';
  fails(/different volume/,'rollout');
  delete opts.volume;
  opts.pull_denied=true;
  fails(/Docker registry read access|Cannot pull/,'rollout');
  delete opts.pull_denied;
  opts.preflight_failure=true;
  fails(/App preflight failed/,'rollout');
  assert(!calls().some(c=>c.args.includes('stop')));
  delete opts.preflight_failure;
  opts.backup_failure=true;
  fails(/failed|backup/i,'rollout');
  const restored=calls();
  assert(restored.some(c=>c.args.includes('start') && c.args.at(-1)==='tunnel'));
  assert(!restored.some(c=>c.args.includes('dist/migrate.js')));
  delete opts.backup_failure;
  opts.grant_failure=true;
  fails(/failed/i,'rollout');
  const checkpoint=join(privatePath,'addon-rollout.json');
  const verified=read(checkpoint);
  assert.equal(verified.phase,'verified');
  assert(fs.existsSync(join(verified.backup,'manifest.json')));
  delete opts.grant_failure;
  ok('rollout');
  assert(!fs.existsSync(checkpoint));
  assert(!calls().some(c=>c.args.includes('pg_dump')));
  assert.equal(read(state).active.commit,releaseCommit);
  ok('rollout');
  assert(!calls().some(c=>c.args.includes('stop')||c.args.includes('pg_dump')));
  // Test discovery from Docker labels on an active ordinary checkout.
  write(state,{phase:'idle',context:'local'});
  opts.checkout=true;
  opts.no_host=true;
  fails(/active public host/,'rollout');
  delete opts.no_host;
  fs.copyFileSync(host.compose,join(deployment,'compose.public.yaml'));
  fs.rmSync(overlay);fs.rmSync(join(home,'retained'));
  ok('rollout');
  assert.match(fs.readFileSync(host.env,'utf8'),/MYTIKAS_IMAGE=ghcr\.io\/mytikas-monster\/mytikas@sha256:0eb302/);
  console.log('Verified managed upgrade, synchronizer credentials, least-privilege wiring, gate ordering and pause/recovery.');
} finally {fs.rmSync(home,{recursive:true,force:true});}
