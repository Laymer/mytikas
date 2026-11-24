import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { cleanupTick, tick } from '../src/worker.js';
import { harness, Client, listen, close, mailToken } from './harness.js';
const h = await harness();
const password = randomBytes(24).toString('hex');
const runtimeUrl = new URL(h.cfg.databaseUrl);
runtimeUrl.username = 'mytikas_runtime'; runtimeUrl.password = password;
const pool = createPool(runtimeUrl.toString());
const cfg = {...h.cfg};
const server = createServer(createApp(pool,cfg,h.verify));
try {
  await h.pool.query(`CREATE ROLE mytikas_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  const grants = (await readFile('scripts/runtime-grants.sql','utf8')).replaceAll(':"runtime_role"','"mytikas_runtime"').replaceAll(':"database"','"mytikas_test"');
  await h.pool.query(grants);
  cfg.origin = `http://127.0.0.1:${await listen(server)}`;
  const ownership = await pool.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public' AND tableowner=current_user");
  assert.equal(ownership.rows[0].count,0);
  for(const query of ['CREATE TABLE forbidden(id int)','ALTER TABLE users ADD COLUMN forbidden int','UPDATE migrations SET checksum=checksum','TRUNCATE events','DELETE FROM rules'])
    await assert.rejects(pool.query(query), e => (e as {code:string}).code==='42501');
  const privateInbox='runtime-recovery@example.test';
  await h.pool.query('UPDATE users SET recovery_email=$1 WHERE id=$2',[privateInbox,h.admin.id]);
  assert.equal((await pool.query('SELECT recovery_email FROM users WHERE id=$1',[h.admin.id])).rows[0].recovery_email,privateInbox);
  await assert.rejects(pool.query('UPDATE users SET recovery_email=NULL WHERE id=$1',[h.admin.id]),e=>(e as {code:string}).code==='42501');
  await assert.rejects(pool.query("INSERT INTO users(email,password_hash,recovery_email) VALUES ('forbidden@example.test','fixture',$1)",[privateInbox]),e=>(e as {code:string}).code==='42501');
  assert.deepEqual((await h.pool.query('SELECT email,recovery_email FROM users WHERE recovery_email=$1',[privateInbox])).rows,[{email:'admin@example.test',recovery_email:privateInbox}]);
  assert.equal((await fetch(cfg.origin+'/api/health')).status,200);
  const user = new Client(cfg.origin), admin = new Client(cfg.origin);
  assert.equal((await user.signup('Runtime Applicant')).status,201);
  await user.request('/api/auth/verify-email',{token:await mailToken(h.pool,'runtime.applicant@example.test')});
  await user.login('runtime.applicant@example.test');
  await admin.login();
  const publishedId=randomUUID(), content=Buffer.from('restricted-role fixture');
  const checksum=createHash('sha256').update(content).digest('hex');
  const form=new FormData();
  form.append('manifest',JSON.stringify({paths:['guide.txt'],visibility:'public',sha256:[checksum]}));
  form.append('files',new Blob([new Uint8Array(content)]),'guide.txt');
  const headers={Cookie:admin.cookie,Origin:cfg.origin,'X-CSRF-Token':admin.csrf};
  const uploaded=await fetch(cfg.origin+'/api/admin/addon-files',{method:'POST',headers:{...headers,'X-Upload-ID':publishedId},body:form});
  assert.equal(uploaded.status,201);assert.equal((await uploaded.json()).sha256,checksum);
  // Staging credentials can reserve versions and read progress, but cannot mark a release published.
  const submission = await pool.query(
    "INSERT INTO addon_submissions(version,notes,sha256,archive,submitted_by) VALUES ('1.2.3','Updated guide',$1,$2,$3) RETURNING id,version,status",
    [checksum,content,h.admin.id],
  );
  assert.equal(submission.rows[0].status,"queued");
  for (const sql of ["UPDATE addon_submissions SET status='published'", "SELECT archive FROM addon_submissions", "DELETE FROM addon_submissions"])
    await assert.rejects(pool.query(sql), e => (e as {code:string}).code==='42501');
  const changed=await fetch(cfg.origin+'/api/admin/addon-files/'+publishedId+'/visibility',{
    method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({visibility:'private'}),
  });
  assert.equal(changed.status,200);assert.equal((await changed.json()).visibility,'private');
  for(const column of ['content','filename','notes','uploaded_by','published_at','request_sha256','file_count','id']){
    await assert.rejects(pool.query('UPDATE addon_files SET '+column+'='+column+' WHERE id=$1',[publishedId]),e=>(e as {code:string}).code==='42501');
  }
  await assert.rejects(pool.query('DELETE FROM addon_files WHERE id=$1',[publishedId]),e=>(e as {code:string}).code==='42501');
  const stored=await pool.query('SELECT content,sha256,visibility FROM addon_files WHERE id=$1',[publishedId]);
  assert.deepEqual(stored.rows,[{content,sha256:checksum,visibility:'private'}]);
  const id = (await user.application()).application.id;
  assert.equal((await admin.request(`/api/admin/applications/${id}/approve`,{note:'Runtime role review'})).status,200);
  assert.equal((await admin.request('/api/admin/rules',{content:'Runtime role published rules.'})).status,201);
  await tick(pool,cfg.discordWebhook,cfg.origin,h.verify);
  assert.equal((await user.application()).application.status,'JOINED');
  assert.equal(h.discord.messages.length,1);
  assert.equal((await user.request('/api/auth/logout',{})).status,200);
  await user.login('runtime.applicant@example.test');
  await cleanupTick(pool);
  const heartbeat=randomUUID();
  await pool.query('INSERT INTO worker_heartbeats(id) VALUES($1)',[heartbeat]);
  await pool.query('UPDATE worker_heartbeats SET updated_at=now() WHERE id=$1',[heartbeat]);
  await pool.query('DELETE FROM worker_heartbeats WHERE id=$1',[heartbeat]);
  console.log('Non-owner runtime grants support auth, application/staff workflow, rules, workers, sessions and readiness; DDL/history/migration mutation denied.');
} finally { if(server.listening)await close(server); await pool.end(); await h.stop(); }
