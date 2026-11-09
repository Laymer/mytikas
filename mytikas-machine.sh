#!/usr/bin/env bash
# Generated standalone launcher; edit scripts/machine/* then run build-machine.mjs.
set -Eeuo pipefail
umask 077
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
COMMAND=${1:-help}
case "$COMMAND" in
  help) printf '%s\n' 'Usage: mytikas-machine.sh prepare|doctor|status|migrate|import ARCHIVE.zip|recover finish-export|recover previous|recover source'; exit 0 ;;
  prepare|doctor|status|migrate|import|recover) ;;
  *) fail 'Unknown command; use help' ;;
esac
MACHINE_HOME="$HOME/.mytikas"
mkdir -p "$MACHINE_HOME/tools"
chmod 700 "$MACHINE_HOME" "$MACHINE_HOME/tools"
SYSTEM=$(uname -s)
[[ $(uname -m) == x86_64 ]] || fail 'This launcher supports Intel macOS and x86_64 WSL2 only'
case "$SYSTEM" in
  Darwin) NODE_OS=darwin; NODE_SHA=d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52 ;;
  Linux) NODE_OS=linux; NODE_SHA=361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9 ;;
  *) fail 'Unsupported operating system' ;;
esac
verify() {
  local actual
  if command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$1");
  else actual=$(sha256sum "$1"); fi
  [[ ${actual%% *} == "$2" ]] || fail 'Downloaded installer checksum mismatch'
}
fetch() { curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --output "$2" "$1"; }
if ! command -v node >/dev/null 2>&1 || [[ $(node -p 'process.versions.node.split(".")[0]') != 24 ]]; then
  NODE_DIR="$MACHINE_HOME/tools/node-v24.22.2-$NODE_OS-x64"
  if [[ ! -x "$NODE_DIR/bin/node" ]]; then
    STAGE=$(mktemp -d "$MACHINE_HOME/tools/node.XXXXXX")
    trap 'rm -rf -- "$STAGE"' EXIT
    fetch "https://nodejs.org/dist/v24.22.2/node-v24.22.2-$NODE_OS-x64.tar.gz" "$STAGE/node.tar.gz"
    verify "$STAGE/node.tar.gz" "$NODE_SHA"
    tar -xzf "$STAGE/node.tar.gz" -C "$STAGE"
    mv "$STAGE/node-v24.22.2-$NODE_OS-x64" "$NODE_DIR"
    rm -rf -- "$STAGE"
    trap - EXIT
  fi
  export PATH="$NODE_DIR/bin:$PATH"
