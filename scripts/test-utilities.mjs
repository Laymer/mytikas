import { spawnSync } from 'node:child_process';
for (const suite of ['machine-engine', 'machine', 'addon-sync-host', 'machine-bootstrap', 'blacklist-host', 'cloudflare', 'helper', 'public', 'landing', 'restore', 'credential-tools', 'pg-tools', 'check-coverage', 'utility-coverage']) {
  const result = spawnSync(process.execPath, [`tests/${suite}.mjs`], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
