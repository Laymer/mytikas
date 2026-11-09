import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { restoreBackup } from '../scripts/restore.mjs';
const directory = await mkdtemp(join(tmpdir(), 'mytikas-restore-guards-'));
try {
  const archive = join(directory, 'invalid.dump');
  await writeFile(archive, 'not a database', { mode: 0o600 });
  assert.throws(() => restoreBackup({ archive }), /custom-format/);
  assert.throws(() => restoreBackup({ archive, replace: true }), /explicit/);
  for (const database of ['postgres', 'template0', 'template1', 'bad; DROP DATABASE users', '../db', 'UPPERCASE', 'a'.repeat(64)])
    assert.throws(() => restoreBackup({ archive, database, replace: true }), /non-system/);
  await writeFile(archive, 'PGDMP');
  assert.throws(() => restoreBackup({ archive, connection: '' }), /RESTORE_DATABASE_URL/);
  assert.throws(() => restoreBackup({ archive, connection: 'https://example.test' }), /PostgreSQL connection/);
  assert.throws(() => restoreBackup({ archive, connection: 'postgres://test:secret@localhost/db?sslmode=disable' }), /without query/);
  const run = (args) => spawnSync(process.execPath, ['scripts/restore.mjs', ...args], { encoding: 'utf8' });
  assert.equal(run(['--help']).status, 0);
  assert.equal(run([]).status, 0);
  assert.equal(run([archive, '--unexpected']).status, 1);
  assert.equal(run([archive, '--database']).status, 1);
  assert.equal(run([join(directory, 'missing')]).status, 1);
  assert.equal(run([archive, '--replace', '--replace']).status, 1);
  assert.ok(!run([archive]).stderr.includes('secret'));
  console.log('Restore argument, archive and destructive-target guards passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
