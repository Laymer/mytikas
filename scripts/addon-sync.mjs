import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createPrivateKey, randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Machine } from './machine/core.mjs';
import { fileDigest } from './machine/archive.mjs';
import { backupForRollout } from './addon-rollout-backup.mjs';
import { configureGithubApp, InstallationPending } from './addon-sync-setup.mjs';
import { registerApp, installationNotice } from './addon-sync-register.mjs';

const release = {
  app: 'ghcr.io/mytikas-monster/mytikas@sha256:0eb302cb5fa016a545c828aa645419487685c1e06b64ca84edd4fa773347af07',
  commit: '895dfd8e5f1ff649ee87f524bdb218b37df07315',
  worker: 'ghcr.io/mytikas-monster/mytikas-synchronizer@sha256:706277f5825cc88cc892e4021a8e49b2582b12d01fdf26657e92a0e94f408833',
  workerCommit: 'bdf1d2b7009c42ed1fcb81e23e0cea5d32a6481a'
};

const root = fileURLToPath(new URL('../', import.meta.url));
const privateDir = join(homedir(), '.mytikas');
const settingsFile = join(privateDir, 'integrations', 'addon-sync.json');
function check(value, message) { if (!value) throw new Error(message); }
function privateFile(file) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'Use regular owner-only settings and key files.');
}
function replacePrivate(file,text) {
  const tmp=file+'.'+randomUUID();
  try {
    fs.writeFileSync(tmp,text,{flag:'wx',mode:0o600,flush:true});
    fs.renameSync(tmp,file);
    const dir=fs.openSync(dirname(file),'r');
    try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
  } finally {fs.rmSync(tmp,{force:true});}
}
function save(file,object) {replacePrivate(file,JSON.stringify(object,null,2));}
function settings() {
  privateFile(settingsFile);
  const input = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  check(/^ghcr\.io\/mytikas-monster\/mytikas-synchronizer@sha256:[a-f0-9]{64}$/.test(input.image), 'Set the published synchronizer image by digest.');
  for (const field of ['GITHUB_APP_ID','GITHUB_FORK_INSTALLATION_ID','GITHUB_UPSTREAM_INSTALLATION_ID'])
    check(typeof input[field] === 'string' && /^[1-9]\d*$/.test(input[field]), 'Configure all three numeric GitHub App IDs as strings.');
  privateFile(input.GITHUB_APP_PRIVATE_KEY_FILE);
  check(resolve(input.GITHUB_APP_PRIVATE_KEY_FILE) === input.GITHUB_APP_PRIVATE_KEY_FILE && !input.GITHUB_APP_PRIVATE_KEY_FILE.includes('$'), 'Use an absolute private key path without a dollar sign.');
  check(createPrivateKey(fs.readFileSync(input.GITHUB_APP_PRIVATE_KEY_FILE)).asymmetricKeyType === 'rsa', 'GitHub App requires an RSA private key.');
  return input;
}
export function provisionSyncRole(machine, deployment, service, password, archive) {
  const database = archive ? 'mytikas_archive' : 'mytikas_public';
  machine.dc(deployment, ['exec','-T','-e','SYNC_PASSWORD',service,'psql','-X','-q','-U',database,'-d',database,'-v','ON_ERROR_STOP=1','-v','archive='+archive,'-f','-'], {
    stdio:['pipe','pipe','pipe'],
    input: fs.readFileSync(join(root,'scripts','addon-sync-grants.sql')),
    env: {...machine.env, SYNC_PASSWORD:password}
  });

  // Connect over the same network and as the same role as the worker. An empty
  // stdin is a successful psql script, so the owner's exit code is insufficient.
  const privileges = archive ? `
    has_table_privilege('public.archives','SELECT') AND has_table_privilege('public.archives','INSERT')
    AND has_sequence_privilege('public.archives_id_seq','USAGE') AND has_sequence_privilege('public.archives_id_seq','SELECT')
    AND (SELECT bool_and(has_column_privilege('public.archives',col,'UPDATE'))
         FROM unnest(ARRAY['pr_number','merge_commit','release_id','receipt_checked_at','curseforge_file_id']) AS col)
    AND NOT has_column_privilege('public.archives','archive','UPDATE')` : `
    has_table_privilege('public.addon_releases','SELECT') AND has_table_privilege('public.addon_releases','INSERT')
    AND (SELECT bool_and(has_column_privilege('public.addon_submissions',col,'SELECT'))
         FROM unnest(ARRAY['id','version','notes','sha256','archive','status','archive_id','pr_number','detail','curseforge_file_id']) AS col)
    AND (SELECT bool_and(has_column_privilege('public.addon_submissions',col,'UPDATE'))
         FROM unnest(ARRAY['archive','status','archive_id','pr_number','detail','curseforge_file_id']) AS col)`;
  const verify = `SELECT current_user = 'mytikas_sync' AND has_schema_privilege('public','USAGE')
    AND NOT has_schema_privilege('public','CREATE') AND ${privileges}`;
  let result;
  try {
    result=machine.dc(deployment,['exec','-T','-e','PGPASSWORD',service,'psql','-XAtq','-h',service,
      '-U','mytikas_sync','-d',database,'-v','ON_ERROR_STOP=1','-c',verify],{env:{...machine.env,PGPASSWORD:password}});
  } catch {
    throw new Error('Could not verify the synchronizer login and grants on '+database+'.');
  }
  check(result==='t','The synchronizer login has incorrect privileges on '+database+'.');
}
function recreateWeb(machine,d) {
  machine.dc(d,['rm','--stop','--force','tunnel']);
  machine.dc(d,['up','-d','--no-build','--no-deps','--wait','--wait-timeout','180','app']);
  machine.dc(d,['up','-d','--no-deps','tunnel']);
}
async function enable(machine,d,cfg=settings()) {
  check(machine.sql(d,"SELECT to_regclass('public.addon_submissions') IS NOT NULL")==='t', 'Upgrade the application image, schema and runtime grants first.');
  const app=machine.inspect(machine.id(d,'app'));
  machine.docker(['run','--rm','--network','none','--entrypoint','node',app.Image,'-e',"if(!require('fs').existsSync('/app/migrations/009_addon_submissions.sql'))process.exit(1)"]);
  machine.docker(['pull',cfg.image],{timeout:300000});
  const file=machine.addonOverlay(d);
  const projectVolume=d.project+'_addon-archive-data';
  const retained=machine.docker(['volume','ls','--format','{{.Name}}']).split('\n').includes(projectVolume);
  let overlay;
  if (machine.addons(d)) {
    privateFile(file);
    overlay=JSON.parse(fs.readFileSync(file,'utf8'));
    check(retained || !overlay['x-initialized'], 'Retained archive volume missing. Restore the paired databases before continuing.');
  } else {
    check(!retained && machine.sql(d,'SELECT count(*) FROM addon_submissions WHERE archive_id IS NOT NULL')==='0','Recover the existing archive overlay and volume before enabling.');
    overlay=machine.createArchiveOverlay(d,machine.inspect(machine.id(d,'db')).Image);
  }
  const password=overlay['x-sync-password'] || randomBytes(32).toString('hex');
  check(/^[a-f0-9]{64}$/.test(password),'Invalid stored synchronization credential.');
  const owner=overlay.services['archive-db'].environment.POSTGRES_PASSWORD;
  const worker={
    image:cfg.image, init:true, user:process.getuid()+':'+process.getgid(), restart:'unless-stopped',
    read_only:true, tmpfs:['/tmp'], cap_drop:['ALL'],security_opt:['no-new-privileges:true'],
    environment:{
      APP_DATABASE_URL:'postgres://mytikas_sync:'+password+'@db/mytikas_public?sslmode=disable',
      ARCHIVE_DATABASE_URL:'postgres://mytikas_sync:'+password+'@archive-db/mytikas_archive?sslmode=disable',
      GITHUB_APP_ID:cfg.GITHUB_APP_ID, GITHUB_FORK_INSTALLATION_ID:cfg.GITHUB_FORK_INSTALLATION_ID,
      GITHUB_UPSTREAM_INSTALLATION_ID:cfg.GITHUB_UPSTREAM_INSTALLATION_ID,GITHUB_APP_PRIVATE_KEY_FILE:'/run/secrets/github.pem'
    },
    volumes:[{type:'bind',source:cfg.GITHUB_APP_PRIVATE_KEY_FILE,target:'/run/secrets/github.pem',read_only:true}],
    healthcheck:{test:['CMD','mytikas-synchronizer','health'],interval:'15s',timeout:'5s',retries:8,start_period:'15s'}
  };
  if (machine.hasSynchronizer(d)) machine.dc(d,['stop','--timeout','60','synchronizer']);
  overlay['x-sync-password']=password;
  overlay.services.synchronizer=worker;
  overlay.services.app.environment.ADDON_SUBMISSIONS_ENABLED='0';
  save(file,overlay);
  machine.dc(d,['up','-d','--no-deps','--wait','--wait-timeout','180','archive-db']);
  overlay['x-initialized']=true;
  save(file,overlay);
  machine.dc(d,['run','--rm','--no-deps','-T','-e','ARCHIVE_DATABASE_URL','synchronizer','migrate'],{
    env:{...machine.env,ARCHIVE_DATABASE_URL:'postgres://mytikas_archive:'+owner+'@archive-db/mytikas_archive?sslmode=disable'}
  });
  provisionSyncRole(machine,d,'db',password,false);
  provisionSyncRole(machine,d,'archive-db',password,true);
  machine.dc(d,['run','--rm','--no-deps','-T','synchronizer','preflight']);
  machine.dc(d,['up','-d','--no-deps','--wait','--wait-timeout','180','synchronizer'],{timeout:240000});
  overlay.services.app.environment.ADDON_SUBMISSIONS_ENABLED='1';
  save(file,overlay);
  recreateWeb(machine,d);
}
async function upgradeManagedWeb(machine,d,image,commit) {
  check(machine.state.phase==='active' && basename(d.compose)==='compose.json', 'Use the public rollout procedure for a checkout deployment.');
  check(/^ghcr\.io\/mytikas-monster\/mytikas@sha256:[a-f0-9]{64}$/.test(image) && /^[a-f0-9]{40}$/.test(commit),'Supply the merged app image digest and its full upstream commit.');
  check(!machine.addons(d),'This one-time upgrade is for hosts before archive storage was attached.');
  const candidate=await prepareWeb(machine,d,image,commit);
  await machine.stop(d);
  installWeb(machine,d,image,commit,candidate);
}

