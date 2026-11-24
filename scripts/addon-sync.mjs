import * as fs from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createPrivateKey, randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Machine } from './machine/core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const privateDir = join(homedir(), '.mytikas');
const settingsFile = join(privateDir, 'integrations', 'addon-sync.json');
function check(value, message) { if (!value) throw new Error(message); }
function privateFile(file) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'Use regular owner-only settings and key files.');
}
function save(file, object) {
  const tmp = file + '.' + randomUUID();
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(object, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
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
function grant(machine, deployment, service, password, archive) {
  const database = archive ? 'mytikas_archive' : 'mytikas_public';
  machine.dc(deployment, ['exec','-T','-e','SYNC_PASSWORD',service,'psql','-X','-q','-U',database,'-d',database,'-v','ON_ERROR_STOP=1','-v','archive='+archive,'-f','-'], {
    input: fs.readFileSync(join(root,'scripts','addon-sync-grants.sql')),
    env: {...machine.env, SYNC_PASSWORD:password}
  });
}
function recreateWeb(machine,d) {
  machine.dc(d,['rm','--stop','--force','tunnel']);
  machine.dc(d,['up','-d','--no-build','--no-deps','--wait','--wait-timeout','180','app']);
  machine.dc(d,['up','-d','--no-deps','tunnel']);
}
async function enable(machine,d) {
  const cfg=settings();
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
  grant(machine,d,'db',password,false);
  grant(machine,d,'archive-db',password,true);
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
  const applied=machine.migrations(d);
  check(Object.hasOwn(applied,'008_account_recovery_email.sql'), 'Complete earlier staged application migrations before upgrading to 009.');
  const source=join(machine.home,'sources',commit);
  await machine.source(commit,source);
  machine.docker(['pull',image],{timeout:300000});
  const tagged='ghcr.io/mytikas-monster/mytikas:'+commit;
  machine.docker(['pull',tagged],{timeout:300000});
  const imageId=ref=>JSON.parse(machine.docker(['image','inspect',ref]))[0].Id;
  check(imageId(image)===imageId(tagged),'The supplied image digest differs from the published commit image.');
  const config=machine.config(d);
  const compose=JSON.parse(fs.readFileSync(d.compose,'utf8'));
  const backup=join(d.root,'compose-before-009-'+commit+'.json');
  if(!fs.existsSync(backup))fs.copyFileSync(d.compose,backup,fs.constants.COPYFILE_EXCL);
  const checkDir=fs.mkdtempSync(join(machine.home,'migrations-'));
  try {
    const expected=machine.imageMigrations(image,checkDir);
    check(Object.hasOwn(expected,'009_addon_submissions.sql') && Object.keys(expected).every(k=>k<='009_addon_submissions.sql') &&
      Object.entries(applied).every(([k,h])=>expected[k]===h),'Candidate must match installed migrations up through 009.');
  } finally {fs.rmSync(checkDir,{recursive:true,force:true});}
  await machine.stop(d);
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
  for(const service of ['app','worker'])compose.services[service].image=image;
  save(d.compose,compose);
  machine.save({active:{...d,commit,imageSelection:image}});
  machine.dc(d,['rm','--stop','--force','tunnel']);
  machine.dc(d,['up','-d','--no-deps','--wait','--wait-timeout','180','app','worker'],{timeout:240000});
  machine.dc(d,['up','-d','--no-deps','tunnel']);
}
async function main() {
  const mode=process.argv[2];
  check(['enable','pause','upgrade-managed-web'].includes(mode),'Usage: node scripts/addon-sync.mjs enable|pause|upgrade-managed-web APP_IMAGE_DIGEST UPSTREAM_COMMIT');
  fs.mkdirSync(privateDir,{recursive:true,mode:0o700});
  const lock=join(privateDir,'operation.lock');
  fs.mkdirSync(lock,{mode:0o700});
  try {
    const machine=new Machine(privateDir,root);
    await machine.prepare();
    check(['active','idle'].includes(machine.state.phase),'Complete the current host transfer first.');
    const d=machine.deployment();
    check(!fs.existsSync(join(d.root,'.public','machine-handoff.json')),'Use the currently active host.');
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
main().catch(e=>{console.error(e instanceof SyntaxError?'Malformed private settings.':e.message);process.exitCode=1;});
