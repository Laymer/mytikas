import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const demo = process.argv[2] === 'demo';
const file = demo ? '.env.demo' : '.env';
const password = randomBytes(32).toString('hex');
const user = demo ? 'mytikas_demo' : 'mytikas';
try {
  await writeFile(file, `POSTGRES_USER=${user}\nPOSTGRES_DB=${user}\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=postgres://${user}:${password}@localhost:5432/${user}\nSESSION_SECRET=${randomBytes(48).toString('hex')}\nAPP_ORIGIN=http://localhost:${demo ? 8081 : 8080}\nPORT=8080\nDISCORD_WEBHOOK_URL=\n${demo ? `DEMO_PASSWORD=${randomBytes(18).toString('hex')}\n` : ''}`, {flag:'wx',mode:0o600});
  console.log(`Created private ${file}`);
} catch (error) { if (error.code !== 'EEXIST') throw error; console.log(`${file} exists; preserved.`); }
