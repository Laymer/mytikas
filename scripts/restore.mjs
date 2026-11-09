import { homedir } from 'node:os';
import { existsSync, readFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function restoreBackup(options) {
  let lock;
  if (options.publicProfile) {
    const home = resolve(homedir(), '.mytikas');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    lock = resolve(home, 'operation.lock');
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch { throw new Error('Machine operation in progress; public restore blocked.'); }
  }
  try { return restoreUnlocked(options); }
  finally { if (lock) rmdirSync(lock); }
}
function restoreUnlocked({ archive, database, replace = false, publicProfile = false, connection = process.env.RESTORE_DATABASE_URL }) {
  if (replace && !database) throw new Error('--replace requires an explicit --database target.');
  const target = database || `mytikas_restore_${randomBytes(6).toString('hex')}`;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(target) || ['postgres', 'template0', 'template1'].includes(target))
    throw new Error('Use a non-system database name with lowercase letters, digits and underscores.');
  const file = resolve(archive);
  const check = openSync(file, 'r');
  try {
    const header = Buffer.alloc(5);
    if (readSync(check, header, 0, 5, 0) !== 5 || header.toString() !== 'PGDMP')
      throw new Error('Expected a PostgreSQL custom-format backup.');
  } finally { closeSync(check); }
  const env = { ...process.env };
  let prefix = [];
  if (publicProfile) {
    for (const key of Object.keys(env)) if (/^(POSTGRES_|RUNTIME_DATABASE_|DATABASE_|SMTP_|EMAIL_|SESSION_|APP_ORIGIN$|PUBLIC_|DISCORD_|MYTIKAS_|DEPLOYMENT_PROFILE$|INGRESS_MODE$|COMPOSE_|PG)/.test(key)) delete env[key];
    const machineHome = resolve(homedir(), '.mytikas');
    const stateFile = resolve(machineHome, 'machine.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
    if ((state && !['active','idle'].includes(state.phase)) || (!state?.active && existsSync(resolve(root, '.public/machine-handoff.json')))) throw new Error('Public restore blocked during or after handoff; use the machine launcher.');
    const d = state?.active;
    delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT;
    prefix = [...(state?.context ? ['--context',state.context] : []), 'compose', '--project-name', d?.project || 'mytikas-public', '--env-file', d?.env || resolve(root, '.env.public'), '-f', d?.compose || resolve(root, 'compose.public.yaml'), 'exec', '-T', 'db'];
  } else {
    if (!connection) throw new Error('Set RESTORE_DATABASE_URL to an administrative connection, or use --public.');
    const url = new URL(connection);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash)
      throw new Error('Use a PostgreSQL connection URL without query parameters; use DATABASE_TLS and DATABASE_CA_FILE for TLS.');
    const tls = process.env.DATABASE_TLS || 'disable';
    if (!['disable', 'verify-full'].includes(tls)) throw new Error('DATABASE_TLS must be disable or verify-full.');
    for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
    Object.assign(env, { PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)) || 'postgres',
      PGSSLMODE: tls, PGCONNECT_TIMEOUT: '5' });
    if (process.env.DATABASE_CA_FILE) env.PGSSLROOTCERT = process.env.DATABASE_CA_FILE;
  }
  function run(tool, args, inputFile) {
    const fd = inputFile ? openSync(inputFile, 'r') : undefined;
    try {
      const binary = publicProfile ? 'docker' : process.env.PG_BIN_DIR ? join(process.env.PG_BIN_DIR, tool) : tool;
      const result = spawnSync(binary, publicProfile ? [...prefix, tool, ...args] : args,
        { cwd: root, env, stdio: [fd ?? 'ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
      if (result.error || result.status !== 0) throw new Error(`${tool} failed; verify PostgreSQL 18 tools, permissions, connection and backup integrity. Details suppressed to protect credentials and application data.`);
      return result.stdout.toString().trim();
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  const auth = publicProfile ? ['-U', 'mytikas_public'] : [];
  const sql = (query) => run('psql', [...auth, '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query]);
  run('pg_restore', ['--list'], file);
  const exists = sql(`SELECT 1 FROM pg_database WHERE datname='${target}'`) === '1';
  if (exists && !replace) throw new Error('Target database already exists; choose a fresh target or explicitly use --replace.');
  if (exists) sql(`DROP DATABASE "${target}" WITH (FORCE)`);
  sql(`CREATE DATABASE "${target}" TEMPLATE template0`);
  run('pg_restore', [...auth, '--dbname', target, '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges'], file);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || !args.length) {
      console.log('Usage: node scripts/restore.mjs BACKUP.dump [--public] [--database NAME] [--replace]\nDefaults to a fresh database. RESTORE_DATABASE_URL supplies private native PostgreSQL access. --public uses the isolated public Compose database.');
    } else {
      const archive = args.shift();
      let database, replace = false, publicProfile = false;
      while (args.length) {
        const arg = args.shift();
        if (arg === '--database' && args.length && !database) database = args.shift();
        else if (arg === '--replace' && !replace) replace = true;
        else if (arg === '--public' && !publicProfile) publicProfile = true;
        else throw new Error('Invalid restore arguments; use --help.');
      }
      console.log(`Restored database: ${restoreBackup({ archive, database, replace, publicProfile })}`);
    }
  } catch (error) {
    console.error(error.code ? 'Unable to read backup or execute PostgreSQL tools.' : error.message);
    process.exitCode = 1;
  }
}
