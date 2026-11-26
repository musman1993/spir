// npm run db:connect
// Asks for the Neon connection string (input hidden), tests it, and writes DATABASE_URL into .env.
import fs from 'node:fs';
import readline from 'node:readline';
import pg from 'pg';

const envPath = new URL('../.env', import.meta.url);

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else rl.output.write(s.includes('\n') ? '\n' : '*'); };
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

let url = process.argv[2] || await ask('Paste the Neon connection string (Neon console > Connect), then press Enter:\n');
url = url.replace(/^psql\s+/, '').replace(/^['"]|['"]$/g, '');
if (!/^postgres(ql)?:\/\/[^:]+:[^@]+@[^/]+\/\w+/.test(url) || /@HOST\//.test(url)) {
  console.error('\nThat does not look like a connection string. It should start with postgresql://user:password@ep-...');
  process.exit(1);
}
url = url.replace(/sslmode=(require|prefer|verify-ca)/, 'sslmode=verify-full');
if (!/sslmode=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'sslmode=verify-full';
const masked = url.replace(/\/\/([^:]+):[^@]*@/, '//$1:****@');

process.stdout.write(`\nTesting ${masked} ... `);
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000 });
try {
  await client.connect();
  const r = await client.query('select current_database() db, current_user u');
  console.log(`connected (database ${r.rows[0].db}, user ${r.rows[0].u}).`);
} catch (e) {
  console.error(`failed: ${e.message}\nNothing was written. Check the password (reset it under Neon console > Roles if unsure) and try again.`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}

let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const lines = env.split('\n').filter((l) => !/^\s*DATABASE_URL_UNPOOLED\s*=/.test(l));
let done = false;
const out = lines.map((l) => {
  if (/^\s*DATABASE_URL\s*=/.test(l)) { if (done) return null; done = true; return `DATABASE_URL=${url}`; }
  return l;
}).filter((l) => l !== null);
if (!done) out.unshift(`DATABASE_URL=${url}`);
fs.writeFileSync(envPath, out.join('\n'));
console.log('Saved DATABASE_URL to .env. Next: npm run db:setup');
