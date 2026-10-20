// Grants or revokes the admin role on a profile. Usage:
//   npm run admin:grant -- <handle>            (role = admin)
//   npm run admin:grant -- <handle> --revoke   (role = user)
// Reads DATABASE_URL from .env. Admins see /admin: analytics and the manual-review queue.
import fs from 'node:fs';
import postgres from 'postgres';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL (see .env.example)');

const args = process.argv.slice(2).filter((a) => a !== '--');
const revoke = args.includes('--revoke');
const handle = args.find((a) => !a.startsWith('--'));
if (!handle) {
  console.error('Usage: npm run admin:grant -- <handle> [--revoke]');
  process.exit(2);
}

const sql = postgres(DATABASE_URL, { prepare: false, max: 1 });
try {
  const role = revoke ? 'user' : 'admin';
  const rows = await sql`update profiles set role = ${role} where lower(handle) = lower(${handle}) returning handle, role`;
  if (!rows.length) {
    console.error(`No profile with handle @${handle}.`);
    process.exit(1);
  }
  console.log(`@${rows[0].handle} is now ${rows[0].role}.`);
} finally {
  await sql.end({ timeout: 1 });
}
