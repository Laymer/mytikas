import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const directory = mkdtempSync(join(tmpdir(), 'mytikas-public-smoke-'));
const project = `mytikas-public-smoke-${randomBytes(5).toString('hex')}`;
const envfile=join(directory,'env');
writeFileSync(envfile,`POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\nSESSION_SECRET=${randomBytes(48).toString('hex')}\nPUBLIC_UID=${process.getuid()}\nPUBLIC_GID=${process.getgid()}\n`,{mode:0o600});
const env={...process.env};
for(const key of Object.keys(env))if(/^(POSTGRES_|SESSION_|PUBLIC_|DISCORD_|COMPOSE_)/.test(key))delete env[key];
const override=join(directory,'compose.yaml');
writeFileSync(override,`services:\n  app:\n    image: ${project}:test\n  worker:\n    image: ${project}:test\n  migrate:\n    image: ${project}:test\n`);
const base=['compose','-p',project,'--env-file',envfile,'-f',resolve('compose.public.yaml'),'-f',override];
function dc(args, capture=false){
 const r=spawnSync('docker',[...base,...args],{env,encoding:'utf8',stdio:capture?'pipe':'inherit'});
 if(r.status!==0)throw new Error(`Public container smoke failed: ${args[0]}`);
 return r.stdout;
}
try{
 dc(['up','-d','--build','--wait','--wait-timeout','180','app','worker']);
 dc(['exec','-T','app','node','-e',"fetch('http://127.0.0.1:8080/api/health').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())})"]);
 dc(['exec','-T','worker','node','dist/worker-health.js']);
 const containers=dc(['ps','--format','json'],true).trim().split('\n').filter(Boolean).map(JSON.parse);
 for(const c of containers) assert(!c.Publishers?.some(p=>p.PublishedPort>0));
 dc(['exec','-T','db','psql','-U','mytikas_public','-d','mytikas_public','-c',"CREATE TABLE smoke_marker(value text); INSERT INTO smoke_marker VALUES ('persistent');"],true);
 dc(['up','-d','--force-recreate','--wait','--wait-timeout','180','app','worker']);
 const marker=dc(['exec','-T','db','psql','-U','mytikas_public','-d','mytikas_public','-tAc','SELECT value FROM smoke_marker'],true).trim();
 assert.equal(marker,'persistent');
 dc(['exec','-T','worker','node','dist/worker-health.js']);
 if(process.env.IMAGE_ARCHIVE){
  for(const args of [['tag',`${project}:test`,'mytikas-tested:latest'],['save','-o',resolve(process.env.IMAGE_ARCHIVE),'mytikas-tested:latest']]){
   assert.equal(spawnSync('docker',args,{stdio:'inherit'}).status,0);
  }
 }
 console.log('Public Compose app/worker readiness, no published ports, and recreated-container data persistence passed. Tunnel intentionally excluded.');
}finally{
 try{dc(['down','--volumes','--remove-orphans']);}finally{rmSync(directory,{recursive:true,force:true});}
}