function verifyImage(machine,image,commit) {
  const tagged=image.split('@')[0]+':'+commit;
  try {
    machine.docker(['pull',image],{timeout:300000});
    machine.docker(['pull',tagged],{timeout:300000});
  } catch {
    throw new Error('Cannot pull '+image+' and its commit tag. Check connectivity and access at https://github.com/orgs/Mytikas-Monster/packages. For a private package, authenticate Docker to ghcr.io with read:packages on this host.');
  }
  const imageId=ref=>JSON.parse(machine.docker(['image','inspect',ref]))[0].Id;
  const id=imageId(image);
  check(id===imageId(tagged),'The supplied image digest differs from the published commit image.');
  return id;
}
async function prepareWeb(machine,d,image,commit) {
  const applied=machine.migrations(d);
  check(Object.hasOwn(applied,'008_account_recovery_email.sql'), 'Complete earlier staged application migrations before upgrading to 009.');
  const source=join(machine.home,'sources',commit);
  await machine.source(commit,source);
  const id=verifyImage(machine,image,commit);
  const config=machine.config(d);
  const checkDir=fs.mkdtempSync(join(machine.home,'migrations-'));
  try {
    const expected=machine.imageMigrations(image,checkDir);
    check(Object.hasOwn(expected,'009_addon_submissions.sql') && Object.keys(expected).every(k=>k<='009_addon_submissions.sql') &&
      Object.entries(applied).every(([k,h])=>expected[k]===h),'Candidate must match installed migrations up through 009.');
  } finally {fs.rmSync(checkDir,{recursive:true,force:true});}
  return {config,source,id};
}
function installWeb(machine,d,image,commit,{config,source}) {
  // Retain the old image references until the new schema and grants have committed.
  machine.docker(['run','--rm','--network',d.project+'_default','-e','DATABASE_URL',image,'node','dist/migrate.js'],{
    env:{...machine.env,DATABASE_URL:'postgres://mytikas_public:'+config.POSTGRES_PASSWORD+'@db/mytikas_public'}
  });
  const db=machine.id(d,'db');
  machine.docker(['exec',db,'mkdir','-p','/scripts']);
  for(const f of ['public-runtime-role.sql','runtime-grants.sql'])machine.docker(['cp',join(source,'scripts',f),db+':/scripts/'+f]);
  machine.dc(d,['exec','-T','-e','RUNTIME_DATABASE_PASSWORD','db','psql','-X','-q','-U','mytikas_public','-d','mytikas_public','-v','ON_ERROR_STOP=1','-f','/scripts/public-runtime-role.sql'],{
    env:{...machine.env,RUNTIME_DATABASE_PASSWORD:config.RUNTIME_DATABASE_PASSWORD}
  });
  if(basename(d.compose)==='compose.json') {
    const compose=JSON.parse(fs.readFileSync(d.compose,'utf8'));
    const backup=join(d.root,'compose-before-009-'+commit+'.json');
    if(!fs.existsSync(backup))fs.copyFileSync(d.compose,backup,fs.constants.COPYFILE_EXCL);
    for(const service of ['app','worker'])compose.services[service].image=image;
    save(d.compose,compose);
  } else {
    const text=fs.readFileSync(d.env,'utf8');
    const withoutSelector=text.split('\n').filter(line=>!/^\s*(?:export\s+)?MYTIKAS_IMAGE\s*=/.test(line)).join('\n');
    replacePrivate(d.env,withoutSelector+(withoutSelector.endsWith('\n')?'':'\n')+'MYTIKAS_IMAGE='+image+'\n');
  }
  machine.save({active:{...d,commit,imageSelection:image}});
  machine.dc(d,['rm','--stop','--force','tunnel']);
  machine.dc(d,['up','-d','--no-build','--no-deps','--wait','--wait-timeout','180','app','worker'],{timeout:240000});
  machine.dc(d,['up','-d','--no-deps','tunnel']);
}
function activeDeployment(machine) {
  if(machine.state.active)return machine.state.active;
  const id=machine.docker(['ps','-q','--filter','label=com.docker.compose.project=mytikas-public','--filter','label=com.docker.compose.service=db']);
  check(/^[a-f0-9]{12,64}$/.test(id),'Run rollout on the active public host with its database running.');
  const labels=machine.inspect(id).Config.Labels;
  const dir=labels['com.docker.compose.project.working_dir'];
  check(dir && resolve(dir)===dir && labels['com.docker.compose.project.config_files']?.split(',').includes(join(dir,'compose.public.yaml')),'The running database is not from the public checkout.');
  return {root:dir,project:'mytikas-public',env:join(dir,'.env.public'),compose:join(dir,'compose.public.yaml'),token:join(dir,'.public','tunnel-token')};
}
function assertLiveHost(machine,d,checkpoint) {
  const db=machine.inspect(machine.id(d,'db'));
  const volume=db.Mounts?.find(m=>m.Type==='volume' && m.Destination==='/var/lib/postgresql')?.Name;
  check(db.State.Running && db.Config.Labels['com.docker.compose.project']===d.project && volume,'Active project database and retained volume required.');
  const resolved=JSON.parse(machine.dc(d,['config','--format','json']));
  const expected=resolved.services.db.volumes.find(m=>m.type==='volume' && m.target==='/var/lib/postgresql');
  check(expected && resolved.volumes[expected.source]?.name===volume,'Running database uses a different volume than the deployment configuration.');
  const env=resolved.services.app.environment;
  check(env.DEPLOYMENT_PROFILE==='public' && env.APP_ORIGIN==='https://app.mytikas.monster','Expected the public production application.');
  if(checkpoint)check(checkpoint.project===d.project && checkpoint.volume===volume && checkpoint.commit===release.commit,'Recover the existing rollout checkpoint for the original deployment.');
  else for(const name of ['app','worker','tunnel']) {
    const service=machine.inspect(machine.id(d,name));
    check(service.State.Running && service.Config.Labels['com.docker.compose.project']===d.project,'Run rollout on the active serving host.');
  }
  return {volume,environment:Object.fromEntries(Object.entries(env).map(([key,v])=>[key,String(v).replaceAll('$$','$')]))};
}
function preflightWorker(machine,cfg) {
  const vars=['GITHUB_APP_ID','GITHUB_FORK_INSTALLATION_ID','GITHUB_UPSTREAM_INSTALLATION_ID','GITHUB_APP_PRIVATE_KEY_FILE'];
  const mount=['type=bind','src='+cfg.GITHUB_APP_PRIVATE_KEY_FILE,'dst=/run/secrets/github.pem','readonly'].map(v=>'"'+v.replaceAll('"','""')+'"').join(',');
  try {
    machine.docker(['run','--rm','--user',process.getuid()+':'+process.getgid(),'--read-only','--tmpfs','/tmp','--mount',mount,
      ...vars.flatMap(name=>['-e',name]),cfg.image,'preflight'],{env:{...machine.env,...cfg,GITHUB_APP_PRIVATE_KEY_FILE:'/run/secrets/github.pem'}});
  } catch {
    throw new Error('GitHub App preflight failed. Verify both repo installations, the private key and GitHub connectivity on the active host.');
  }
}
function releaseHealthy(machine,d,candidateId,workerId,cfg) {
  if(!machine.hasSynchronizer(d))return false;
  try {
    const app=machine.inspect(machine.id(d,'app')),worker=machine.inspect(machine.id(d,'synchronizer'));
    const webWorker=machine.inspect(machine.id(d,'worker'));
    return webWorker.Image===candidateId && webWorker.State.Health?.Status==='healthy' &&
      ['GITHUB_APP_ID','GITHUB_FORK_INSTALLATION_ID','GITHUB_UPSTREAM_INSTALLATION_ID'].every(k=>worker.Config.Env.includes(k+'='+cfg[k])) &&
      worker.Mounts.some(m=>m.Source===cfg.GITHUB_APP_PRIVATE_KEY_FILE && m.Destination==='/run/secrets/github.pem' && !m.RW) &&
      app.Image===candidateId && worker.Image===workerId && app.State.Health?.Status==='healthy' &&
      worker.State.Health?.Status==='healthy' && app.Config.Env.includes('ADDON_SUBMISSIONS_ENABLED=1') &&
      machine.inspect(machine.id(d,'tunnel')).State.Running;
  } catch {return false;}
}
function publicHealth(machine,d) {
  const probe=`for(let attempt=0; ; attempt++) {
    try {
      const r=await fetch('https://app.mytikas.monster/api/health',{redirect:'error',signal:AbortSignal.timeout(5000)});
      if(r.ok && (await r.json()).ready===true)break;
    } catch {}
    if(attempt===11)process.exit(1);
    await new Promise(resolve=>setTimeout(resolve,2500));
  }`;
  machine.dc(d,['exec','-T','app','node','--input-type=module','-e',probe],{timeout:100000});
}
async function rolloutCredentials() {
  const options = {image:release.worker,settingsFile};
  if (process.env.GITHUB_APP_PRIVATE_KEY_FILE || fs.existsSync(settingsFile))
    return configureGithubApp(options);
  const registration = await registerApp({dir:dirname(settingsFile)});
  console.log(installationNotice(registration));
  const deadline = Date.now() + 30 * 60 * 1000;
  for (;;) {
    try { return await configureGithubApp(options); }
    catch (error) {
      if (!(error instanceof InstallationPending) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve,15000));
    }
  }
}
async function rollout(machine,d) {
  const stateFile=join(d.root,'.public','addon-rollout.json');
  const saved=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
  const {volume,environment}=assertLiveHost(machine,d,saved);
  const cfg=await rolloutCredentials();
  const candidate=await prepareWeb(machine,d,release.app,release.commit);
  const workerId=verifyImage(machine,release.worker,release.workerCommit);
  if(basename(d.compose)!=='compose.json') {
    const selected=JSON.parse(machine.dc(d,['config','--format','json'],{env:{...machine.env,MYTIKAS_IMAGE:release.app}}));
    check(['migrate','app','worker'].every(s=>selected.services[s]?.image===release.app),'Public checkout cannot select the pinned application image.');
  }
  machine.docker(['run','--rm','--network','none',...Object.keys(environment).flatMap(k=>['-e',k]),release.app,'node','dist/deployment-preflight.js','config'],{env:{...machine.env,...environment}});
  const databaseProbe="import {createPool} from './dist/db.js'; const p=createPool(process.env.DATABASE_URL); try{await p.query('SELECT name,checksum FROM migrations')}finally{await p.end()}";
  machine.docker(['run','--rm','--network',d.project+'_default','-e','DATABASE_URL',release.app,'node','--input-type=module','-e',databaseProbe],{env:{...machine.env,DATABASE_URL:environment.DATABASE_URL}});
  preflightWorker(machine,cfg);
  if(releaseHealthy(machine,d,candidate.id,workerId,cfg)){
    publicHealth(machine,d);
    if(saved)fs.unlinkSync(stateFile);
    console.log('Pinned application and synchronizer already healthy.');return;
  }
  const state=saved || {volume,project:d.project,commit:release.commit,phase:'stopping'};
  if(state.phase==='verified' && machine.inspect(machine.id(d,'app')).State.Running && !Object.hasOwn(machine.migrations(d),'009_addon_submissions.sql')) {
    // The original app resumed accepting writes. Take a fresh recovery point.
    state.phase='stopping';
  }
  if(!saved || state.phase==='stopping')save(stateFile,state);
  if(state.phase==='stopping') {
    const backups=join(machine.home,'backups');
    fs.mkdirSync(backups,{recursive:true,mode:0o700});
    const dir=fs.mkdtempSync(join(backups,'addon-rollout-'));
    try {
      await machine.stop(d);
      await backupForRollout(machine,d,dir);
    } catch(error){
      // No migration has started. Resume precisely the original containers.
      machine.dc(d,['start','--wait','--wait-timeout','180','app','worker'],{timeout:240000});
      if(machine.hasSynchronizer(d))machine.dc(d,['start','synchronizer']);
      machine.dc(d,['start','tunnel']);
      fs.unlinkSync(stateFile);
      throw error;
    }
    state.backup=dir;state.manifestHash=fileDigest(join(dir,'manifest.json')).sha256;state.phase='verified';save(stateFile,state);
    console.log('Verified private recovery snapshot: '+dir);
  }
  if(state.phase==='verified') {
    if(saved && machine.inspect(machine.id(d,'app')).State.Running)await machine.stop(d);
    const manifestFile=join(state.backup,'manifest.json');
    check(fs.existsSync(manifestFile) && fileDigest(manifestFile).sha256===state.manifestHash,'Verified backup manifest is missing or has changed.');
    if(saved) {
      const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
      for(const [name,expected] of Object.entries(manifest.files)) {
        check(name===basename(name) && fileDigest(join(state.backup,name)).sha256===expected.sha256,'Verified recovery files have changed.');
      }
    }
    installWeb(machine,d,release.app,release.commit,candidate);
    state.phase='upgraded';save(stateFile,state);
  }
  check(state.phase==='upgraded','Unrecognized rollout checkpoint.');
  await enable(machine,d,cfg);
  check(releaseHealthy(machine,d,candidate.id,workerId,cfg),'Integrated release health check failed. Rerun rollout after inspecting container status.');
  publicHealth(machine,d);
  fs.unlinkSync(stateFile);
  console.log('Pinned web and synchronizer are healthy. Official submissions enabled. Recovery snapshot: '+state.backup);
}
async function main() {
  const mode=process.argv[2];
  check(['enable','pause','upgrade-managed-web','rollout'].includes(mode),'Usage: node scripts/addon-sync.mjs rollout|enable|pause|upgrade-managed-web APP_IMAGE_DIGEST UPSTREAM_COMMIT');
  fs.mkdirSync(privateDir,{recursive:true,mode:0o700});
  const lock=join(privateDir,'operation.lock');
  fs.mkdirSync(lock,{mode:0o700});
  try {
    const machine=new Machine(privateDir,root);
    await machine.prepare();
    check(['active','idle'].includes(machine.state.phase),'Complete the current host transfer first.');
    const d=mode==='rollout'?activeDeployment(machine):machine.deployment();
    check(!fs.existsSync(join(d.root,'.public','machine-handoff.json')),'Use the currently active host.');
    if(mode==='rollout'){await rollout(machine,d);return;}
    if(mode==='upgrade-managed-web'){await upgradeManagedWeb(machine,d,process.argv[3],process.argv[4]);console.log('Managed web and worker upgraded.');return;}
    if(mode==='enable') await enable(machine,d);
    else {
      check(machine.addons(d),'No archive database configured.');
      const file=machine.addonOverlay(d);
      privateFile(file);
      const overlay=JSON.parse(fs.readFileSync(file,'utf8'));
      overlay.services.app.environment.ADDON_SUBMISSIONS_ENABLED='0';
      if(machine.hasSynchronizer(d)) machine.dc(d,['rm','--stop','--force','synchronizer']);
      delete overlay.services.synchronizer;
      save(file,overlay);
      recreateWeb(machine,d);
    }
    console.log(mode==='enable'?'Synchronizer healthy; moderator submissions enabled.':'Synchronization paused. Archive database retained.');
  } finally {fs.rmdirSync(lock);}
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(e instanceof SyntaxError?'Malformed private settings.':e.message);process.exitCode=1;});
