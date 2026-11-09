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