fi
unset DOCKER_HOST DOCKER_CONTEXT
DOCKER=(docker)
if [[ -f "$MACHINE_HOME/machine.json" ]]; then
  SELECTED_CONTEXT=$(node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(s.context)process.stdout.write(s.context)' "$MACHINE_HOME/machine.json")
  if [[ -n $SELECTED_CONTEXT ]]; then DOCKER+=(--context "$SELECTED_CONTEXT"); fi
fi
if [[ $COMMAND != status ]]; then
  if [[ $SYSTEM == Darwin ]]; then
    export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
  fi
  if ! "${DOCKER[@]}" info >/dev/null 2>&1; then
    if [[ $SYSTEM == Linux ]]; then
      fail 'Start Docker Desktop on Windows, select Linux containers, enable Settings > Resources > WSL Integration for this distribution, then rerun this command. Check docker context show and docker info inside WSL.'
    fi
    if [[ ! -d /Applications/Docker.app ]]; then
      INSTALLER="$MACHINE_HOME/tools/Docker-4.98.0-intel.dmg"
      if [[ ! -f "$INSTALLER" ]]; then
        fetch 'https://desktop.docker.com/mac/main/amd64/245422/Docker.dmg' "$INSTALLER.partial"
        verify "$INSTALLER.partial" 96b53f9a4a807b6be6207d18f360b9778ff481e1d94b5027bdf1ae2a22d837cb
        mv "$INSTALLER.partial" "$INSTALLER"
      fi
      verify "$INSTALLER" 96b53f9a4a807b6be6207d18f360b9778ff481e1d94b5027bdf1ae2a22d837cb
      MOUNT=$(mktemp -d "$MACHINE_HOME/tools/docker-mount.XXXXXX")
      hdiutil attach "$INSTALLER" -mountpoint "$MOUNT" -nobrowse -quiet
      trap 'hdiutil detach "$MOUNT" -quiet; rmdir "$MOUNT"' EXIT
      codesign --verify --deep --strict "$MOUNT/Docker.app"
      spctl --assess --type execute "$MOUNT/Docker.app"
      sudo "$MOUNT/Docker.app/Contents/MacOS/install"
      hdiutil detach "$MOUNT" -quiet
      rmdir "$MOUNT"
      trap - EXIT
    fi
    open -a Docker
    printf '%s\n' 'Complete Docker Desktop permissions and terms prompts. Waiting up to 60 seconds; rerun the same command if more time is needed.'
    for ((attempt=0;attempt<12;attempt++)); do
      if "${DOCKER[@]}" info >/dev/null 2>&1; then break; fi
      sleep 5
    done
    "${DOCKER[@]}" info >/dev/null 2>&1 || fail 'Docker Desktop is not ready. Complete its prompts, then rerun this command.'
  fi
fi
export MYTIKAS_LAUNCH_DIR
MYTIKAS_LAUNCH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PAYLOAD=$(mktemp "$MACHINE_HOME/tools/launcher.XXXXXX")
trap 'rm -f -- "$PAYLOAD"' EXIT
# The following source is part of this trusted launcher, never read from the transfer ZIP.
cat > "$PAYLOAD" <<'MYTIKAS_EMBEDDED_MODULE'
// Deliberately narrow ZIP profile: stored regular files, no ZIP64, extras or comments.
// Stream payloads; never use archive names as paths before validating the entire directory.
import { openSync, closeSync, readSync, writeSync, statSync, fsyncSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const table = Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++) n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function scan(fd, start, size, output) {
  const hash=createHash('sha256'), block=Buffer.alloc(1024*1024); let crc=0xffffffff;
  for(let at=0;at<size;) {
    const n=readSync(fd,block,0,Math.min(block.length,size-at),start+at);
    if(!n) throw new Error('Truncated ZIP payload');
    const data=block.subarray(0,n); hash.update(data);
    for(const b of data) crc=table[(crc^b)&255]^(crc>>>8);
    if(output!==undefined) writeSync(output,data); at+=n;
  }
  return {sha256:hash.digest('hex'),crc:(crc^0xffffffff)>>>0,size};
}
export function fileDigest(file) { const fd=openSync(file,'r');try{return scan(fd,0,statSync(file).size);}finally{closeSync(fd);} }
export const archiveNames=['database.dump','configuration.json','images.tar','manifest.json'];
export function writeZip(directory, target) {
  const out=openSync(target,'wx',0o600), central=[]; let offset=0;
  try {
    for(const name of archiveNames) {
      const path=join(directory,name), meta=fileDigest(path), bytes=Buffer.from(name);
      if(meta.size+offset>0xffffff00) throw new Error('Transfer exceeds supported 4 GiB ZIP limit');
      const header=Buffer.alloc(30); header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);
      header.writeUInt32LE(meta.crc,14);header.writeUInt32LE(meta.size,18);header.writeUInt32LE(meta.size,22);header.writeUInt16LE(bytes.length,26);
      writeSync(out,header);writeSync(out,bytes);
      const input=openSync(path,'r');try{scan(input,0,meta.size,out);}finally{closeSync(input);}
      const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(0x0314,4);entry.writeUInt16LE(20,6);
      entry.writeUInt32LE(meta.crc,16);entry.writeUInt32LE(meta.size,20);entry.writeUInt32LE(meta.size,24);entry.writeUInt16LE(bytes.length,28);
      entry.writeUInt32LE((0o100600<<16)>>>0,38);entry.writeUInt32LE(offset,42);central.push(entry,bytes);offset+=30+bytes.length+meta.size;
    }
    const directoryBytes=Buffer.concat(central);writeSync(out,directoryBytes);
    const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(4,8);end.writeUInt16LE(4,10);end.writeUInt32LE(directoryBytes.length,12);end.writeUInt32LE(offset,16);
    writeSync(out,end);fsyncSync(out);
  } finally {closeSync(out);}
}
export function inspectZip(file) {
  const fd=openSync(file,'r'), size=statSync(file).size;
  const read=(offset,length)=>{const b=Buffer.alloc(length);if(readSync(fd,b,0,length,offset)!==length)throw new Error('Truncated ZIP');return b;};
  try {
    if(size<22||size>0xffffffff)throw new Error('Unsupported ZIP size');
    const end=read(size-22,22);
    if(end.readUInt32LE(0)!==0x06054b50||end.readUInt16LE(4)||end.readUInt16LE(6)||end.readUInt16LE(8)!==4||end.readUInt16LE(10)!==4||end.readUInt16LE(20))throw new Error('Unsupported ZIP directory');
    let at=end.readUInt32LE(16), next=0;const entries=[];
    if(at+end.readUInt32LE(12)!==size-22)throw new Error('Invalid ZIP bounds');
    for(let i=0;i<4;i++) {
      const h=read(at,46), len=h.readUInt16LE(28), name=read(at+46,len).toString('utf8');
      if(h.readUInt32LE(0)!==0x02014b50||h.readUInt16LE(8)||h.readUInt16LE(10)||h.readUInt16LE(30)||h.readUInt16LE(32)||h.readUInt16LE(34)||h.readUInt32LE(20)!==h.readUInt32LE(24)||!archiveNames.includes(name)||entries.some(e=>e.name===name)||((h.readUInt32LE(38)>>>16)&0o170000)!==0o100000)throw new Error('Unsafe or unsupported ZIP entry');
      const start=h.readUInt32LE(42), local=read(start,30), bytes=h.readUInt32LE(24);
      if(start!==next||local.readUInt32LE(0)!==0x04034b50||local.readUInt16LE(6)||local.readUInt16LE(8)||local.readUInt16LE(28)||local.readUInt16LE(26)!==len||read(start+30,len).toString('utf8')!==name||local.readUInt32LE(14)!==h.readUInt32LE(16)||local.readUInt32LE(18)!==bytes||local.readUInt32LE(22)!==bytes)throw new Error('Conflicting ZIP entry');
      next=start+30+len+bytes;
      if(next>end.readUInt32LE(16))throw new Error('Overlapping ZIP entry');
      if((name==='manifest.json'||name==='configuration.json')&&bytes>1024*1024)throw new Error('Oversized ZIP metadata');
      const digest=scan(fd,start+30+len,bytes);
      if(digest.crc!==h.readUInt32LE(16))throw new Error('ZIP checksum mismatch');
      entries.push({name,start:start+30+len,...digest});at+=46+len;
    }
    if(next!==end.readUInt32LE(16)||at!==size-22)throw new Error('Trailing ZIP data');
    const json=name=>JSON.parse(read(entries.find(e=>e.name===name).start,entries.find(e=>e.name===name).size));
    return {entries,manifest:json('manifest.json'),configuration:json('configuration.json')};
  } finally {closeSync(fd);}
}
export function extractZip(file, directory, inspected=inspectZip(file)) {
  const input=openSync(file,'r');try {for(const e of inspected.entries) {
    const out=openSync(join(directory,e.name),'wx',0o600);
    try {const actual=scan(input,e.start,e.size,out);if(actual.sha256!==e.sha256)throw new Error('Archive changed during extraction');fsyncSync(out);}finally{closeSync(out);}
  }}finally{closeSync(input);}
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const origin='https://app.mytikas.monster';
const fields=['POSTGRES_PASSWORD','RUNTIME_DATABASE_PASSWORD','SESSION_SECRET','DISCORD_WEBHOOK_URL','PUBLIC_UID','PUBLIC_GID','EMAIL_OUTBOX_KEY','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','EMAIL_FROM'];
const ensure=(condition,message)=>{if(!condition)throw new Error(message);};
export function configuration(text, token) {
  const values={};
  for(const line of text.split('\n')) {
    if(!line.trim()||line.trim().startsWith('#'))continue;
    const match=/^([A-Z_]+)=(.*)$/.exec(line);
    ensure(match&&fields.includes(match[1])&&!Object.hasOwn(values,match[1]),'Unsupported or duplicate public configuration'); values[match[1]]=match[2];
  }
  return validateConfiguration({...values,tunnelToken:token.trim()});
}
export function validateConfiguration(c) {
  ensure(c&&typeof c==='object'&&!Array.isArray(c)&&Object.keys(c).every(k=>[...fields,'tunnelToken'].includes(k)),'Invalid configuration keys');
  for(const key of ['POSTGRES_PASSWORD','RUNTIME_DATABASE_PASSWORD'])ensure(/^[a-f0-9]{64}$/.test(c[key]),'Invalid database credential format');
  ensure(/^[a-f0-9]{96}$/.test(c.SESSION_SECRET),'Invalid session secret format');
  for(const key of ['PUBLIC_UID','PUBLIC_GID'])ensure(/^\d{1,10}$/.test(c[key]),'Invalid host identity');
  ensure(typeof c.DISCORD_WEBHOOK_URL==='string'&&(c.DISCORD_WEBHOOK_URL===''||/^https:\/\/(?:discord.com|discordapp.com)\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/.test(c.DISCORD_WEBHOOK_URL)),'Invalid Discord webhook');
  ensure(typeof c.tunnelToken==='string'&&/^[A-Za-z0-9+/=_-]{20,16384}$/.test(c.tunnelToken),'Invalid tunnel connector token');
  if(c.EMAIL_OUTBOX_KEY)ensure(/^[a-f0-9]{64}$/i.test(c.EMAIL_OUTBOX_KEY),'Invalid email encryption key');
  for(const key of ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','EMAIL_FROM'])if(c[key]!==undefined)ensure(typeof c[key]==='string'&&!/[\r\n\0]/.test(c[key]),'Invalid mail configuration');
  return c;
}
export function validateTransfer(info) {
  const m=info.manifest;
  ensure(m?.format===1&&/^[a-f0-9]{32}$/.test(m.lineage)&&/^[a-f0-9]{32}$/.test(m.id)&&Number.isSafeInteger(m.generation)&&m.generation>0&&/^[a-f0-9]{40}$/.test(m.commit),'Invalid transfer identity');
  ensure(m.platform==='linux/amd64','Transfer requires linux/amd64 images');
  ensure(m.images&&['app','db','tunnel'].every(k=>/^sha256:[a-f0-9]{64}$/.test(m.images[k])),'Invalid image identities');
  ensure(m.migrations&&Object.keys(m.migrations).length>0&&Object.entries(m.migrations).every(([n,h])=>/^[a-zA-Z0-9_-]+\.sql$/.test(n)&&/^[a-f0-9]{64}$/.test(h)),'Invalid migration checksums');
  ensure(typeof m.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(m.fingerprint),'Invalid data fingerprint');
  for(const e of info.entries.filter(e=>e.name!=='manifest.json'))ensure(m.files?.[e.name]?.sha256===e.sha256&&m.files[e.name].size===e.size,'Transfer file hash mismatch');
  validateConfiguration(info.configuration);return m;
}
function privateDirectory(dir) {fs.mkdirSync(dir,{recursive:true,mode:0o700});ensure(fs.lstatSync(dir).isDirectory()&&(fs.statSync(dir).mode&0o077)===0,'Machine directories must be private (700)');}
function atomic(file,value) {const tmp=file+'.new';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});const fd=fs.openSync(tmp,'r');fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(tmp,file);const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
function readJSON(file,fallback) {return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export class Machine {
  constructor(home=path.join(homedir(),'.mytikas'),root=process.env.MYTIKAS_LAUNCH_DIR||process.cwd()) {
    this.home=home;this.root=root;privateDirectory(home);this.file=path.join(home,'machine.json');this.state=readJSON(this.file,{version:1,highest:0,phase:'idle'});
    this.env={...process.env};for(const k of Object.keys(this.env))if(/^(DOCKER_HOST$|DOCKER_CONTEXT$|COMPOSE_|POSTGRES_|PG|DATABASE_|RUNTIME_DATABASE_|SESSION_|APP_ORIGIN$|PUBLIC_|DISCORD_|MYTIKAS_|DEPLOYMENT_PROFILE$|INGRESS_MODE$)/.test(k))delete this.env[k];
  }
  save(patch) {Object.assign(this.state,patch);atomic(this.file,this.state);}
  run(binary,args,options={}) {
    const r=spawnSync(binary,args,{env:this.env,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024,timeout:120000,...options});
    ensure(!r.error&&r.status===0,`${binary} operation failed (${args[0] || 'command'}); details withheld to protect private data`);return (r.stdout||'').toString().trim();
  }
  docker(args,options) {return this.run('docker',['--context',this.state.context,...args],options);}
  async prepare() {
    let context=this.state.context;
    if(!context)context=this.run('docker',['context','show']);
    const endpoint=JSON.parse(this.run('docker',['context','inspect',context]))[0]?.Endpoints?.docker?.Host;
    ensure(typeof endpoint==='string'&&endpoint.startsWith('unix://'),'Use a local Docker Unix-socket context; remote engines are not supported');
    this.state.context=context;
    const info=JSON.parse(this.docker(['info','--format','{{json .}}']));
    ensure(info.OSType==='linux'&&['x86_64','amd64'].includes(info.Architecture),'A local linux/amd64 Docker engine is required');
    this.docker(['compose','version']);this.save({context});
  }
  deployment() {
    if(this.state.active)return this.state.active;
    ensure(fs.existsSync(path.join(this.root,'compose.public.yaml')),'No managed deployment or public checkout here');
    return {root:this.root,project:'mytikas-public',compose:path.join(this.root,'compose.public.yaml'),env:path.join(this.root,'.env.public'),token:path.join(this.root,'.public/tunnel-token')};
  }
  dc(d,args,options) {return this.docker(['compose','--project-name',d.project,'--env-file',d.env,'-f',d.compose,...args],{cwd:d.root,...options});}
  id(d,service) {const id=this.dc(d,['ps','-a','-q',service]);ensure(/^[a-f0-9]{12,64}$/.test(id),'Expected one public service container');return id;}
  inspect(id) {return JSON.parse(this.docker(['inspect',id]))[0];}
  config(d) {
    for(const f of [d.env,d.token])ensure(fs.lstatSync(f).isFile()&&(fs.statSync(f).mode&0o077)===0,'Public configuration/token must be regular private files (600)');
    return configuration(fs.readFileSync(d.env,'utf8'),fs.readFileSync(d.token,'utf8'));
  }
  space(dir,bytes) {const s=fs.statfsSync(dir);ensure(s.bavail*s.bsize>bytes,'Insufficient host free disk space');}
  engineSpace(image,bytes) {
    const free=Number(this.docker(['run','--rm','--network','none','--entrypoint','sh',image,'-c',"df -Pk / | awk 'NR==2 {print $4}'"]));
    ensure(Number.isFinite(free)&&free*1024>bytes,'Insufficient Docker engine free disk space');
  }
  sql(d,query) {return this.dc(d,['exec','-T','db','psql','-X','-A','-t','-U','mytikas_public','-d','mytikas_public','-v','ON_ERROR_STOP=1','-c',query]);}
  fingerprint(d) {
    // Hash every table row in canonical order, including leases, sessions and history; sequences too.
    const tables=JSON.parse(this.sql(d,"SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public'"));
    const h=crypto.createHash('sha256');
    for(const name of tables) {ensure(/^[a-z_][a-z0-9_]*$/.test(name),'Unexpected table name');h.update(name);h.update(this.sql(d,`SELECT count(*)::text || ':' || md5(coalesce(string_agg(h, '' ORDER BY h),'')) FROM (SELECT md5(row_to_json(t)::text) h FROM "${name}" t) x`));}
    h.update(this.sql(d,"SELECT coalesce(json_agg(t ORDER BY sequencename)::text,'[]') FROM (SELECT sequencename,last_value,start_value,increment_by,min_value,max_value,cycle FROM pg_sequences WHERE schemaname='public') t"));return h.digest('hex');
  }
  migrations(d) {return JSON.parse(this.sql(d,"SELECT json_object_agg(name,checksum ORDER BY name) FROM migrations"));}
  imageMigrations(image,dir) {
    const id=this.docker(['create','--network','none',image]);
    try {this.docker(['cp',`${id}:/app/migrations`,dir]);}finally{this.docker(['rm',id]);}
    return Object.fromEntries(fs.readdirSync(path.join(dir,'migrations')).filter(n=>n.endsWith('.sql')).sort().map(n=>[n,fileDigest(path.join(dir,'migrations',n)).sha256]));
  }
  equal(a,b,message) {ensure(JSON.stringify(a)===JSON.stringify(b),message);}
  dump(d,file) {const fd=fs.openSync(file,'wx',0o600);try{this.dc(d,['exec','-T','db','pg_dump','-U','mytikas_public','-d','mytikas_public','-Fc'],{stdio:['ignore',fd,'pipe'],timeout:1800000});fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  backupPrevious(d,file) {
    this.config(d);
    const compose=JSON.parse(this.dc(d,['config','--format','json']));
    const mounts=compose.services?.db?.volumes?.filter(v=>v.type==='volume'&&v.target==='/var/lib/postgresql')||[];
    const volume=mounts.length===1&&compose.volumes?.[mounts[0].source]?.name;
    ensure(typeof volume==='string'&&volume.length>0,'Previous database must use its existing named PostgreSQL volume');
    let existing;
    try {existing=JSON.parse(this.docker(['volume','inspect',volume]));}
    catch {throw new Error('Previous database volume is unavailable; refusing to initialize an empty replacement');}
    ensure(existing.length===1&&existing[0].Name===volume,'Previous database volume is missing; refusing to initialize an empty replacement');
    const id=this.dc(d,['ps','-a','-q','db']);
    if(!id||!this.inspect(id).State.Running)
      this.dc(d,['up','-d','--no-deps','--no-recreate','--wait','--wait-timeout','180','db'],{timeout:240000});
    this.dump(d,file);
  }
  async stop(d) {
    this.dc(d,['stop','--timeout','45','tunnel']);
    this.dc(d,['stop','--timeout','45','app','worker'],{timeout:100000});
    for(const s of ['app','worker']) {const i=this.inspect(this.id(d,s));ensure(!i.State.Running&&!i.State.OOMKilled&&i.State.ExitCode===0,`${s} did not drain cleanly; export aborted, traffic remains stopped`);}
  }
  writeDeployment(dir,c,m,project) {
    privateDirectory(dir);privateDirectory(path.join(dir,'.public'));
    const env=path.join(dir,'.env.public'),token=path.join(dir,'.public/tunnel-token');
    const local={...c,PUBLIC_UID:String(process.getuid()),PUBLIC_GID:String(process.getgid())};
    fs.writeFileSync(env,fields.map(k=>`${k}=${local[k]??''}`).join('\n')+'\n',{mode:0o600});fs.writeFileSync(token,c.tunnelToken,{mode:0o600});
    const environment={NODE_ENV:'production',DEPLOYMENT_PROFILE:'public',MYTIKAS_DEMO:'0',INGRESS_MODE:'cloudflare-loopback',DATABASE_URL:`postgres://mytikas_runtime:${c.RUNTIME_DATABASE_PASSWORD}@db:5432/mytikas_public`,SESSION_SECRET:c.SESSION_SECRET,APP_ORIGIN:origin,PUBLIC_SITE_ORIGIN:'https://mytikas.monster',PORT:'8080',DISCORD_WEBHOOK_URL:c.DISCORD_WEBHOOK_URL,...Object.fromEntries(['EMAIL_OUTBOX_KEY','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','EMAIL_FROM'].map(k=>[k,c[k]||'']))};
    const backend={image:m.images.app,init:true,environment,restart:'unless-stopped',stop_grace_period:'45s'};
    const compose={services:{
      db:{image:m.images.db,environment:{POSTGRES_USER:'mytikas_public',POSTGRES_DB:'mytikas_public',POSTGRES_PASSWORD:c.POSTGRES_PASSWORD},volumes:['data:/var/lib/postgresql'],restart:'unless-stopped',healthcheck:{test:['CMD-SHELL','pg_isready -U mytikas_public -d mytikas_public'],interval:'3s',timeout:'3s',retries:60}},
      app:{...backend,healthcheck:{test:['CMD','node','-e',"fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:'3s',timeout:'5s',retries:60}},
      worker:{...backend,command:['node','dist/worker.js'],healthcheck:{test:['CMD','node','dist/worker-health.js'],interval:'3s',timeout:'5s',retries:60}},
      tunnel:{image:m.images.tunnel,user:`${local.PUBLIC_UID}:${local.PUBLIC_GID}`,network_mode:'service:app',command:['tunnel','--no-autoupdate','run','--token-file','/run/secrets/tunnel_token'],secrets:['tunnel_token'],read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],restart:'unless-stopped'}
    },secrets:{tunnel_token:{file:token}},volumes:{data:{}}};
    const file=path.join(dir,'compose.json');atomic(file,compose);return {root:dir,project,compose:file,env,token};
  }
  async restore(d,dir,c,source) {
    this.dc(d,['up','-d','--no-deps','--wait','--wait-timeout','180','db'],{timeout:240000});
    const fd=fs.openSync(path.join(dir,'database.dump'),'r');
    try {this.dc(d,['exec','-T','db','pg_restore','-U','mytikas_public','-d','mytikas_public','--single-transaction','--exit-on-error','--no-owner','--no-privileges'],{stdio:[fd,'pipe','pipe'],timeout:1800000});}finally{fs.closeSync(fd);}
    // Copy only fixed-repository SQL, never an archive-supplied script.
    const id=this.id(d,'db');this.docker(['exec',id,'mkdir','-p','/scripts']);
    for(const name of ['public-runtime-role.sql','runtime-grants.sql'])this.docker(['cp',path.join(source,'scripts',name),`${id}:/scripts/${name}`]);
    this.dc(d,['exec','-T','-e','RUNTIME_DATABASE_PASSWORD','db','psql','-X','-q','-U','mytikas_public','-d','mytikas_public','-v','ON_ERROR_STOP=1','-f','/scripts/public-runtime-role.sql'],{env:{...this.env,RUNTIME_DATABASE_PASSWORD:c.RUNTIME_DATABASE_PASSWORD}});
  }
  async source(commit,dir) {
    if(fs.existsSync(path.join(dir,'.complete')) && fs.readFileSync(path.join(dir,'.complete'),'utf8')===commit)return;
    fs.rmSync(dir,{recursive:true,force:true});privateDirectory(dir);
    // Source host/repository are fixed; no archive-supplied URL is used.
    ensure(/^[a-f0-9]{40}$/.test(commit),'Invalid source commit');
    const archive=path.join(dir,'source.tar.gz');
    this.run('curl',['--fail','--location','--silent','--show-error','--proto','=https','--tlsv1.2','--output',archive,`https://codeload.github.com/Laymer/mytikas/tar.gz/${commit}`],{timeout:300000});
    this.run('tar',['-xzf',archive,'--strip-components=1','-C',dir]);
    fs.unlinkSync(archive);
    ensure(fs.existsSync(path.join(dir,'scripts/public-runtime-role.sql'))&&fs.existsSync(path.join(dir,'scripts/runtime-grants.sql'))&&fs.existsSync(path.join(dir,'migrations')),'Source lacks required restore files');
    fs.writeFileSync(path.join(dir,'.complete'),commit,{mode:0o600});
  }
  async publicCheck() {
    for(const endpoint of ['/api/health','/api/availability','/']) {
      const r=await fetch(origin+endpoint,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});ensure(r.ok,'Public HTTPS readiness/availability failed');
      if(endpoint!=='/')ensure((await r.json()).ready===true,'Public readiness response mismatch');
    }
    const r=await fetch(origin+'/api/auth/me',{redirect:'error',signal:AbortSignal.timeout(15000)});
    ensure(r.ok,'Public session check failed');const cookie=r.headers.get('set-cookie')||'';
    ensure(/;\s*Secure/i.test(cookie)&&/;\s*HttpOnly/i.test(cookie)&&/;\s*SameSite=Lax/i.test(cookie),'Secure public session cookie check failed');
  }
  async migrate() {
    ensure(['idle','active'].includes(this.state.phase),'Migration is already pending or this machine handed off; use status/recovery');
    const d=this.deployment(),c=this.config(d);this.dc(d,['config','--quiet']);
    const containers=Object.fromEntries(['app','worker','db','tunnel'].map(s=>[s,this.inspect(this.id(d,s))]));
    for(const [s,i] of Object.entries(containers))ensure(i.State.Running&&i.Config.Labels?.['com.docker.compose.project']===d.project,`${s} is not running in the public project`);
    ensure(containers.app.Image===containers.worker.Image,'App and worker images differ');
    const actualEnv=Object.fromEntries(containers.app.Config.Env.map(v=>{const n=v.indexOf('=');return[v.slice(0,n),v.slice(n+1)];}));
    ensure(actualEnv.DEPLOYMENT_PROFILE==='public'&&actualEnv.APP_ORIGIN===origin&&actualEnv.SESSION_SECRET===c.SESSION_SECRET&&actualEnv.DISCORD_WEBHOOK_URL===c.DISCORD_WEBHOOK_URL&&actualEnv.DATABASE_URL===`postgres://mytikas_runtime:${c.RUNTIME_DATABASE_PASSWORD}@db:5432/mytikas_public`,'Running application configuration differs from public secrets');
    for(const key of ['EMAIL_OUTBOX_KEY','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','EMAIL_FROM'])ensure((actualEnv[key]||'')===(c[key]||''),'Running mail configuration differs from public secrets');
    const workerEnv=Object.fromEntries(containers.worker.Config.Env.map(v=>{const n=v.indexOf('=');return[v.slice(0,n),v.slice(n+1)];}));
    for(const key of ['DATABASE_URL','SESSION_SECRET','DISCORD_WEBHOOK_URL','DEPLOYMENT_PROFILE','APP_ORIGIN','EMAIL_OUTBOX_KEY','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','EMAIL_FROM'])ensure(workerEnv[key]===actualEnv[key],'Worker configuration differs from web runtime');
    ensure(containers.db.Config.Env.includes(`POSTGRES_PASSWORD=${c.POSTGRES_PASSWORD}`),'Running database credentials differ');
    const images=Object.fromEntries(['app','db','tunnel'].map(s=>[s,containers[s].Image]));let size=0;
    for(const image of Object.values(images)) {const i=JSON.parse(this.docker(['image','inspect',image]))[0];ensure(i.Os==='linux'&&i.Architecture==='amd64','Only linux/amd64 images can move between these machines');size+=i.Size;}
    const dbSize=Number(this.sql(d,"SELECT pg_database_size('mytikas_public')"));
    ensure(size+dbSize*2<0xf0000000,'Transfer may exceed supported 4 GiB ZIP limit');this.space(this.home,3*(size+dbSize)+1024**3);this.engineSpace(images.db,dbSize*3+1024**3);
    const id=crypto.randomBytes(16).toString('hex'),dir=path.join(this.home,'exports',id);privateDirectory(dir);
    const commit=this.state.active?.commit||this.run('git',['-C',d.root,'rev-parse','HEAD']);ensure(/^[a-f0-9]{40}$/.test(commit),'Invalid source commit');
    const source=path.join(this.home,'sources',commit);await this.source(commit,source);
    const migrations=this.migrations(d);this.equal(this.imageMigrations(images.app,dir),migrations,'Running image migration checksums differ from database');
    const sourceMigrations=Object.fromEntries(fs.readdirSync(path.join(source,'migrations')).filter(n=>n.endsWith('.sql')).sort().map(n=>[n,fileDigest(path.join(source,'migrations',n)).sha256]));this.equal(sourceMigrations,migrations,'Recorded source migrations differ from runtime; choose a matching source before exporting');
    // Read-only public probes here; cookie check is deferred to activation.
    const health=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(15000)});ensure(health.ok,'Public preflight failed');
    this.save({phase:'export-stopping',active:d,export:{id,dir},lineage:this.state.lineage||crypto.randomBytes(16).toString('hex')});
    atomic(path.join(d.root,'.public','machine-handoff.json'),{phase:'stopped',state:this.file});
    await this.stop(d);this.save({phase:'export-stopped'});
    this.dump(d,path.join(dir,'database.dump'));const fingerprint=this.fingerprint(d);
    const m={format:1,id,lineage:this.state.lineage,generation:this.state.highest+1,commit,platform:'linux/amd64',images,migrations,fingerprint,files:{}};
    const validation=this.writeDeployment(path.join(dir,'validation'),c,m,'mytikas-verify-'+id);
    try {await this.restore(validation,dir,c,source);this.equal(this.fingerprint(validation),fingerprint,'Isolated restore data fingerprint mismatch');this.equal(this.migrations(validation),migrations,'Isolated restore schema mismatch');}
    finally {this.dc(validation,['down','--volumes']);}
    atomic(path.join(dir,'configuration.json'),c);
    this.docker(['image','save','-o',path.join(dir,'images.tar'),...new Set(Object.values(images))],{timeout:1800000});fs.chmodSync(path.join(dir,'images.tar'),0o600);
    for(const name of ['database.dump','configuration.json','images.tar']) {const f=fileDigest(path.join(dir,name));m.files[name]={sha256:f.sha256,size:f.size};}
    atomic(path.join(dir,'manifest.json'),m);
    const target=path.join(this.home,`mytikas-${new Date().toISOString().replace(/[:.]/g,'-')}-${id}.zip`);
    writeZip(dir,target+'.partial');validateTransfer(inspectZip(target+'.partial'));
    this.save({phase:'export-packaged',export:{id,dir,target,generation:m.generation}});
    await this.finishExport();
  }
  async finishExport() {
    const e=this.state.export;ensure(this.state.phase==='export-packaged','No validated export to finalize');
    // Removal, not just stop: restart policies cannot revive handed-off containers.
    this.dc(this.state.active,['down']);
    if(fs.existsSync(e.target+'.partial'))fs.renameSync(e.target+'.partial',e.target);
    this.save({phase:'handed-off',highest:e.generation});
    console.log(`Hosting stopped. Private transfer: ${e.target}`);
  }
  async import(file) {
    ensure(file,'Usage: import /path/to/archive.zip');file=path.resolve(file);
    const info=inspectZip(file),m=validateTransfer(info),c=info.configuration;
    if(this.state.transfer?.id===m.id&&this.state.phase==='active'){console.log('This transfer is already active.');return;}
    const resuming=this.state.transfer?.id===m.id&&this.state.phase.startsWith('import-');
    ensure(resuming||['idle','active','handed-off'].includes(this.state.phase),'Another operation needs recovery first');
    ensure(!this.state.lineage||this.state.lineage===m.lineage,'Unrelated deployment lineage; use a separate machine account');
    ensure(resuming||m.generation>this.state.highest,'Stale transfer rejected');
    if(resuming)this.equal(m,this.state.transfer.manifest,'Resumed archive differs from recorded transfer');
    const dir=resuming?this.state.transfer.dir:path.join(this.home,'generations',m.id+'-'+crypto.randomBytes(6).toString('hex'));
    if(!resuming) {
      // A retry reuses the staged files; do not demand space for a second extraction.
      this.space(this.home,info.entries.reduce((n,e)=>n+e.size,0)*3+1024**3);
      privateDirectory(dir);extractZip(file,dir,info);
      const source=path.join(this.home,'sources',m.commit);await this.source(m.commit,source);
      this.docker(['image','load','-i',path.join(dir,'images.tar')],{timeout:1800000});
      for(const image of Object.values(m.images)) {const i=JSON.parse(this.docker(['image','inspect',image]))[0];ensure(i.Id===image&&i.Os==='linux'&&i.Architecture==='amd64','Loaded image identity/platform mismatch');}
      this.equal(this.imageMigrations(m.images.app,dir),m.migrations,'Loaded image schema mismatch');
      const sourceMigrations=Object.fromEntries(fs.readdirSync(path.join(source,'migrations')).filter(n=>n.endsWith('.sql')).sort().map(n=>[n,fileDigest(path.join(source,'migrations',n)).sha256]));
      this.equal(sourceMigrations,m.migrations,'Recorded source schema differs from transfer');
      this.engineSpace(m.images.db,info.entries.find(e=>e.name==='database.dump').size*5+1024**3);
      let previous=this.state.active;
      if(!previous&&fs.existsSync(path.join(this.root,'.env.public')))previous=this.deployment();
      if(previous&&this.state.phase!=='handed-off') {
        this.backupPrevious(previous,path.join(dir,'destination-safety.dump'));
      }
      const next=this.writeDeployment(path.join(dir,'deployment'),c,m,'mytikas-gen-'+m.id);
      next.commit=m.commit;
      // Refuse collisions rather than attaching credentials to an existing project/volume.
      ensure(!this.docker(['ps','-aq','--filter',`label=com.docker.compose.project=${next.project}`]),'Destination project already exists');
      ensure(!this.docker(['volume','ls','-q','--filter',`label=com.docker.compose.project=${next.project}`]),'Destination volume already exists');
      this.save({phase:'import-stopping',previous,transfer:{id:m.id,dir,manifest:m,source,next,writers:false},lineage:m.lineage});
    }
    const t=this.state.transfer;
    if(this.state.phase==='import-stopping') {
      if(this.state.previous&&this.state.active&&this.state.highest<m.generation) {
        // A handed-off source has no containers; do not try to stop it again.
        if(this.dc(this.state.previous,['ps','-a','-q','app']))await this.stop(this.state.previous);
      } else if(this.state.previous&&this.dc(this.state.previous,['ps','-a','-q','app']))await this.stop(this.state.previous);
      this.save({phase:'import-restoring'});
    }
    if(this.state.phase==='import-restoring') {
      // A failed restore is discarded only in this fresh, never-writable staging project.
      this.dc(t.next,['down','--volumes']);
      await this.restore(t.next,t.dir,c,t.source);
      this.equal(this.migrations(t.next),m.migrations,'Restored migration checksums differ');this.equal(this.fingerprint(t.next),m.fingerprint,'Restored data fingerprint differs');
      this.dc(t.next,['up','-d','--no-deps','--wait','--wait-timeout','180','app'],{timeout:240000});
      // Validate mount permissions as the connector UID using the saved PostgreSQL image.
      this.docker(['run','--rm','--network','none','--user',`${process.getuid()}:${process.getgid()}`,'--mount',`type=bind,src=${t.next.token},dst=/token,readonly`,'--entrypoint','sh',m.images.db,'-c','test -r /token && test -s /token']);
      this.save({phase:'import-verified'});
    }
    if(this.state.phase==='import-verified') {
      // Durable write barrier BEFORE a worker can start; crash ambiguity is treated as writes.
      t.writers=true;this.save({phase:'import-writers',highest:m.generation,transfer:t});
    }
    if(this.state.phase==='import-writers') {
      this.dc(t.next,['up','-d','--no-deps','--wait','--wait-timeout','180','app','worker'],{timeout:240000});
      this.dc(t.next,['exec','-T','worker','node','dist/worker-health.js']);
      this.save({phase:'import-tunnel'});
    }
    if(this.state.phase==='import-tunnel') {
      this.dc(t.next,['up','-d','--no-deps','--wait','--wait-timeout','180','app','worker'],{timeout:240000});
      this.dc(t.next,['up','-d','--no-deps','tunnel']);
      let error;for(let n=0;n<12;n++){try{await this.publicCheck();error=null;break;}catch(e){error=e;await sleep(5000);}}if(error)throw error;
      this.save({phase:'active',active:t.next,highest:m.generation});console.log('Imported runtime is active; public HTTPS and worker heartbeat verified. Prior volumes retained.');
    }
  }
  async recover(command) {
    if(command==='finish-export')return this.finishExport();
    if(command==='source') {
      ensure(['export-stopping','export-stopped'].includes(this.state.phase),'Source recovery is allowed only before a usable archive is published');
      const d=this.state.active;
      this.dc(d,['up','-d','--no-deps','--wait','--wait-timeout','180','db','app','worker'],{timeout:240000});
      this.dc(d,['up','-d','--no-deps','tunnel']);fs.rmSync(path.join(d.root,'.public','machine-handoff.json'),{force:true});this.save({phase:'active'});return;
    }
    ensure(command==='previous','Usage: recover finish-export|previous|source');
    ensure((this.state.phase.startsWith('import-')||this.state.phase==='recovery-starting')&&!this.state.transfer.writers,'Previous deployment recovery is forbidden after the write barrier; export the destination instead');
    ensure(this.state.previous,'No previous destination deployment recorded');
    this.dc(this.state.transfer.next,['down']);
    this.save({phase:'recovery-starting',highest:Math.max(this.state.highest,this.state.transfer.manifest?.generation||0)});
    this.dc(this.state.previous,['up','-d','--no-deps','--wait','--wait-timeout','180','db','app','worker'],{timeout:240000});this.dc(this.state.previous,['up','-d','--no-deps','tunnel']);
    fs.rmSync(path.join(this.state.previous.root,'.public','machine-handoff.json'),{force:true});
    this.save({phase:'active',active:this.state.previous,transfer:null});
  }
  async failureStop() {
    if(this.state.phase.startsWith('import-')&&this.state.transfer) {
      try {this.dc(this.state.transfer.next,['stop','--timeout','45','tunnel','worker','app'],{timeout:150000});}catch{/* Preserve original error and checkpoint. */}
    }
  }
}
export async function main(args=process.argv.slice(2)) {
  const [command='help',arg,...extra]=args;
  if(command==='help'){console.log('Usage: mytikas-machine.sh prepare|doctor|status|migrate|import ARCHIVE.zip|recover finish-export|recover previous\nPrivate state: ~/.mytikas. No command removes prior deployment volumes.');return;}
  ensure(['prepare','doctor','status','migrate','import','recover'].includes(command)&&!extra.length&&(['import','recover'].includes(command)?!!arg:!arg),'Invalid arguments; use help');
  const machine=new Machine();
  if(command==='status'){console.log(JSON.stringify({phase:machine.state.phase,context:machine.state.context,project:machine.state.active?.project,generation:machine.state.highest,transfer:machine.state.transfer?.id,writers:machine.state.transfer?.writers},null,2));return;}
  const lock=path.join(machine.home,'operation.lock');
  try{fs.mkdirSync(lock,{mode:0o700});}catch{throw new Error('Another operation owns ~/.mytikas/operation.lock; after verifying no launcher is running, remove that empty directory to resume');}
  try {
    // Re-read under the lock: another process may have finished while we were starting.
    machine.state=readJSON(machine.file,{version:1,highest:0,phase:'idle'});
    await machine.prepare();
    if(command==='prepare')console.log('Local Docker and Node prerequisites ready.');
    else if(command==='doctor'){const d=machine.deployment();machine.config(d);machine.dc(d,['config','--quiet']);console.log('Local Docker context and private public configuration verified.');}
    else if(command==='migrate')await machine.migrate();
    else if(command==='import')await machine.import(arg);
    else await machine.recover(arg);
  }catch(error){await machine.failureStop();throw error;}finally{fs.rmdirSync(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e instanceof SyntaxError?'Malformed private JSON; details withheld':e.message);process.exitCode=1;});

await main().catch(e => { console.error(e instanceof SyntaxError?'Malformed private JSON; details withheld':e.message); process.exitCode=1; });
MYTIKAS_EMBEDDED_MODULE
node --input-type=module - "$@" < "$PAYLOAD"
