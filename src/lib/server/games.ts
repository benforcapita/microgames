import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db';
import { GAMES_DIR, GRADUATION } from './config';

export type Stage = 'proving' | 'live';

export interface Game {
  id: string;
  slug: string;
  title: string;
  tagline: string;
  description: string;
  creator: string;
  tags: string[];
  license: string;
  stage: Stage;
  forkedFrom: string | null;
  sizeBytes: number;
  hue: number;
  thumb: string | null;
  createdAt: number;
  graduatedAt: number | null;
  plays: number;
  avgRating: number | null;
  ratingCount: number;
}

interface GameRow {
  id: string;
  slug: string;
  title: string;
  tagline: string;
  description: string;
  creator: string;
  tags: string;
  license: string;
  stage: Stage;
  forked_from: string | null;
  size_bytes: number;
  hue: number;
  thumb: string | null;
  created_at: number;
  graduated_at: number | null;
  plays: number;
  avg_rating: number | null;
  rating_count: number;
}

const SELECT_GAME = `
  SELECT g.*,
    (SELECT COUNT(*) FROM sessions s WHERE s.game_id = g.id) AS plays,
    (SELECT AVG(stars) FROM ratings r WHERE r.game_id = g.id) AS avg_rating,
    (SELECT COUNT(*) FROM ratings r WHERE r.game_id = g.id) AS rating_count
  FROM games g`;

function toGame(r: GameRow): Game {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    tagline: r.tagline,
    description: r.description,
    creator: r.creator,
    tags: r.tags ? r.tags.split(',') : [],
    license: r.license,
    stage: r.stage,
    forkedFrom: r.forked_from,
    sizeBytes: r.size_bytes,
    hue: r.hue,
    thumb: r.thumb,
    createdAt: r.created_at,
    graduatedAt: r.graduated_at,
    plays: r.plays,
    avgRating: r.avg_rating,
    ratingCount: r.rating_count,
  };
}

export interface ListOptions {
  stage?: Stage;
  sort?: 'top' | 'new' | 'rated';
  tag?: string;
  creator?: string;
  limit?: number;
}

export function listGames({ stage, sort = 'top', tag, creator, limit = 60 }: ListOptions = {}): Game[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (stage) where.push('g.stage = ?'), params.push(stage);
  if (creator) where.push('g.creator = ?'), params.push(creator);
  if (tag) where.push("(',' || g.tags || ',') LIKE ?"), params.push(`%,${tag},%`);
  const order = { top: 'plays DESC', new: 'g.created_at DESC', rated: 'COALESCE(avg_rating, 0) DESC, rating_count DESC' }[sort];
  const sql = `SELECT * FROM (${SELECT_GAME}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}) g ORDER BY ${order} LIMIT ?`;
  return (getDb().prepare(sql).all(...params, limit) as unknown as GameRow[]).map(toGame);
}

export function getGame(slugOrId: string): Game | null {
  const row = getDb().prepare(`${SELECT_GAME} WHERE g.slug = ? OR g.id = ?`).get(slugOrId, slugOrId) as GameRow | undefined;
  return row ? toGame(row) : null;
}

