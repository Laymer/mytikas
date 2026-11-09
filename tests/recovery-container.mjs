import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePgTools } from '../scripts/prepare-pg-tools.mjs';
const directory = await mkdtemp(join(tmpdir(), "mytikas-pg18-client-drill-quote' space-"));
try {
  const tools = await preparePgTools(directory);
  await assert.rejects(preparePgTools(directory), /must be empty/);
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/recovery.ts'], {
    env: { ...process.env, PG_BIN_DIR: tools.bin }, stdio: 'inherit',
  });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0 || signal) throw new Error('PostgreSQL 18 backup/recovery drill failed.');
  console.log('Recovery drill passed with clients extracted from an unstarted PostgreSQL container.');
} finally { await rm(directory, { recursive: true, force: true }); }
