// Writers and ingress must be drained by the caller before taking this snapshot.
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileDigest } from './machine/archive.mjs';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function write(file, contents) {
  fs.writeFileSync(file, contents, { flag:'wx', mode:0o600, flush:true });
}

function snapshot(file, destination) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    check(fs.fstatSync(fd).isFile(), 'Deployment settings must be regular files.');
    const bytes = fs.readFileSync(fd);
    check(!bytes.includes('PRIVATE KEY-----'), 'Inline private keys cannot be included in a rollout snapshot.');
    write(destination, bytes);
  } finally { fs.closeSync(fd); }
}

function clusterRoles(machine, deployment, item, filename) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try {
    machine.dc(deployment, ['exec','-T',item.service,'pg_dumpall','-U',item.database,'--roles-only'], {
      stdio:['ignore',fd,'pipe'], timeout:120000,
    });
    fs.fsyncSync(fd);
  } finally {fs.closeSync(fd);}
}

function rehearse(machine, items, dir) {
  const label = randomUUID();
  const project = 'mytikas-rehearse-' + label;
  const root = fs.mkdtempSync(join(machine.home,'scratch-'));
  const scratch = { root,project,compose:join(root,'compose.json'),env:join(root,'.env') };
  const owned = ['ps','--all','--no-trunc','--quiet','--filter','label=com.docker.compose.project='+project];
  try {
    check(!machine.docker(owned), 'Scratch database project already exists.');
    const services = Object.fromEntries(items.map(({ service,database,image }) => [service,{
      image, network_mode:'none', labels:{'org.mytikas.rehearsal':label},
      environment:{POSTGRES_USER:database,POSTGRES_DB:database,POSTGRES_HOST_AUTH_METHOD:'trust'},
      healthcheck:{test:['CMD','pg_isready','-h','127.0.0.1','-U',database,'-d',database],interval:'1s',timeout:'3s',retries:120},
    }]));
    // These images create fresh anonymous data volumes. The production mounts are never passed to Compose.
    write(scratch.compose, JSON.stringify({services}));
    write(scratch.env, '');
    try {
      machine.dc(scratch, ['up','-d','--no-build','--pull','never','--wait','--wait-timeout','180'], {timeout:240000});
      for (const item of items) {
        const fd = fs.openSync(join(dir,item.dump),'r');
        try {
          machine.dc(scratch, ['exec','-T',item.service,'pg_restore','-U',item.database,'-d',item.database,
            '--single-transaction','--exit-on-error','--no-owner','--no-privileges'],{stdio:[fd,'pipe','pipe'],timeout:1800000});
        } finally {fs.closeSync(fd);}
        const actual = machine.fingerprint(scratch, item.service === 'archive-db');
        check(actual === item.fingerprint, 'Restored ' + item.database + ' rows or sequences differ from the original database.');
      }
    } finally {
      const ids=machine.docker([...owned,'--filter','label=org.mytikas.rehearsal='+label]).split(/\s+/).filter(Boolean);
      check(ids.every(id => /^[a-f0-9]{64}$/.test(id)), 'Unexpected scratch container identity.');
      if (ids.length) machine.docker(['rm','--force','--volumes',...ids]);
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}

export async function backupForRollout(machine,d,dir) {
  const stat = fs.lstatSync(dir);
  check(fs.realpathSync(dirname(dir)) === fs.realpathSync(join(machine.home,'backups')) &&
    stat.isDirectory() && !(stat.mode & 0o077) && stat.uid === process.getuid() && !fs.readdirSync(dir).length,
    'Use a new, private rollout backup directory.');
  const paired = machine.addons(d);
  const snapshots = { [basename(d.compose)]:d.compose, '.env.public':d.env, 'tunnel-token':d.token };
  if (paired) snapshots['addon-overlay.json']=machine.addonOverlay(d);
  if (fs.existsSync(machine.file)) snapshots['machine.json']=machine.file;
  const settings = join(machine.home,'integrations','addon-sync.json');
  if (fs.existsSync(settings)) snapshots['addon-settings.json']=settings;
  for (const [name,file] of Object.entries(snapshots)) snapshot(file,join(dir,name));

  const services=['app','worker','tunnel','db',...(paired?['archive-db']:[]),...(machine.hasSynchronizer(d)?['synchronizer']:[])];
  const containers={};
  for (const service of services) {
    const container=machine.inspect(machine.id(d,service));
    check(container.Config.Labels?.['com.docker.compose.project']===d.project && /^sha256:[a-f0-9]{64}$/.test(container.Image),
      'Unexpected deployment container for ' + service + '.');
    containers[service]=container;
  }
  const items=[{service:'db',database:'mytikas_public',dump:'database.dump',roles:'database-roles.sql'}];
  if (paired) items.push({service:'archive-db',database:'mytikas_archive',dump:'archive.dump',roles:'archive-roles.sql'});
  for (const item of items) {
    const container=containers[item.service];
    const mount=container.Mounts.find(m=>m.Type==='volume' && m.Destination==='/var/lib/postgresql');
    check(container.State.Running && mount?.Name,'The existing database is unavailable for backup.');
    item.image=container.Image;
    item.volume=mount.Name;
    machine.dump(d,join(dir,item.dump),item.service==='archive-db');
    clusterRoles(machine,d,item,join(dir,item.roles));
    item.fingerprint=machine.fingerprint(d,item.service==='archive-db');
    check(/^[a-f0-9]{64}$/.test(item.fingerprint),'Invalid source database fingerprint.');
  }
  rehearse(machine,items,dir);
  const files={};
  for (const name of fs.readdirSync(dir)) {
    const {sha256,size}=fileDigest(join(dir,name));
    files[name]={sha256,size};
  }
  const manifest={format:1,verifiedAt:new Date().toISOString(),project:d.project,root:d.root,
    images:Object.fromEntries(services.map(s=>[s,containers[s].Image])),snapshots,databases:items,files};
  write(join(dir,'manifest.json'), JSON.stringify(manifest,null,2)+'\n');
  const fd=fs.openSync(dir,'r');
  try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  return manifest;
}
