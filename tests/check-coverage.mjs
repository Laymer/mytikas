import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
const script = resolve('scripts/check-coverage.mjs');
const cwd = await mkdtemp(join(tmpdir(), 'mytikas-coverage-gate-'));
const groups = ['backend', 'frontend', 'utilities'];
const metrics = ['lines', 'statements', 'functions', 'branches'];
const baseline = Object.fromEntries(groups.map(group => [group, Object.fromEntries(metrics.map(metric => [metric, 50]))]));
const summary = () => ({ total: Object.fromEntries(metrics.map(metric => [metric, { total: 100, covered: 60, skipped: 0, pct: 60 }])), 'owned.js': {} });
const baselineFile = join(cwd, 'docs/coverage-baseline.json');
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  await mkdir(join(cwd, 'docs'));
  await writeFile(baselineFile, JSON.stringify(baseline));
  for (const group of groups) {
    await mkdir(join(cwd, 'coverage', group), { recursive: true });
    await writeFile(join(cwd, 'coverage', group, 'coverage-summary.json'), JSON.stringify(summary()));
  }
  git('init', '--quiet');
  git('add', 'docs/coverage-baseline.json');
  git('-c', 'user.name=Coverage Fixture', '-c', 'user.email=coverage@example.test', 'commit', '--quiet', '-m', 'base');
  const sha = git('rev-parse', 'HEAD');
  const run = (base = sha) => spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', env: { ...process.env, COVERAGE_BASE_SHA: base } });
  assert.equal(run().status, 0, 'Valid reports clear immutable baseline');
  const changed = structuredClone(baseline);
  changed.backend.lines = 49;
  await writeFile(baselineFile, JSON.stringify(changed));
  assert.notEqual(run().status, 0, 'A passing PR cannot lower the next PR baseline');
  changed.backend.lines = 61;
  await writeFile(baselineFile, JSON.stringify(changed));
  assert.notEqual(run().status, 0, 'Baseline cannot claim more than measured');
  await writeFile(baselineFile, JSON.stringify(baseline));
  const reportPath = join(cwd, 'coverage/backend/coverage-summary.json');
  for (const malformed of ['{', '{}', JSON.stringify({ total: {} }), JSON.stringify({ total: summary().total })]) {
    await writeFile(reportPath, malformed);
    assert.notEqual(run().status, 0, 'Malformed/empty reports fail closed');
  }
  for (const metric of metrics) {
    for (const badValue of [{ total: 0, pct: 60 }, { total: 100, pct: '60' }, { total: 100, pct: 49 }, null]) {
      const invalid = summary();
      invalid.total[metric] = badValue;
      await writeFile(reportPath, JSON.stringify(invalid));
      assert.notEqual(run().status, 0, `${metric} rejects empty, nonnumeric, regressing and missing measurements`);
    }
  }
  await rm(reportPath);
  assert.notEqual(run().status, 0, 'Missing required group fails');
  await writeFile(reportPath, JSON.stringify(summary()));
  assert.notEqual(run('0000000000000000000000000000000000000000').status, 0, 'Missing immutable base fails');
  assert.equal(run('').status, 0, 'Local check supports current baseline');
  console.log('Coverage gate rejects missing, malformed, regressing and lowered-baseline reports.');
} finally { await rm(cwd, { recursive: true, force: true }); }
