import { homedir } from 'node:os';
import { existsSync, rmdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync, lstatSync, openSync, closeSync, unlinkSync } from 'node:fs';
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
for (const key of Object.keys(env)) if (/^(DOCKER_HOST$|DOCKER_CONTEXT$|POSTGRES_|DATABASE_|RUNTIME_DATABASE_|SMTP_|EMAIL_|SESSION_|APP_ORIGIN$|PUBLIC_|DISCORD_|MYTIKAS_|DEPLOYMENT_PROFILE$|INGRESS_MODE$|COMPOSE_)/.test(key)) delete env[key];
const dc = [...(machine?.context ? ['--context', machine.context] : []), 'compose', '--project-name', managed?.project || 'mytikas-public', '--env-file', envFile, '-f', managed?.compose || resolve(root, 'compose.public.yaml')];
function run(args, options = {}) {
  if (machine?.context && args[0] !== '--context') args = ['--context', machine.context, ...args];
  const result = spawnSync('docker', args, { cwd: root, env, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) {
    const category = args.includes('dist/deployment-preflight.js') && String(result.stderr || '').match(/^SMTP preflight failed: (authentication|tls|timeout|connection|smtp_permanent|smtp_temporary|internal)$/m)?.[1];
    throw new Error(category ? `SMTP preflight failed: ${category}` : 'Docker command failed; check Docker/configuration and docs/PRODUCTION-ROLLOUT.md.');
  }
  return result;
}
function createPrivate(path, content) {
  try { writeFileSync(path, content, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
function privateFile(path) {
  if (!lstatSync(path).isFile()) throw new Error('Public configuration/token must be regular private files.');
  if ((statSync(path).mode & 0o077) !== 0) throw new Error('Public configuration/token permissions must be 600.');
}
try {
  if (command === 'help') {
    console.log('Usage: node scripts/public.mjs init|doctor [--smtp]|up|status|logs|admin|backup [path]|stop|down');
    process.exit(0);
  }
  if (!['init','doctor','up','status','logs','admin','backup','stop','down'].includes(command) || args.length > (['backup','doctor'].includes(command) ? 1 : 0) || (command === 'doctor' && args.length && args[0] !== '--smtp'))
    throw new Error('Invalid command or arguments; use help.');
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Node.js 24 required.');
  if (existsSync(resolve(root, '.public/machine-handoff.json')) && !['status','doctor','logs','stop','down'].includes(command)) throw new Error('This checkout handed off hosting; use the machine launcher.');
  if (machine && !['active','idle'].includes(machine.phase) && !['status','doctor','logs','stop','down'].includes(command))
    throw new Error('This machine handed off hosting or has an incomplete transfer; use mytikas-machine.sh recovery/import.');
  if (managed && command === 'init') throw new Error('Managed deployment secrets are preserved by import.');
  if (command === 'init') {
    mkdirSync(resolve(root, '.public'), { recursive: true, mode: 0o700 });
    createPrivate(envFile, `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\nSESSION_SECRET=${randomBytes(48).toString('hex')}\nEMAIL_OUTBOX_KEY=${randomBytes(32).toString('hex')}\nSMTP_HOST=\nSMTP_PORT=587\nSMTP_USER=\nSMTP_PASSWORD=\nEMAIL_FROM=\nMYTIKAS_IMAGE=\nDISCORD_WEBHOOK_URL=\nPUBLIC_UID=${process.getuid()}\nPUBLIC_GID=${process.getgid()}\n`);
    privateFile(envFile);
    const existing = readFileSync(envFile, 'utf8');
    if (!/^\s*(?:export\s+)?RUNTIME_DATABASE_PASSWORD\s*=/m.test(existing))
      appendFileSync(envFile, `${existing.endsWith('\n') ? '' : '\n'}RUNTIME_DATABASE_PASSWORD=${randomBytes(32).toString('hex')}\n`);
    createPrivate(tokenFile, '');
    console.log('Private .env.public and .public/tunnel-token initialized; existing credentials preserved; missing runtime database secret added. Paste the tunnel token into its file using a private editor.');
    process.exit(0);
  }
  privateFile(envFile);
  if (managed?.compose?.endsWith('/compose.json')) privateFile(managed.compose);
  run(['compose', 'version', '--short'], { stdio: 'pipe' });
  run(['info'], { stdio: 'pipe' });
  run([...dc, 'config', '--quiet'], { stdio: 'pipe' });
  if (['doctor','up'].includes(command)) {
    privateFile(tokenFile);
    if (!readFileSync(tokenFile, 'utf8').trim()) throw new Error('Tunnel token file is empty. Configure the named tunnel first.');
  }
  let existing = false;
  if (['doctor','up'].includes(command)) {
    const resolved = JSON.parse(run([...dc,'config','--format','json'], {stdio:'pipe',encoding:'utf8'}).stdout);
    const services = resolved.services;
    const selected = services.app.image;
    if (!managed && selected !== 'mytikas-public' && !/^ghcr\.io\/laymer\/mytikas@sha256:[a-f0-9]{64}$/.test(selected))
      throw new Error('MYTIKAS_IMAGE must be an immutable ghcr.io/laymer/mytikas@sha256 digest.');
    for (const name of ['worker', ...(managed ? [] : ['migrate'])])
      if (services[name].image !== selected) throw new Error('Candidate service images differ.');
    if (JSON.stringify(services.app.environment) !== JSON.stringify(services.worker.environment)) throw new Error('Candidate web/worker environments differ.');
    if (!managed) {
      if (selected === 'mytikas-public') run([...dc,'build','app']);
      else run([...dc,'pull','app','worker','migrate'],{stdio:'pipe'});
    }
    const candidate = JSON.parse(run(['image','inspect',selected],{stdio:'pipe',encoding:'utf8'}).stdout)[0];
    if (candidate.Os !== 'linux' || candidate.Architecture !== 'amd64') throw new Error('Candidate requires linux/amd64.');
    const capabilities = JSON.parse(run(['run','--rm','--network','none','--entrypoint','node',selected,'-e',"const fs=require('node:fs'); console.log(JSON.stringify({activation:fs.readdirSync('/app/migrations').some(n=>n.startsWith('004_')),preflight:fs.existsSync('/app/dist/deployment-preflight.js')}))"],{stdio:'pipe',encoding:'utf8'}).stdout);
    if (!managed || capabilities.activation) {
    const mail = services.app.environment;
    for (const key of ['EMAIL_OUTBOX_KEY','SMTP_HOST','EMAIL_FROM'])
      if (!mail[key]) throw new Error(`Missing ${key}; configure privately before rollout. Existing outbox keys must be recovered, never replaced automatically.`);
    if (!/^[a-f0-9]{64}$/i.test(mail.EMAIL_OUTBOX_KEY) || [mail.SESSION_SECRET,services.db.environment.POSTGRES_PASSWORD,new URL(mail.DATABASE_URL).password].includes(mail.EMAIL_OUTBOX_KEY))
      throw new Error('EMAIL_OUTBOX_KEY must be an independent 32-byte hexadecimal key.');
    if (Boolean(mail.SMTP_USER) !== Boolean(mail.SMTP_PASSWORD)) throw new Error('SMTP_USER and SMTP_PASSWORD must be paired.');
    }
    function candidateCheck(mode) {
      if (capabilities.preflight) return run([...dc,'run','--rm','--no-deps','app','node','dist/deployment-preflight.js',mode],{stdio:'pipe'});
      if (mode === 'smtp') throw new Error('SMTP preflight requires a current candidate; legacy managed archives remain restartable.');
      // Existing exports are present in preserved pre-004 images; this never migrates.
      const probe = `try { const {config}=await import('./dist/config.js'); const cfg=config(); ${mode === 'schema' ? "const {createPool}=await import('./dist/db.js'); const {schemaReady}=await import('./dist/migrate.js'); const pool=createPool(cfg.databaseUrl); try { if(!await schemaReady(pool))throw new Error(); } finally {await pool.end();}" : ''} } catch { process.exitCode=1; }`;
      return run([...dc,'run','--rm','--no-deps','app','node','--input-type=module','-e',probe],{stdio:'pipe'});
    }
    candidateCheck(args[0] === '--smtp' ? 'smtp' : 'config');
    const mounts = services.db.volumes.filter(v=>v.type==='volume' && v.target==='/var/lib/postgresql');
    if (mounts.length !== 1) throw new Error('Expected one named PostgreSQL volume.');
    const volume = resolved.volumes[mounts[0].source].name;
    const volumes = run(['volume','ls','--format','json'],{stdio:'pipe',encoding:'utf8'}).stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
    existing = volumes.some(v=>v.Name===volume);
    const dbId = run([...dc,'ps','-a','-q','db'],{stdio:'pipe',encoding:'utf8'}).stdout.trim();
    if ((dbId || managed) && !existing) throw new Error('Existing database volume is unavailable; refusing empty replacement.');
    if (existing) {
      const writerIds = ['app','worker'].map(name=>run([...dc,'ps','-q',name],{stdio:'pipe',encoding:'utf8'}).stdout.trim());
      if (writerIds.every(Boolean)) {
        const writers = writerIds.map(id=>JSON.parse(run(['inspect',id],{stdio:'pipe',encoding:'utf8'}).stdout)[0]);
        if (writers[0].Image !== writers[1].Image) throw new Error('Running web/worker images differ.');
        const values = writers.map(w=>Object.fromEntries(w.Config.Env.map(v=>{const n=v.indexOf('=');return [v.slice(0,n),v.slice(n+1)];})));
        for (const key of ['DATABASE_URL','SESSION_SECRET','EMAIL_OUTBOX_KEY','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','EMAIL_FROM'])
          if (values[0][key] !== values[1][key]) throw new Error('Running web/worker configuration differs.');
      }
      const database = dbId ? JSON.parse(run(['inspect',dbId],{stdio:'pipe',encoding:'utf8'}).stdout)[0] : null;
      if (database && !database.Mounts?.some(m=>m.Type==='volume' && m.Name===volume && m.Destination==='/var/lib/postgresql'))
        throw new Error('Database container does not use the selected retained volume.');
      if (!database?.State.Running) {
        if (command === 'doctor') throw new Error('Database is stopped; use up to restart only the retained database before schema validation.');
        run([...dc,'up','-d','--no-deps','--no-recreate','--wait','--wait-timeout','180','db']);
      }
      try { candidateCheck('schema'); }
      catch {
        if (command === 'up') throw new Error('Existing schema is unavailable, pending or mismatched. Refusing interruption; use docs/PRODUCTION-ROLLOUT.md.');
        console.log('Schema is unavailable, pending or mismatched: ordinary up is blocked. Follow docs/PRODUCTION-ROLLOUT.md before interruption.');
      }
    }
  }
  switch (command) {
    case 'doctor': if (args[0] === '--smtp') console.log('SMTP preflight passed; no message sent.'); console.log('Node 24, Docker, Compose, private configuration and tunnel token present. Verify remote tunnel route is app.mytikas.monster → http://127.0.0.1:8080.'); break;
    case 'up':
      // All candidate and schema checks complete before interrupting ingress.
      run([...dc, 'rm', '--stop', '--force', 'tunnel']);
      run([...dc, 'up', '-d', '--no-build', ...(managed || existing ? ['--no-deps'] : []), '--wait', '--wait-timeout', '180', 'app', 'worker']);
      run([...dc, 'up', '-d', '--no-deps', '--force-recreate', 'tunnel']);
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
} catch (error) { if (error instanceof SyntaxError) { console.error('Invalid private Docker configuration response.'); process.exitCode=1; } else { console.error(error.code === 'ENOENT' ? 'Missing public configuration; run init first.' : error.message); process.exitCode = 1; } }
