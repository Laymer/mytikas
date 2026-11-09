import { spawnSync } from 'node:child_process';
for (const suite of ['run', 'demo', 'ingress', 'database', 'runtime-role', 'discord', 'discord-integration']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', `tests/${suite}.ts`], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
