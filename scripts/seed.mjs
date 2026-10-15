// Seeds demo games (+ synthetic plays/ratings) into Supabase. Usage: npm run seed [-- --force]
// Intended for local / staging projects — the play data it creates is fake.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { DATABASE_URL, PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!DATABASE_URL || !PUBLIC_SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Missing Supabase env vars (see .env.example)');

const sql = postgres(DATABASE_URL, { prepare: false });
const storage = createClient(PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } }).storage.from('games');
const force = process.argv.includes('--force');
const games = JSON.parse(fs.readFileSync('seed/games.json', 'utf8'));

try {
  const [{ n }] = await sql`select count(*)::int as n from games where id in ${sql(games.map((g) => g.id))}`;
  if (n && !force) {
    console.log('Seed games already present. Re-run with --force to replace them.');
    process.exit(0);
  }
  await sql`delete from games where id in ${sql(games.map((g) => g.id))}`;

  const now = Date.now(), day = 86_400_000;
  for (const [i, s] of games.entries()) {
    const html = fs.readFileSync(path.join('seed/games', s.file));
    const { error } = await storage.upload(`${s.id}/index.html`, html, { contentType: 'text/html; charset=utf-8', upsert: true });
    if (error) throw error;
    const created = now - (games.length - i) * 3 * day;
    await sql`
      insert into games (id, slug, creator, title, tagline, description, tags, license, stage, size_bytes, hue, created_at, graduated_at)
      values (${s.id}, ${s.file.replace(/\.html$/, '')}, ${s.creator}, ${s.title}, ${s.tagline}, ${s.description}, ${s.tags},
              ${s.license}, ${s.stage}, ${html.byteLength}, ${s.hue}, ${new Date(created)},
              ${s.stage === 'live' ? new Date(created + day) : null})`;

    const q = s.quality;
    const sessions = Array.from({ length: s.sessions }, () => {
      const started = Math.random() < 0.55 + q * 0.4;
      return {
        id: crypto.randomUUID(),
        game_id: s.id,
        created_at: new Date(created + Math.random() * (now - created)),
        first_frame_ms: Math.round(400 + Math.random() * 1800),
        started,
        completed: started && Math.random() < 0.2 + q * 0.3,
        crashed: Math.random() < 0.01,
        duration_ms: started ? Math.round((30 + Math.random() * 300 * q) * 1000) : Math.round(Math.random() * 15000),
      };
    });
    await sql`insert into sessions ${sql(sessions)}`;
    const ratings = Array.from({ length: Math.round(s.sessions * 0.12) }, (_, k) => ({
      game_id: s.id,
      voter: `seed-${k}`,
      stars: Math.min(5, Math.max(1, Math.round(2 + q * 3 + (Math.random() - 0.5) * 2))),
    }));
    if (ratings.length) await sql`insert into ratings ${sql(ratings)}`;
    console.log(`seeded ${s.title} (${s.sessions} plays)`);
  }
} finally {
  await sql.end();
}
