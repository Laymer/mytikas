import { createPool } from '../db.js';
import { checkMembership } from '../armory.js';
import { fixtureVerifier, states } from './fixtures.js';
const pool = createPool(process.env.DATABASE_URL || '');
const [command, email, state] = process.argv.slice(2);
try {
  if (command==='ready') {
    if (!(await pool.query("SELECT 1 FROM demo_dataset WHERE version='mytikas-demo-v1'")).rowCount) throw new Error('Demo seed not ready');
    await pool.query('SELECT 1 FROM demo_fixtures LIMIT 1');
  } else if (command==='accounts' || command==='summary') {
    console.table((await pool.query(command==='accounts' ? 'SELECT u.email,u.role,a.status FROM users u LEFT JOIN applications a ON a.user_id=u.id ORDER BY u.email' : 'SELECT a.status,count(*) FROM applications a GROUP BY a.status ORDER BY a.status')).rows);
    if (command==='accounts') console.log('Shared demo password:',process.env.DEMO_PASSWORD);
    else console.table((await pool.query('SELECT * FROM demo_fixtures ORDER BY character_key')).rows);
  } else if (command==='armory' || command==='check') {
    const {rows:[app]} = await pool.query('SELECT a.* FROM applications a JOIN users u ON u.id=a.user_id WHERE u.email=$1',[email]);
    if (!app) throw new Error('Applicant not found');
    if (command==='check') console.log(await checkMembership(pool,app.id,fixtureVerifier(pool)));
    else {
      if (!states.includes(state || '')) throw new Error('State must be member, outsider, missing, or unavailable');
      await pool.query('INSERT INTO demo_fixtures VALUES ($1,$2,$3) ON CONFLICT(character_key) DO UPDATE SET state=$3, character_name=$2',[app.character_key,app.character_name,state]);
      console.log('Demo fixture updated.');
    }
  } else throw new Error('Unknown demo command');
} finally { await pool.end(); }
