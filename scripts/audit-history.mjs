import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const objects = git('rev-list', '--objects', '--all').toString().trim().split('\n');
const patterns = [ /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/, /https:\/\/(?:discord.com|discordapp.com)\/api\/webhooks\/\d+\/[\w-]{30,}/, /AKIA[0-9A-Z]{16}/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{35,}/ ];
let blobs = 0, findings = 0;
for (const object of objects) {
  const [oid, ...parts] = object.split(' '), path = parts.join(' ');
  if (git('cat-file', '-t', oid).toString().trim() !== 'blob') continue;
  blobs++;
  const bytes = git('cat-file', 'blob', oid);
  if (!path.endsWith('.example') && /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]+)?|[^/]+\.(?:dump|backup|pem|key))$/.test(path)) {
    console.error(`Review sensitive filename: ${path}`); findings++;
  }
  if (bytes.includes(0)) continue;
  if (patterns.some(p => p.test(bytes.toString()))) {
    console.error(`Potential secret in blob ${oid.slice(0,12)} (${path}); value redacted`); findings++;
  }
}
console.log(`Reviewed ${blobs} reachable history blobs; ${findings} pattern findings. Manual screenshot, personal-data and asset review remains required.`);
process.exitCode = findings ? 1 : 0;
