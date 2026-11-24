import { spawnSync } from 'node:child_process';
for (const suite of ['fighters', 'member-home', 'addon-releases', 'addon-upload', 'addon-files', 'discord-linking', 'moderation-recovery', 'blacklist-preview', 'integration-health', 'rollout-pause', 'activation-edges', 'activation-rosters', 'run', 'demo', 'demo-entrypoints', 'ingress', 'database', 'database-tls', 'entrypoints', 'runtime-role', 'discord', 'discord-integration', 'worker-races']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', `tests/${suite}.ts`], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
