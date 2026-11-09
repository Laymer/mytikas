import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function canonicalCopy(url) {
  if (!url.startsWith('file:')) return null;
  const path = fileURLToPath(url);
  if (dirname(path) === join(root, 'scripts')) return null;
  if (basename(dirname(path)) !== 'scripts') return null;
  const fixture = basename(dirname(dirname(path)));
  const name = basename(path);
  if ((name === 'init-env.mjs' && fixture.startsWith('mytikas-helper-')) ||
      (name === 'public.mjs' && fixture.startsWith('mytikas-public-test-')))
    return pathToFileURL(join(root, 'scripts', name)).href;
  return null;
}
export function verifyCopy(url) {
  const canonical = canonicalCopy(url);
  if (!canonical) return null;
  const source = readFileSync(fileURLToPath(url));
  const expected = readFileSync(fileURLToPath(canonical));
  if (!source.equals(expected)) throw new Error('Utility fixture source differs from its canonical repository source.');
  return { url, canonical, sha256: digest(source), length: source.toString('utf8').length };
}
export function remapReport(report, manifests) {
  if (!report || !Array.isArray(report.result) || report.result.length === 0)
    throw new Error('Missing or malformed V8 utility report.');
  for (const entry of report.result) {
    if (typeof entry.url !== 'string') throw new Error('Malformed V8 script entry.');
    const canonical = canonicalCopy(entry.url);
    if (!canonical) continue;
    const evidence = manifests.get(entry.url);
    if (!evidence || evidence.canonical !== canonical || evidence.sha256 !== digest(readFileSync(fileURLToPath(canonical))))
      throw new Error('Missing or stale verified source evidence for copied utility.');
    if (!Array.isArray(entry.functions)) throw new Error('Malformed copied utility functions.');
    for (const fn of entry.functions) {
      if (!Array.isArray(fn.ranges)) throw new Error('Malformed copied utility ranges.');
      for (const range of fn.ranges) {
        if (!Number.isInteger(range.startOffset) || !Number.isInteger(range.endOffset) || range.startOffset < 0 || range.endOffset < range.startOffset || range.endOffset > evidence.length || !Number.isInteger(range.count) || range.count < 0)
          throw new Error('Invalid copied utility range.');
      }
    }
    if (report['source-map-cache']?.[entry.url]?.data)
      throw new Error('Unexpected source map on an exact copied utility.');
    entry.url = canonical;
  }
  return report;
}

// Preload runs in each child before its entrypoint, while the fixture still exists.
const manifestDirectory = process.env.MYTIKAS_UTILITY_COVERAGE_MANIFESTS;
if (manifestDirectory && process.argv[1] && resolve(process.argv[1]) !== self) {
  try {
    const evidence = verifyCopy(pathToFileURL(resolve(process.argv[1])).href);
    if (evidence) writeFileSync(join(manifestDirectory, `${process.pid}-${randomUUID()}.json`), JSON.stringify(evidence));
  } catch (error) {
    writeFileSync(join(manifestDirectory, `${process.pid}-${randomUUID()}.json`), JSON.stringify({ error: error.message }));
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const raw = join(root, 'coverage/raw/utilities');
  const mapped = join(root, 'coverage/mapped/utilities');
  const evidencePath = join(root, 'coverage/utility-source-evidence');
  for (const path of [raw, mapped, evidencePath]) { rmSync(path, { recursive: true, force: true }); mkdirSync(path, { recursive: true }); }
  const result = spawnSync(process.execPath, ['scripts/test-utilities.mjs'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: raw,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(self).href}`,
      MYTIKAS_UTILITY_COVERAGE_MANIFESTS: evidencePath },
  });
  if (result.status !== 0) throw new Error('Utility test suite failed.');
  const manifests = new Map();
  for (const file of readdirSync(evidencePath).sort()) {
    const entry = JSON.parse(readFileSync(join(evidencePath, file), 'utf8'));
    if (entry.error) throw new Error('Fixture source verification failed; refusing coverage.');
    if (!entry.url || !entry.canonical || !entry.sha256 || !Number.isInteger(entry.length)) throw new Error('Malformed utility source evidence.');
    const previous = manifests.get(entry.url);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error('Conflicting utility source evidence.');
    manifests.set(entry.url, entry);
  }
  const reports = readdirSync(raw).filter(name => /^coverage-.*\.json$/.test(name)).sort();
  if (!reports.length) throw new Error('No raw utility coverage was collected.');
  if (!manifests.size) throw new Error('No copied utility source evidence was captured.');
  const seenCopies = new Set();
  for (const file of reports) {
    const report = JSON.parse(readFileSync(join(raw, file), 'utf8'));
    for (const entry of report.result || []) if (canonicalCopy(entry.url || '')) seenCopies.add(entry.url);
    writeFileSync(join(mapped, file), JSON.stringify(remapReport(report, manifests)));
  }
  for (const url of manifests.keys()) if (!seenCopies.has(url)) throw new Error('Verified utility execution is missing its V8 coverage.');
  const report = spawnSync(process.execPath, ['node_modules/c8/bin/c8.js', 'report', '--all', '--include=scripts/**/*.{mjs,ts}', `--temp-directory=${mapped}`, '--reporter=text', '--reporter=json-summary', '--reporter=html', '--reports-dir=coverage/utilities'], {cwd:root, stdio:'inherit'});
  if (report.status !== 0) throw new Error('Utility coverage reporting failed.');
}
