import { pathToFileURL } from 'node:url';
import { createPool, transaction, type Pool } from '../db.js';
import { hashPassword } from '../app.js';
export const dataset = 'mytikas-demo-v1';
export async function seed(pool: Pool, password: string) {
  if (!password || password.length < 12) throw new Error('Missing demo password');
  const hash = await hashPassword(password);
  await transaction(pool, async c => {
    await c.query('SELECT pg_advisory_xact_lock(101)');
    await c.query('CREATE TABLE IF NOT EXISTS demo_dataset (version text PRIMARY KEY)');
    const marker = await c.query('SELECT version FROM demo_dataset');
    if (marker.rowCount) {
      if (marker.rows[0].version !== dataset) throw new Error('Unsupported demo dataset');
      return;
    }
    if ((await c.query('SELECT 1 FROM users UNION ALL SELECT 1 FROM applications UNION ALL SELECT 1 FROM rules WHERE actor_id IS NOT NULL OR NOT prototype LIMIT 1')).rowCount)
      throw new Error('Refusing to seed populated, unmarked database');
    await c.query(`CREATE TABLE demo_fixtures (character_key text PRIMARY KEY, character_name text NOT NULL, state text NOT NULL CHECK(state IN ('member','outsider','missing','unavailable')))`);
    const user = async (email: string, role = 'USER') => (await c.query('INSERT INTO users(email,password_hash,role) VALUES ($1,$2,$3) RETURNING id', [email+'@demo.test', hash, role])).rows[0].id;
    const admin = await user('admin','ADMIN');
    await user('moderator','MODERATOR');
    const rules: number[] = [];
    for (const version of [1,2]) rules.push((await c.query('INSERT INTO rules(content,prototype,actor_id) VALUES ($1,false,$2) RETURNING id', [`DEMO RULES v${version}\nRespect players. No cheating. Coordinate guild groups.${version===2 ? '\nCommunicate absences before scheduled raids.' : ''}`,admin])).rows[0].id);
    for (const kind of ['submitted','approved','rejected','reopened','resubmitted','manual','armory']) {
      const uid = await user(kind), name = `Demo ${kind[0]!.toUpperCase()+kind.slice(1)}`, key = name.toLowerCase();
      const status = ({manual:'JOINED',armory:'JOINED',resubmitted:'SUBMITTED'} as Record<string,string>)[kind] || kind.toUpperCase();
      const revision = kind === 'resubmitted' ? 2 : 1;
      const id = (await c.query(`INSERT INTO applications(user_id,character_name,character_key,status,revision,joined_via,next_check_at,check_result) VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $4='APPROVED' THEN now()+interval '15 minutes' END,$7) RETURNING id`,[uid,name,key,status,revision,kind==='manual'?'MANUAL':kind==='armory'?'ARMORY':null,kind==='armory'?'MATCH':null])).rows[0].id;
      const event = async (from: string|null,to: string,actor: string|null,method: string,note='') => { await c.query('INSERT INTO events(application_id,from_status,to_status,actor_id,method,note) VALUES ($1,$2,$3,$4,$5,$6)',[id,from,to,actor,method,note]); };
      for (let rev=1;rev<=revision;rev++) {
        const submission = (await c.query(`INSERT INTO submissions(application_id,revision,character_name,character_key,motivation,rules_id,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[id,rev,name,key,rev===2?'I clarified my raid availability: evenings and weekends. I enjoy coordinated groups.':'I enjoy coordinated PvP and helping guildmates gear up. I can join evening groups twice a week.',rules[rev-1],uid])).rows[0].id;
        await c.query("INSERT INTO discord_jobs(submission_id,status) VALUES ($1,'DISABLED')",[submission]);
        await event(rev===1?null:'REOPENED','SUBMITTED',uid,'APPLICANT');
        if (rev===1 && ['rejected','reopened','resubmitted'].includes(kind)) {
          await event('SUBMITTED','REJECTED',admin,'STAFF','Please clarify your availability.');
          if (kind!=='rejected') await event('REJECTED','REOPENED',admin,'STAFF','You may revise your application.');
        }
      }
      if (['approved','manual','armory'].includes(kind)) await event('SUBMITTED','APPROVED',admin,'STAFF','Good fit for our evening groups.');
      if (status==='JOINED') await event('APPROVED','JOINED',kind==='manual'?admin:null,kind==='manual'?'MANUAL':'ARMORY','Demo membership confirmed.');
      await c.query('INSERT INTO demo_fixtures VALUES ($1,$2,$3)',[key,name,['submitted','armory'].includes(kind)?'member':'outsider']);
    }
    await c.query('INSERT INTO demo_dataset VALUES ($1)',[dataset]);
  });
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const pool = createPool(process.env.DATABASE_URL || '');
  try { await seed(pool,process.env.DEMO_PASSWORD || ''); console.log('Demo dataset ready.'); }
  finally { await pool.end(); }
}
