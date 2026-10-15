import crypto from 'node:crypto';
import { GRADUATION } from './config';
import { sql } from './db';
import { BAYES_PRIOR_VOTES, assessHealth, clampDurationMs, clampFirstFrameMs, slugify, uniqueSlug, type HealthCheck } from './game-rules';
import { insertSessionStart, postgresSchemaClient } from './schema-rollout';
import { bucket } from './supabase';

export { normalizeTags } from './game-rules';
export type { HealthCheck };

export type Stage = 'proving' | 'live';

export interface Game {
  id: string;
  slug: string;
  ownerId: string | null;
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
  owner_id: string | null;
  title: string;
  tagline: string;
  description: string;
  creator: string;
  tags: string[];
  license: string;
  stage: Stage;
  forked_from: string | null;
  size_bytes: number;
  hue: number;
  thumb: string | null;
  created_at: Date;
  graduated_at: Date | null;
  plays: number;
  avg_rating: number | null;
  rating_count: number;
}

const gameSelect = () => sql`
  select g.*,
    (select count(*)::int from sessions s where s.game_id = g.id) as plays,
    (select avg(stars)::float8 from ratings r where r.game_id = g.id) as avg_rating,
    (select count(*)::int from ratings r where r.game_id = g.id) as rating_count
  from games g`;

