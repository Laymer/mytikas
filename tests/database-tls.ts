import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import EmbeddedPostgres from 'embedded-postgres';
import { createPool, type Pool } from '../src/db.js';
import { migrate, schemaReady } from '../src/migrate.js';
import { listen, close } from './harness.js';

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve,reject) => {
    timer=setTimeout(()=>reject(new Error('TLS fixture operation exceeded its deadline.')),milliseconds);
  })]); } finally {clearTimeout(timer);}
}
const directory = await mkdtemp(join(tmpdir(), 'mytikas-database-tls-'));
const saved = {...process.env};
const pools: Pool[]=[];
let postgres: EmbeddedPostgres | undefined;
function openssl(args: string[]) {
  const result=spawnSync('openssl',args,{cwd:directory,encoding:'utf8',timeout:15000});
  if(result.error || result.status!==0) throw new Error('OpenSSL certificate fixture generation failed; install OpenSSL with req/x509 support.');
}
try {
  // Each execution has its own CA, server key and wrong CA; none are persisted in Git.
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Mytikas test CA','-addext','basicConstraints=critical,CA:TRUE']);
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','wrong-ca.key','-out','wrong-ca.pem','-days','1','-subj','/CN=Unrelated test CA','-addext','basicConstraints=critical,CA:TRUE']);
  openssl(['req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=database-test.invalid']);
  await writeFile(join(directory,'server.ext'),'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',{mode:0o600});
  openssl(['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','server.pem','-days','1','-extfile','server.ext']);
  for(const file of ['ca.key','wrong-ca.key','server.key'])await chmod(join(directory,file),0o600);
  const probe=createServer();
  const port=await listen(probe);
  await close(probe);
  const password=randomBytes(24).toString('hex');
  postgres=new EmbeddedPostgres({
    databaseDir:join(directory,'db'),port,user:'tls_test',password,persistent:true,authMethod:'scram-sha-256',
    postgresFlags:['-h','127.0.0.1,::1','-c','ssl=on','-c',`ssl_cert_file=${join(directory,'server.pem')}`,'-c',`ssl_key_file=${join(directory,'server.key')}`],
    onLog:()=>{},onError:()=>{},
  });
  await bounded(postgres.initialise(),20000);
  await bounded(postgres.start(),20000);
  Object.assign(process.env,{DATABASE_TLS:'verify-full',DATABASE_CA_FILE:join(directory,'ca.pem'),DATABASE_CONNECT_TIMEOUT_MS:'2000',DATABASE_QUERY_TIMEOUT_MS:'5000'});
  const connection=`postgres://tls_test:${password}@127.0.0.1:${port}/postgres`;
  const trusted=createPool(connection);pools.push(trusted);
  const tls=await trusted.query('SELECT ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
  assert.equal(tls.rows[0].ssl,true,'Connection must actually negotiate TLS');
  assert.match(tls.rows[0].version,/^TLSv1\.[23]$/);
  await migrate(trusted);
  assert.equal(await schemaReady(trusted),true,'Migration and readiness work with verified TLS');
  process.env.DATABASE_CA_FILE=join(directory,'wrong-ca.pem');
  const wrongCa=createPool(connection);pools.push(wrongCa);
  await assert.rejects(wrongCa.query('SELECT 1'), error => {
    assert.match((error as Error).message,/certificate|issuer|self.signed|verify/i);
    return true;
  });
  process.env.DATABASE_CA_FILE=join(directory,'ca.pem');
  const wrongHost=createPool(connection.replace('@127.0.0.1:', '@localhost:'));pools.push(wrongHost);
  await assert.rejects(wrongHost.query('SELECT 1'),error=>{
    assert.equal((error as NodeJS.ErrnoException).code,'ERR_TLS_CERT_ALTNAME_INVALID');
    return true;
  });
  assert.equal((await trusted.query('SELECT 1 AS healthy')).rows[0].healthy,1,'Rejected clients do not disrupt the valid TLS pool');
  console.log('Verified PostgreSQL TLS: trusted CA and matching IP succeed; wrong CA and hostname mismatch fail; migrations/readiness run over TLS.');
} finally {
  process.env=saved;
  // On cleanup timeout fail visibly and retain the fixture rather than deleting live database files.
  await bounded(Promise.all(pools.map(pool=>pool.end())),10000);
  if(postgres)await bounded(postgres.stop(),10000);
  await rm(directory,{recursive:true,force:true});
}
