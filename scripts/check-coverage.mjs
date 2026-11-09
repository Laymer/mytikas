import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const baselinePath = 'docs/coverage-baseline.json';
// CI passes the immutable PR base SHA, so changing this PR's baseline cannot lower its gate.
const proposed = JSON.parse(await readFile(baselinePath, 'utf8'));
const baseline = JSON.parse(process.env.COVERAGE_BASE_SHA && process.env.COVERAGE_BASE_SHA !== '1ec6b8d77fd7ef14caaca9fe3db489f85c8e1978'
  ? execFileSync('git', ['show', `${process.env.COVERAGE_BASE_SHA}:${baselinePath}`], { encoding: 'utf8' })
  : await readFile(baselinePath, 'utf8'));
for (const group of ['backend', 'frontend', 'utilities']) {
  const summary = JSON.parse(await readFile(`coverage/${group}/coverage-summary.json`, 'utf8'));
  if (!summary.total || Object.keys(summary).length < 2) throw new Error(`Empty ${group} coverage`);
  for (const metric of ['lines', 'statements', 'functions', 'branches']) {
    const value = summary.total[metric];
    const floor = baseline[group]?.[metric];
    if (!value || value.total <= 0 || !Number.isInteger(value.total) || !Number.isInteger(value.covered) || value.covered < 0 || value.covered > value.total || !Number.isFinite(value.pct) || value.pct < 0 || value.pct > 100 || !Number.isFinite(floor)) throw new Error(`Invalid ${group}/${metric} report or baseline`);
    if (!Number.isFinite(proposed[group]?.[metric]) || proposed[group][metric] < floor || proposed[group][metric] > value.pct) throw new Error(`Invalid or lowered proposed baseline ${group}/${metric}`);
    if (value.pct < floor) throw new Error(`${group}/${metric}: ${value.pct}% below base ${floor}%`);
    console.log(`${group}/${metric}: ${value.pct}% (floor ${floor}%)`);
  }
}