function toGame(r: GameRow): Game {
  return {
    id: r.id,
    slug: r.slug,
    ownerId: r.owner_id,
    title: r.title,
    tagline: r.tagline,
    description: r.description,
    creator: r.creator,
    tags: r.tags,
    license: r.license,
    stage: r.stage,
    forkedFrom: r.forked_from,
    sizeBytes: r.size_bytes,
    hue: r.hue,
    thumb: r.thumb,
    createdAt: r.created_at.getTime(),
    graduatedAt: r.graduated_at?.getTime() ?? null,
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
  ownerId?: string;
  forkedFrom?: string;
  limit?: number;
}

const ORDER = {
  top: 'plays desc, created_at desc',
  new: 'created_at desc',
  // Bayesian average (see bayesianRating in game-rules.ts): (C*m + sum) / (C + n), m = global mean of all stars.
  rated: `(${BAYES_PRIOR_VOTES} * (select coalesce(avg(stars)::float8, 3) from ratings) + coalesce(avg_rating, 0) * rating_count) / (${BAYES_PRIOR_VOTES} + rating_count) desc, rating_count desc, created_at desc`,
} as const;

export async function listGames({ stage, sort = 'top', tag, creator, ownerId, forkedFrom, limit = 60 }: ListOptions = {}) {
  const rows = await sql<GameRow[]>`
    select * from (${gameSelect()}) g
    where true
      ${stage ? sql`and stage = ${stage}` : sql``}
      ${creator ? sql`and lower(creator) = lower(${creator})` : sql``}
      ${ownerId ? sql`and owner_id = ${ownerId}` : sql``}
      ${forkedFrom ? sql`and forked_from = ${forkedFrom}` : sql``}
      ${tag ? sql`and ${tag} = any(tags)` : sql``}
    order by ${sql.unsafe(ORDER[sort] ?? ORDER.top)}
    limit ${limit}`;
  return rows.map(toGame);
}

export async function getGame(slugOrId: string): Promise<Game | null> {
  const [row] = await sql<GameRow[]>`${gameSelect()} where g.slug = ${slugOrId} or g.id = ${slugOrId}`;
  return row ? toGame(row) : null;
}

export async function listTags(): Promise<{ tag: string; count: number }[]> {
  return sql<{ tag: string; count: number }[]>`
    select t as tag, count(*)::int as count from games, unnest(tags) t group by t order by count desc, t limit 30`;
}

export async function platformStats() {
  const [row] = await sql<{ games: number; live: number; plays: number; creators: number }[]>`
    select (select count(*)::int from games) as games,
           (select count(*)::int from games where stage = 'live') as live,
           (select count(*)::int from sessions) as plays,
           (select count(distinct creator)::int from games) as creators`;
  return row;
}

export interface NewGame {
  ownerId: string;
  creator: string;
  title: string;
  tagline: string;
  description: string;
  tags: string[];
  license: string;
  forkedFrom: string | null;
  html: Uint8Array;
  thumb?: { bytes: Uint8Array; ext: string; type: string };
}

export async function createGame(input: NewGame): Promise<Game> {
  const id = crypto.randomBytes(6).toString('base64url');
  const base = slugify(input.title);
  const [clash] = await sql`select 1 from games where slug = ${base}`;
  const slug = uniqueSlug(input.title, Boolean(clash), id);

  const upload = async (path: string, bytes: Uint8Array, contentType: string) => {
    const { error } = await bucket().upload(path, bytes, { contentType, upsert: true });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  };
  await upload(`${id}/index.html`, input.html, 'text/html; charset=utf-8');
  const thumb = input.thumb ? `thumb.${input.thumb.ext}` : null;
  if (input.thumb && thumb) await upload(`${id}/${thumb}`, input.thumb.bytes, input.thumb.type);

  await sql`
    insert into games (id, slug, owner_id, creator, title, tagline, description, tags, license, forked_from, size_bytes, hue, thumb)
    values (${id}, ${slug}, ${input.ownerId}, ${input.creator}, ${input.title}, ${input.tagline}, ${input.description},
            ${input.tags}, ${input.license}, ${input.forkedFrom}, ${input.html.byteLength}, ${crypto.randomInt(0, 360)}, ${thumb})`;
  return (await getGame(id))!;
}

/** Deletes a game owned by `ownerId`, including its bundle in storage. Returns false if not found / not owned. */
export async function deleteGame(gameId: string, ownerId: string): Promise<boolean> {
  const [row] = await sql<{ id: string; thumb: string | null }[]>`
    delete from games where id = ${gameId} and owner_id = ${ownerId} returning id, thumb`;
  if (!row) return false;
  await bucket().remove([`${row.id}/index.html`, ...(row.thumb ? [`${row.id}/${row.thumb}`] : [])]);
  return true;
}

export async function rateGame(gameId: string, voter: string, stars: number) {
  await sql`
    insert into ratings (game_id, voter, stars) values (${gameId}, ${voter}, ${stars})
    on conflict (game_id, voter) do update set stars = excluded.stars, created_at = now()`;
  await evaluateGraduation(gameId);
}

export async function getUserRating(gameId: string, voter: string | undefined): Promise<number | null> {
  if (!voter) return null;
  const [row] = await sql<{ stars: number }[]>`select stars from ratings where game_id = ${gameId} and voter = ${voter}`;
  return row?.stars ?? null;
}

export type TelemetryType = 'session_start' | 'first_frame' | 'start' | 'complete' | 'crash' | 'heartbeat';

export async function recordTelemetry(
  sessionId: string,
  gameId: string,
  type: TelemetryType,
  value: unknown = 0,
  userId: string | null = null,
) {
  const where = sql`where id = ${sessionId} and game_id = ${gameId}`;
  switch (type) {
    case 'session_start':
      await insertSessionStart(postgresSchemaClient(sql), { sessionId, gameId, userId });
      return;
    case 'first_frame': {
      const ms = clampFirstFrameMs(value);
      if (ms !== null) {
        await sql`update sessions set first_frame_ms = ${ms} ${where} and first_frame_ms is null`;
      }
      return;
    }
    case 'start':
      await sql`update sessions set started = true ${where}`;
      break;
    case 'complete':
      await sql`update sessions set started = true, completed = true ${where}`;
      break;
    case 'crash':
      await sql`update sessions set crashed = true ${where}`;
      break;
    case 'heartbeat':
      await sql`update sessions set duration_ms = greatest(duration_ms, ${clampDurationMs(value)}) ${where}`;
      break;
  }
  await evaluateGraduation(gameId);
}

export async function getHealth(gameId: string): Promise<{ checks: HealthCheck[]; eligible: boolean }> {
  const G = GRADUATION;
  const [s] = await sql<
    {
      plays: number;
      ff_ok: number | null;
      crash_rate: number | null;
      start_rate: number | null;
      completion_rate: number | null;
      median_ms: number | null;
      avg_rating: number | null;
      rating_count: number;
    }[]
  >`
    select count(*)::int as plays,
      (avg(case when first_frame_ms is not null and first_frame_ms <= ${G.maxFirstFrameMs} then 1.0 else 0.0 end))::float8 as ff_ok,
      (avg(crashed::int))::float8 as crash_rate,
      (avg(started::int))::float8 as start_rate,
      (avg(completed::int) filter (where started))::float8 as completion_rate,
      (percentile_disc(0.5) within group (order by duration_ms) filter (where started))::float8 as median_ms,
      (select avg(stars)::float8 from ratings where game_id = ${gameId}) as avg_rating,
      (select count(*)::int from ratings where game_id = ${gameId}) as rating_count
    from sessions where game_id = ${gameId}`;

  return assessHealth({
    plays: s.plays,
    ffOk: s.ff_ok,
    crashRate: s.crash_rate,
    startRate: s.start_rate,
    completionRate: s.completion_rate,
    medianMs: s.median_ms,
    avgRating: s.avg_rating,
    ratingCount: s.rating_count,
  }, G);
}

export async function evaluateGraduation(gameId: string): Promise<boolean> {
  const [row] = await sql<{ stage: Stage }[]>`select stage from games where id = ${gameId}`;
  if (!row || row.stage === 'live' || !(await getHealth(gameId)).eligible) return false;
  await sql`update games set stage = 'live', graduated_at = now() where id = ${gameId} and stage = 'proving'`;
  return true;
}
