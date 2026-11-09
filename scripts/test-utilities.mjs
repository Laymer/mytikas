import { spawnSync } from 'node:child_process';
for (const suite of ['helper', 'public', 'landing', 'restore', 'check-coverage', 'utility-coverage']) {
  const result = spawnSync(process.execPath, [`tests/${suite}.mjs`], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
