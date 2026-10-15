import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, GAMES_DIR, SEED_DIR } from './config';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT 'MIT',
  stage TEXT NOT NULL DEFAULT 'proving' CHECK (stage IN ('proving', 'live')),
  forked_from TEXT REFERENCES games(id),
  size_bytes INTEGER NOT NULL DEFAULT 0,
  hue INTEGER NOT NULL DEFAULT 200,
  thumb TEXT,
  created_at INTEGER NOT NULL,
  graduated_at INTEGER
);
CREATE INDEX IF NOT EXISTS games_stage_idx ON games(stage, created_at);
CREATE INDEX IF NOT EXISTS games_creator_idx ON games(creator);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  first_frame_ms INTEGER,
  started INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  crashed INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_game_idx ON sessions(game_id);

CREATE TABLE IF NOT EXISTS ratings (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  voter TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, voter)
);
`;

const g = globalThis as typeof globalThis & { __mgDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (g.__mgDb) return g.__mgDb;
  fs.mkdirSync(GAMES_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'meshgrounds.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  seedIfEmpty(db);
  g.__mgDb = db;
  return db;
}

interface SeedGame {
  id: string;
  file: string;
  title: string;
  tagline: string;
  description: string;
  creator: string;
  tags: string[];
  license: string;
  hue: number;
  stage: 'proving' | 'live';
  sessions: number;
  quality: number;
}

function seedIfEmpty(db: DatabaseSync) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number };
  const manifest = path.join(SEED_DIR, 'games.json');
  if (n > 0 || !fs.existsSync(manifest)) return;

  const games = JSON.parse(fs.readFileSync(manifest, 'utf8')) as SeedGame[];
  const now = Date.now();
  const day = 86_400_000;
  const insertGame = db.prepare(
    `INSERT INTO games (id, slug, title, tagline, description, creator, tags, license, stage, size_bytes, hue, created_at, graduated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, game_id, created_at, first_frame_ms, started, completed, crashed, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRating = db.prepare('INSERT INTO ratings (game_id, voter, stars, created_at) VALUES (?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    games.forEach((s, i) => {
      const html = fs.readFileSync(path.join(SEED_DIR, 'games', s.file));
      fs.mkdirSync(path.join(GAMES_DIR, s.id), { recursive: true });
      fs.writeFileSync(path.join(GAMES_DIR, s.id, 'index.html'), html);
      const created = now - (games.length - i) * 3 * day;
      insertGame.run(
        s.id, s.file.replace(/\.html$/, ''), s.title, s.tagline, s.description, s.creator, s.tags.join(','),
        s.license, s.stage, html.byteLength, s.hue, created, s.stage === 'live' ? created + day : null,
      );
      const q = s.quality;
      for (let k = 0; k < s.sessions; k++) {
        const started = Math.random() < 0.55 + q * 0.4 ? 1 : 0;
        insertSession.run(
          crypto.randomUUID(), s.id, created + Math.random() * (now - created),
          Math.round(400 + Math.random() * 1800), started,
          started && Math.random() < 0.2 + q * 0.3 ? 1 : 0, Math.random() < 0.01 ? 1 : 0,
          started ? Math.round((30 + Math.random() * 300 * q) * 1000) : Math.round(Math.random() * 15000),
        );
      }
      const voters = Math.round(s.sessions * 0.12);
      for (let k = 0; k < voters; k++) {
        const stars = Math.min(5, Math.max(1, Math.round(2 + q * 3 + (Math.random() - 0.5) * 2)));
        insertRating.run(s.id, `seed-${k}`, stars, now);
      }
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
