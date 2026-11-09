import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const image = 'postgres:18-bookworm';
// Copy the PostgreSQL clients and their non-glibc dependencies as a matched set.
// Keep the host's glibc/loader: this supports Linux x64 with glibc >= Debian 12's 2.36,
// including Ubuntu 24.04 CI. No image entrypoint or database container is started.
const libraries = [
  'libpq.so.5', 'libzstd.so.1', 'liblz4.so.1', 'libcrypto.so.3', 'libz.so.1',
  'libssl.so.3', 'libgssapi_krb5.so.2', 'libldap-2.5.so.0', 'libkrb5.so.3',
  'libk5crypto.so.3', 'libcom_err.so.2', 'libkrb5support.so.0', 'liblber-2.5.so.0',
  'libsasl2.so.2', 'libgnutls.so.30', 'libkeyutils.so.1', 'libp11-kit.so.0',
  'libidn2.so.0', 'libunistring.so.2', 'libtasn1.so.6', 'libnettle.so.8',
  'libhogweed.so.6', 'libgmp.so.10', 'libffi.so.8', 'libreadline.so.8', 'libtinfo.so.6',
];
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  if (result.error || result.status !== 0) throw new Error('PostgreSQL client extraction failed; verify Docker is available and the postgres:18-bookworm image can be pulled.');
  return result.stdout.trim();
}
export async function preparePgTools(destination) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Client extraction supports Linux x64 only; install native PostgreSQL 18 tools on other platforms.');
  const directory = resolve(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length) throw new Error('PostgreSQL tool destination must be empty.');
  const bin = join(directory, 'bin'), lib = join(directory, 'lib'), native = join(directory, 'native');
  await mkdir(bin, { mode: 0o700 });
  await mkdir(lib, { mode: 0o700 });
  await mkdir(native, { mode: 0o700 });
  let container;
  let complete = false;
  try {
    container = docker(['create', '--platform', 'linux/amd64', '--entrypoint', 'true', image]);
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Docker returned an invalid extraction container reference.');
    for (const name of ['pg_dump', 'pg_restore', 'psql'])
      docker(['cp', '-L', `${container}:/usr/lib/postgresql/18/bin/${name}`, join(native, name)]);
    for (const name of libraries)
      docker(['cp', '-L', `${container}:/usr/lib/x86_64-linux-gnu/${name}`, join(lib, name)]);
    const env = { ...process.env, LD_LIBRARY_PATH: lib };
    for (const name of ['pg_dump', 'pg_restore', 'psql']) {
      const result = spawnSync(join(native, name), ['--version'], { env, encoding: 'utf8', timeout: 10000 });
      if (result.error || result.status !== 0 || !result.stdout.includes('(PostgreSQL) 18.'))
        throw new Error('Extracted PostgreSQL 18 clients are incompatible with this host.');
    }
    // Do not expose these older OpenSSL libraries to the host's Node runtime.
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const name of ['pg_dump', 'pg_restore', 'psql'])
      await writeFile(join(bin, name), `#!/bin/sh\nLD_LIBRARY_PATH=${quote(lib)} exec ${quote(join(native, name))} "$@"\n`, { mode: 0o700, flag: 'wx' });
    complete = true;
    return { bin, lib, image };
  } finally {
    try { if (container && /^[a-f0-9]{64}$/.test(container)) docker(['rm', container]); }
    finally {
      if (!complete) { await rm(bin, { recursive: true, force: true }); await rm(lib, { recursive: true, force: true }); await rm(native, { recursive: true, force: true }); }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-pg-tools.mjs EMPTY_DIRECTORY');
    console.log(JSON.stringify(await preparePgTools(process.argv[2])));
  } catch (error) { console.error(error.code ? 'Unable to prepare the PostgreSQL tools directory.' : error.message); process.exitCode = 1; }
}
