import { readFileSync, writeFileSync } from 'node:fs';
const archive=readFileSync('scripts/machine/archive.mjs','utf8');
const core=readFileSync('scripts/machine/core.mjs','utf8').replace("import { fileDigest, writeZip, inspectZip, extractZip } from './archive.mjs';\n",'');
const launcher=readFileSync('scripts/machine/bootstrap.sh','utf8')+archive+'\n'+core+"\nMYTIKAS_EMBEDDED_MODULE\nnode --input-type=module - \"$@\" < \"$PAYLOAD\"\n";
// stdin module has no file URL; call main explicitly in the generated payload.
const output=launcher.replace('\nMYTIKAS_EMBEDDED_MODULE\nnode',"\nawait main().catch(e => { console.error(e instanceof SyntaxError?'Malformed private JSON; details withheld':e.message); process.exitCode=1; });\nMYTIKAS_EMBEDDED_MODULE\nnode");
if(process.argv.includes('--check')) {
  if(readFileSync('mytikas-machine.sh','utf8')!==output)throw new Error('Regenerate mytikas-machine.sh with node scripts/build-machine.mjs');
} else writeFileSync('mytikas-machine.sh',output,{mode:0o755});
