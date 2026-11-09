import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import v8ToIstanbul from 'v8-to-istanbul';
import coverageLibrary from 'istanbul-lib-coverage';
import reportLibrary from 'istanbul-lib-report';
import reports from 'istanbul-reports';
// Include every owned browser script, even files never requested during the suite.
const files = (await readdir('public')).filter(name => name.endsWith('.js')).sort();
const map = coverageLibrary.createCoverageMap({});
for (const suite of ['application', 'landing', 'roster']) {
  const raw = JSON.parse(await readFile(`coverage/raw/frontend/${suite}.json`, 'utf8'));
  if (!Array.isArray(raw) || !raw.length) throw new Error(`Missing/empty ${suite} browser coverage`);
  let count = 0;
  for (const entry of raw) {
    if (!entry.url) continue;
    const file = basename(new URL(entry.url).pathname);
    if (!files.includes(file)) continue;
    if (typeof entry.source !== 'string' || !Array.isArray(entry.functions) || !entry.functions.length) throw new Error(`Malformed coverage for ${file}`);
    const path = resolve('public', file);
    if (entry.source !== await readFile(path, 'utf8')) throw new Error(`Coverage/source mismatch for ${file}`);
    for (const fn of entry.functions) {
      if (!Array.isArray(fn.ranges) || !fn.ranges.length || fn.ranges.some(r => !Number.isInteger(r.count) || r.count < 0 || !Number.isInteger(r.startOffset) || !Number.isInteger(r.endOffset) || r.startOffset < 0 || r.endOffset > entry.source.length || r.endOffset < r.startOffset)) throw new Error(`Invalid V8 ranges for ${file}`);
    }
    const converter = v8ToIstanbul(path, 0, { source: entry.source });
    await converter.load();
    converter.applyCoverage(entry.functions);
    map.merge(converter.toIstanbul());
    count++;
  }
  if (!count) throw new Error(`No owned browser files measured by ${suite}`);
}
for (const file of files) {
  const path = resolve('public', file);
  if (map.files().includes(path)) continue;
  const source = await readFile(path, 'utf8');
  const converter = v8ToIstanbul(path, 0, { source });
  await converter.load();
  converter.applyCoverage([{ functionName: '(empty-report)', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] }]);
  map.merge(converter.toIstanbul());
}
await mkdir('coverage/frontend', { recursive: true });
const context = reportLibrary.createContext({ dir: 'coverage/frontend', coverageMap: map });
for (const format of ['text', 'json', 'json-summary', 'html']) reports.create(format).execute(context);
