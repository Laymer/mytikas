import { homedir } from 'node:os';
import { existsSync, rmdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [command = 'help', ...args] = process.argv.slice(2);
const machineHome = resolve(homedir(), '.mytikas');
// Share the machine operation lock, acquired before reading its deployment pointer.
if (command !== 'help') {
  const lock = resolve(machineHome, 'operation.lock');
  try { mkdirSync(machineHome, { recursive: true, mode: 0o700 }); mkdirSync(lock, { mode: 0o700 }); }
  catch { console.error('Machine operation in progress; use mytikas-machine.sh status.'); process.exit(1); }
  process.once('exit', () => { try { rmdirSync(lock); } catch {} });
}
const machineFile = resolve(machineHome, 'machine.json');
const machine = existsSync(machineFile) ? JSON.parse(readFileSync(machineFile, 'utf8')) : null;
const managed = machine?.active;
const root = managed?.root || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = managed?.env || resolve(root, '.env.public');
const tokenFile = managed?.token || resolve(root, '.public/tunnel-token');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(DOCKER_HOST$|DOCKER_CONTEXT$|POSTGRES_|DATABASE_|RUNTIME_DATABASE_|SESSION_|APP_ORIGIN$|PUBLIC_|DISCORD_|MYTIKAS_|DEPLOYMENT_PROFILE$|INGRESS_MODE$|COMPOSE_)/.test(key)) delete env[key];
const dc = [...(machine?.context ? ['--context', machine.context] : []), 'compose', '--project-name', managed?.project || 'mytikas-public', '--env-file', envFile, '-f', managed?.compose || resolve(root, 'compose.public.yaml')];
function run(args, options = {}) {
  if (machine?.context && args[0] !== '--context') args = ['--context', machine.context, ...args];
  const result = spawnSync('docker', args, { cwd: root, env, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error('Docker command failed; check Docker Desktop/WSL integration and configuration.');
  return result;
}
function createPrivate(path, content) {
  try { writeFileSync(path, content, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
function privateFile(path) {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error('Public configuration/token permissions must be 600.');
}
try {
  if (command === 'help') {
    console.log('Usage: node scripts/public.mjs init|doctor|up|status|logs|admin|backup [path]|stop|down');
    process.exit(0);
  }
  if (!['init','doctor','up','status','logs','admin','backup','stop','down'].includes(command) || args.length > (command === 'backup' ? 1 : 0))
    throw new Error('Invalid command or arguments; use help.');
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Node.js 24 required.');
  if (existsSync(resolve(root, '.public/machine-handoff.json')) && !['status','doctor','logs','stop','down'].includes(command)) throw new Error('This checkout handed off hosting; use the machine launcher.');
  if (machine && !['active','idle'].includes(machine.phase) && !['status','doctor','logs','stop','down'].includes(command))
    throw new Error('This machine handed off hosting or has an incomplete transfer; use mytikas-machine.sh recovery/import.');
  if (managed && command === 'init') throw new Error('Managed deployment secrets are preserved by import.');
  if (command === 'init') {
    mkdirSync(resolve(root, '.public'), { recursive: true, mode: 0o700 });
    createPrivate(envFile, `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\nSESSION_SECRET=${randomBytes(48).toString('hex')}\nDISCORD_WEBHOOK_URL=\nPUBLIC_UID=${process.getuid()}\nPUBLIC_GID=${process.getgid()}\n`);
    privateFile(envFile);
    const existing = readFileSync(envFile, 'utf8');
    if (!/^\s*(?:export\s+)?RUNTIME_DATABASE_PASSWORD\s*=/m.test(existing))
      appendFileSync(envFile, `${existing.endsWith('\n') ? '' : '\n'}RUNTIME_DATABASE_PASSWORD=${randomBytes(32).toString('hex')}\n`);
    createPrivate(tokenFile, '');
    console.log('Private .env.public and .public/tunnel-token initialized; existing credentials preserved; missing runtime database secret added. Paste the tunnel token into its file using a private editor.');
    process.exit(0);
  }
  privateFile(envFile);
  run(['compose', 'version', '--short'], { stdio: 'pipe' });
  run(['info'], { stdio: 'pipe' });
  run([...dc, 'config', '--quiet'], { stdio: 'pipe' });
  if (['doctor','up'].includes(command)) {
    privateFile(tokenFile);
    if (!readFileSync(tokenFile, 'utf8').trim()) throw new Error('Tunnel token file is empty. Configure the named tunnel first.');
  }
  switch (command) {
    case 'doctor': console.log('Node 24, Docker, Compose, private configuration and tunnel token present. Verify remote tunnel route is app.mytikas.monster → http://127.0.0.1:8080.'); break;
    case 'up':
      // Tear down the namespace consumer before replacing its provider.
      run([...dc, 'rm', '--stop', '--force', 'tunnel']);
      if (!managed) run([...dc, 'build', 'app']);
      else run([...dc, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'db']);
      run([...dc, 'up', '-d', '--no-build', ...(managed ? ['--no-deps'] : []), '--wait', '--wait-timeout', '180', 'app', 'worker']);
      run([...dc, 'up', '-d', '--force-recreate', 'tunnel']);
      break;
    case 'status': run([...dc, 'ps', '-a']); break;
    case 'logs': run([...dc, 'logs', '--tail', '100']); break;
    case 'admin': run([...dc, 'exec', 'app', 'node', 'dist/admin-cli.js']); break;
    case 'stop': case 'down': run([...dc, command]); break;
    case 'backup': {
      const target = resolve(root, args[0] || `backups/mytikas-public-${new Date().toISOString().replace(/[:.]/g,'-')}.dump`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const fd = openSync(target, 'wx', 0o600);
      try { run([...dc, 'exec', '-T', 'db', 'pg_dump', '-U', 'mytikas_public', '-d', 'mytikas_public', '-Fc'], { stdio: ['ignore', fd, 'pipe'] }); }
      catch (error) { unlinkSync(target); throw error; }
      finally { closeSync(fd); }
      console.log('Private public-profile backup saved.');
      break;
    }
  }
} catch (error) { console.error(error.code === 'ENOENT' ? 'Missing public configuration; run init first.' : error.message); process.exitCode = 1; }