export function listTags(): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { tags } of getDb().prepare('SELECT tags FROM games').all() as { tags: string }[]) {
    for (const t of tags.split(',').filter(Boolean)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

export function platformStats() {
  return getDb()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM games) AS games,
              (SELECT COUNT(*) FROM games WHERE stage = 'live') AS live,
              (SELECT COUNT(*) FROM sessions) AS plays,
              (SELECT COUNT(DISTINCT creator) FROM games) AS creators`,
    )
    .get() as { games: number; live: number; plays: number; creators: number };
}

const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'game';

export function normalizeTags(raw: string): string[] {
  return [...new Set(raw.split(/[,\s]+/).map((t) => slugify(t)).filter((t) => t && t !== 'game'))].slice(0, 6);
}

export interface NewGame {
  title: string;
  tagline: string;
  description: string;
  creator: string;
  tags: string[];
  license: string;
  forkedFrom: string | null;
  html: Uint8Array;
  thumb?: { bytes: Uint8Array; ext: string };
}

export function createGame(input: NewGame): Game {
  const db = getDb();
  const id = crypto.randomBytes(6).toString('base64url');
  let slug = slugify(input.title);
  if (db.prepare('SELECT 1 FROM games WHERE slug = ?').get(slug)) slug = `${slug}-${id.slice(0, 4).toLowerCase()}`;

  const dir = path.join(GAMES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), input.html);
  const thumb = input.thumb ? `thumb.${input.thumb.ext}` : null;
  if (input.thumb && thumb) fs.writeFileSync(path.join(dir, thumb), input.thumb.bytes);

  db.prepare(
    `INSERT INTO games (id, slug, title, tagline, description, creator, tags, license, forked_from, size_bytes, hue, thumb, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, slug, input.title, input.tagline, input.description, input.creator, input.tags.join(','), input.license,
    input.forkedFrom, input.html.byteLength, crypto.randomInt(0, 360), thumb, Date.now(),
  );
  return getGame(id)!;
}

export function rateGame(gameId: string, voter: string, stars: number) {
  getDb()
    .prepare(
      `INSERT INTO ratings (game_id, voter, stars, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (game_id, voter) DO UPDATE SET stars = excluded.stars, created_at = excluded.created_at`,
    )
    .run(gameId, voter, stars, Date.now());
  evaluateGraduation(gameId);
}

export function getUserRating(gameId: string, voter: string): number | null {
  const row = getDb().prepare('SELECT stars FROM ratings WHERE game_id = ? AND voter = ?').get(gameId, voter) as
    | { stars: number }
    | undefined;
  return row?.stars ?? null;
}

export type TelemetryType = 'session_start' | 'first_frame' | 'start' | 'complete' | 'crash' | 'heartbeat';

const MAX_SESSION_MS = 4 * 3600_000;

export function recordTelemetry(sessionId: string, gameId: string, type: TelemetryType, value = 0) {
  const db = getDb();
  switch (type) {
    case 'session_start':
      db.prepare('INSERT OR IGNORE INTO sessions (id, game_id, created_at) VALUES (?, ?, ?)').run(sessionId, gameId, Date.now());
      return;
    case 'first_frame':
      db.prepare('UPDATE sessions SET first_frame_ms = ? WHERE id = ? AND game_id = ? AND first_frame_ms IS NULL').run(
        Math.max(0, Math.round(value)), sessionId, gameId,
      );
      return;
    case 'start':
      db.prepare('UPDATE sessions SET started = 1 WHERE id = ? AND game_id = ?').run(sessionId, gameId);
      break;
    case 'complete':
      db.prepare('UPDATE sessions SET started = 1, completed = 1 WHERE id = ? AND game_id = ?').run(sessionId, gameId);
      break;
    case 'crash':
      db.prepare('UPDATE sessions SET crashed = 1 WHERE id = ? AND game_id = ?').run(sessionId, gameId);
      break;
    case 'heartbeat':
      db.prepare('UPDATE sessions SET duration_ms = MAX(duration_ms, ?) WHERE id = ? AND game_id = ?').run(
        Math.min(MAX_SESSION_MS, Math.max(0, Math.round(value))), sessionId, gameId,
      );
      break;
  }
  evaluateGraduation(gameId);
}

export interface HealthCheck {
  key: string;
  label: string;
  value: number | null;
  target: number;
  format: 'count' | 'pct' | 'sec' | 'stars';
  comparator: 'gte' | 'lte';
  pass: boolean;
}

export function getHealth(gameId: string): { checks: HealthCheck[]; eligible: boolean } {
  const db = getDb();
  const s = db
    .prepare(
      `SELECT COUNT(*) AS plays,
         AVG(CASE WHEN first_frame_ms IS NOT NULL AND first_frame_ms <= ? THEN 1.0 ELSE 0.0 END) AS ff_ok,
         AVG(crashed * 1.0) AS crash_rate,
         AVG(started * 1.0) AS start_rate,
         AVG(CASE WHEN started = 1 THEN completed * 1.0 END) AS completion_rate
       FROM sessions WHERE game_id = ?`,
    )
    .get(GRADUATION.maxFirstFrameMs, gameId) as {
    plays: number;
    ff_ok: number | null;
    crash_rate: number | null;
    start_rate: number | null;
    completion_rate: number | null;
  };
  const started = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE game_id = ? AND started = 1').get(gameId) as { n: number };
  const median = started.n
    ? (db
        .prepare('SELECT duration_ms FROM sessions WHERE game_id = ? AND started = 1 ORDER BY duration_ms LIMIT 1 OFFSET ?')
        .get(gameId, Math.floor(started.n / 2)) as { duration_ms: number })
    : null;
  const r = db.prepare('SELECT AVG(stars) AS avg, COUNT(*) AS n FROM ratings WHERE game_id = ?').get(gameId) as {
    avg: number | null;
    n: number;
  };

  const G = GRADUATION;
  const check = (
    key: string, label: string, value: number | null, target: number, format: HealthCheck['format'],
    comparator: HealthCheck['comparator'] = 'gte', passOverride?: boolean,
  ): HealthCheck => ({
    key, label, value, target, format, comparator,
    pass: passOverride ?? (value !== null && (comparator === 'gte' ? value >= target : value <= target)),
  });

  const checks = [
    check('plays', 'Plays measured', s.plays, G.minPlays, 'count'),
    check('first_frame', `First frame under ${G.maxFirstFrameMs / 1000}s`, s.ff_ok, G.minFirstFrameOkRate, 'pct'),
    check('crash', 'Crash rate', s.crash_rate, G.maxCrashRate, 'pct', 'lte'),
    check('start', 'Start rate', s.start_rate, G.minStartRate, 'pct'),
    check('completion', 'Loop completion rate', s.completion_rate, G.minCompletionRate, 'pct'),
    check('session', 'Median session', median ? median.duration_ms / 1000 : null, G.minMedianSessionSec, 'sec'),
    check('rating', `Community rating (${r.n} votes)`, r.avg, G.minAvgRating, 'stars', 'gte',
      r.n < G.minRatingsForRatingGate ? true : undefined),
  ];
  return { checks, eligible: checks.every((c) => c.pass) };
}

export function evaluateGraduation(gameId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT stage FROM games WHERE id = ?').get(gameId) as { stage: Stage } | undefined;
  if (!row || row.stage === 'live' || !getHealth(gameId).eligible) return false;
  db.prepare("UPDATE games SET stage = 'live', graduated_at = ? WHERE id = ?").run(Date.now(), gameId);
  return true;
}
