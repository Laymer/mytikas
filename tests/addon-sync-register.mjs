import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerApp } from '../scripts/addon-sync-register.mjs';

const dir=fs.mkdtempSync(join(tmpdir(),'mytikas-registration-'));
const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const pem=privateKey.export({format:'pem',type:'pkcs1'});
const slug='mytikas-addon-synchronizer';
const reply={id:123,slug,owner:{id:358716068,login:'Mytikas-Monster'},external_url:'https://app.mytikas.monster',
  html_url:'https://github.com/apps/'+slug,permissions:{metadata:'read',actions:'read',contents:'write',pull_requests:'write'},
  events:[],pem,client_secret:'excluded',webhook_secret:'excluded'};
const code='0123456789abcdef0123456789abcdef01234567';
try {
  let attempts=0;
  const meta=await registerApp({dir,fetchImpl:async (url,opts)=>{
    assert.equal(url,'https://api.github.com/app-manifests/'+code+'/conversions');
    assert.equal(opts.method,'POST');
    attempts++;
    return Response.json(attempts===1?{...reply,owner:{...reply.owner,login:'Laymer'}}:
      attempts===2?{...reply,permissions:{...reply.permissions,administration:'write'}}:reply,{status:201});
  },onReady:async origin=>{
    assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
    const {headers,...rest}=await fetch(origin);
    assert.equal(headers.get('Referrer-Policy'),'no-referrer');
    const text=await (await fetch(origin)).text();
    assert.match(text,/organizations\/Mytikas-Monster\/settings\/apps\/new/);
    assert.match(text,/&quot;public&quot;:true/);
    const [,state]=text.match(/state=([a-f0-9]{64})/);
    const callback=origin+'/callback?code='+code+'&state=';
    assert.equal((await fetch(callback+'wrong')).status,403);
    for(let i=0;i<2;i++) {
      assert.equal((await fetch(callback+state)).status,502);
      assert.equal(fs.readdirSync(dir).length,0);
    }
    const success=await fetch(callback+state);
    assert.equal(success.status,200);
    const page=await success.text();
    assert.match(page,/repository_ids%5B%5D=1466605040/);
    assert.match(page,/repository_ids%5B%5D=1469652372/);
    assert.ok(!page.includes(pem) && !page.includes(code));
  }});
  assert.equal(meta.GITHUB_APP_ID,'123');
  assert.equal(fs.readFileSync(meta.GITHUB_APP_PRIVATE_KEY_FILE,'utf8'),pem);
  assert.deepEqual(fs.readdirSync(dir).sort(),['github-app.json','github-app.pem']);
  for(const item of fs.readdirSync(dir)) assert.equal(fs.statSync(join(dir,item)).mode & 0o777,0o600);
  assert.ok(!fs.readFileSync(join(dir,'github-app.json'),'utf8').includes('excluded'));
  assert.deepEqual(await registerApp({dir,onReady:()=>assert.fail('Existing registration started browser')}),meta);
  console.log('Loopback GitHub registration, exclusive key persistence and repeat invocation passed.');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
