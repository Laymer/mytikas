// Exercise the production Compose exec path, including stdin, with two local PostgreSQL clusters.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Machine } from '../scripts/machine/core.mjs';
import { provisionSyncRole } from '../scripts/addon-sync.mjs';

const home = fs.mkdtempSync(join(tmpdir(), 'addon-grants-'));
const machine = new Machine(home, home);
const deployment = { root:home, project:'mytikas-grants-'+randomUUID(), compose:join(home,'compose.json'), env:join(home,'.env') };
const password = randomBytes(32).toString('hex');
const databases = { db:'mytikas_public', 'archive-db':'mytikas_archive' };
const services = Object.fromEntries(Object.entries(databases).map(([service, database]) => [service, {
  image:'postgres:18-bookworm',
  environment:{POSTGRES_USER:database, POSTGRES_DB:database, POSTGRES_PASSWORD:randomBytes(24).toString('hex'),
    POSTGRES_INITDB_ARGS:'--auth-host=scram-sha-256'},
  healthcheck:{test:['CMD','pg_isready','-h','127.0.0.1','-d',database,'-U',database], interval:'1s', timeout:'3s', retries:120},
}]));
fs.writeFileSync(deployment.compose, JSON.stringify({services,networks:{default:{internal:true}}}), {mode:0o600});
fs.writeFileSync(deployment.env,'',{mode:0o600});

function login(service, sql, credential=password) {
  return machine.dc(deployment, ['exec','-T','-e','PGPASSWORD',service,'psql','-XAtq','-w','-h','127.0.0.1',
    '-U','mytikas_sync','-d',databases[service],'-v','ON_ERROR_STOP=1','-c',sql], {env:{...machine.env, PGPASSWORD:credential}});
}

function denied(service, sql) {
  // A check-constraint failure or nonexistent table must not count as a permission denial.
  login(service, 'DO $$ BEGIN BEGIN '+sql+"; EXCEPTION WHEN insufficient_privilege THEN RETURN; END; RAISE EXCEPTION 'unexpected grant'; END $$");
}

try {
  await machine.prepare();
  machine.dc(deployment,['up','-d','--wait','--pull','never'],{timeout:180000});
  const migrations=new URL('../migrations/',import.meta.url);
  for (const name of fs.readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort()) {
    machine.sql(deployment,fs.readFileSync(new URL(name,migrations),'utf8'));
  }
  // The archive schema is owned by the independently deployed Rust repository. Model its grant surface here.
  machine.sql(deployment,`CREATE TABLE archives (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    submission_id bigint, version text, notes text, sha256 text, archive bytea, pr_number bigint,
    merge_commit text, release_id bigint, receipt_checked_at timestamptz, curseforge_file_id bigint)`,true);

  for (const service of Object.keys(services)) {
    provisionSyncRole(machine,deployment,service,password,service==='archive-db');
    provisionSyncRole(machine,deployment,service,password,service==='archive-db');
    assert.equal(login(service,'SELECT current_user'),'mytikas_sync');
    assert.throws(()=>login(service,'SELECT 1','wrong-password'));
  }
  machine.sql(deployment,`WITH uploader AS (INSERT INTO users(email,password_hash) VALUES ('fixture@example.test','test') RETURNING id)
    INSERT INTO addon_submissions(version,notes,sha256,archive,submitted_by)
    SELECT '1.2.3','fixture',encode(sha256('ZIP'::bytea),'hex'),'ZIP'::bytea,id FROM uploader`);
  assert.equal(login('db',"SELECT version FROM addon_submissions WHERE status='queued'"),'1.2.3');
  assert.equal(login('archive-db',`INSERT INTO archives(submission_id,version,notes,sha256,archive)
    VALUES (1,'1.2.3','fixture',encode(sha256('ZIP'::bytea),'hex'),'ZIP'::bytea) RETURNING id`),'1');
  login('db',"UPDATE addon_submissions SET status='stored', archive=NULL, archive_id=1 WHERE id=1");
  login('archive-db',"UPDATE archives SET pr_number=7, merge_commit='merged', release_id=3, receipt_checked_at=now(), curseforge_file_id=4 WHERE id=1");
  login('db',`INSERT INTO addon_releases(version,published_at,notes,sha256,archive) VALUES
    ('1.2.3',now(),'fixture',encode(sha256('ZIP'::bytea),'hex'),'ZIP'::bytea)`);
  assert.equal(login('db','SELECT version FROM addon_releases'),'1.2.3');
  denied('db','PERFORM password_hash FROM users');
  denied('archive-db','UPDATE archives SET archive=archive WHERE id=1');
  denied('archive-db','DELETE FROM archives WHERE id=1');
  assert.equal(login('archive-db',"SELECT encode(archive,'hex') FROM archives WHERE id=1"),'5a4950');
  console.log('Both synchronizer logins and grants passed, including immutable archive bytes.');
} finally {
  try { machine.dc(deployment,['down','--volumes']); }
  finally { fs.rmSync(home,{recursive:true,force:true}); }
}
