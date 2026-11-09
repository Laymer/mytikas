import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { canonicalCopy, verifyCopy, remapReport } from '../scripts/utility-coverage.mjs';
const directory=mkdtempSync(join(tmpdir(),'mytikas-public-test-'));
try {
  mkdirSync(join(directory,'scripts'));
  const copy=join(directory,'scripts/public.mjs');
  copyFileSync('scripts/public.mjs',copy);
  const url=pathToFileURL(copy).href;
  const evidence=verifyCopy(url);
  assert(evidence);
  const fixture=()=>({result:[{url,functions:[{functionName:'',ranges:[{startOffset:0,endOffset:readFileSync(copy,'utf8').length,count:1}],isBlockCoverage:true}]}]});
  const map=new Map([[url,evidence]]);
  assert.equal(remapReport(fixture(),map).result[0].url,evidence.canonical);
  assert.throws(()=>remapReport(fixture(),new Map()),/Missing or stale/);
  assert.throws(()=>remapReport(fixture(),new Map([[url,{...evidence,sha256:'wrong'}]])),/Missing or stale/);
  const bad=fixture();bad.result[0].functions[0].ranges[0].endOffset+=1;
  assert.throws(()=>remapReport(bad,map),/range/);
  assert.throws(()=>remapReport({result:[]},map),/malformed/);
  assert.equal(canonicalCopy('node:fs'),null);
  assert.equal(canonicalCopy(pathToFileURL(join(directory,'other.mjs')).href),null);
  appendFileSync(copy,'\n// modified fixture\n');
  assert.throws(()=>verifyCopy(url),/differs/);
  // Mapping remains possible after fixture cleanup, using captured exact-source evidence.
  rmSync(directory,{recursive:true,force:true});
  assert.equal(remapReport({result:[{url,functions:[]}]},map).result[0].url,evidence.canonical);
  console.log('Utility coverage exact-source mapping, stale/missing evidence and malformed-range guards passed.');
} finally {rmSync(directory,{recursive:true,force:true});}
