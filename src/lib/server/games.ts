import crypto from 'node:crypto';
import type postgres from 'postgres';
import { GRADUATION } from './config';
import { sql } from './db';
import { BAYES_PRIOR_VOTES, CREATED_GAME_LOOKUP, LISTABLE_STAGES, PUBLIC_STAGES, assessHealth, canViewGame, visibleStages, clampDurationMs, clampFirstFrameMs, ratingUserId, slugify, uniqueSlug, type HealthCheck, type Stage } from './game-rules';
import { recordScannedGameAssets } from './asset-manifest';
import { saveUploadedBundle, type BundleStorage } from './bundle-store';
import { filterForDevice, readWithInputSupport, type DeviceKind } from './device';
import { insertSessionStart, postgresSchemaClient } from './schema-rollout';
import { bucket } from './supabase';
import { toInputSupport, type InputSupport } from '../input-support';
import { replaceBlocker } from '../api-games';

export type { Stage, InputSupport };

export { normalizeTags } from './game-rules';
export type { HealthCheck };
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
  /** IS-1: 'mobile' | 'desktop' | 'both' | 'unknown' (declared by the game or detected by the static check). */
  inputSupport: InputSupport;
  createdAt: number;
  graduatedAt: number | null;
  /** Reviewer note. Set in the table editor, shown to the owner when the game is rejected. */
  reviewNote: string | null;
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
  input_support: string | null;
  created_at: Date;
  graduated_at: Date | null;
  review_note?: string | null;
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
    inputSupport: toInputSupport(r.input_support),
    createdAt: r.created_at.getTime(),
    graduatedAt: r.graduated_at?.getTime() ?? null,
    reviewNote: r.review_note ?? null,
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
  /** Owner dashboards only (requires ownerId): also return pending/rejected games. */
  includeUnpublished?: boolean;
  /** Owner-scoped views only (requires ownerId): also return the owner's own unlisted (proving) games. PV-1. */
  includeUnlisted?: boolean;
  /** Mobile hides input_support = desktop. Omit on the owner dashboard so creators can still manage those games. */
  device?: DeviceKind;
}

const ORDER = {
  top: 'plays desc, created_at desc',
  new: 'created_at desc',
  // Bayesian average (see bayesianRating in game-rules.ts): (C*m + sum) / (C + n), m = global mean of all stars.
  rated: `(${BAYES_PRIOR_VOTES} * (select coalesce(avg(stars)::float8, 3) from ratings) + coalesce(avg_rating, 0) * rating_count) / (${BAYES_PRIOR_VOTES} + rating_count) desc, rating_count desc, created_at desc`,
} as const;

const hideDesktopOnly = (filter: boolean) => (filter ? sql`and input_support is distinct from 'desktop'` : sql``);

export async function listGames({ stage, sort = 'top', tag, creator, ownerId, forkedFrom, limit = 60, includeUnpublished, includeUnlisted, device }: ListOptions = {}) {
  const stages = visibleStages({ stage, ownerId, includeUnpublished, includeUnlisted });
  if (!stages.length) return [];
  const rows = await readWithInputSupport(device === 'mobile', (filter) => sql<GameRow[]>`
    select * from (${gameSelect()}) g
    where true
      and stage in ${sql(stages)}
      ${creator ? sql`and lower(creator) = lower(${creator})` : sql``}
      ${ownerId ? sql`and owner_id = ${ownerId}` : sql``}
      ${forkedFrom ? sql`and forked_from = ${forkedFrom}` : sql``}
      ${tag ? sql`and ${tag} = any(tags)` : sql``}
      ${hideDesktopOnly(filter)}
    order by ${sql.unsafe(ORDER[sort] ?? ORDER.top)}
    limit ${limit}`);
  return filterForDevice(rows.map(toGame), device ?? 'desktop');
}

/** Listable games by id (CM-1 featured row). PV-1: never returns unlisted games. */
export async function listGamesByIds(ids: string[], device?: DeviceKind): Promise<Game[]> {
  const stages = [...LISTABLE_STAGES];
  if (!ids.length) return [];
  const rows = await readWithInputSupport(device === 'mobile', (filter) => sql<GameRow[]>`
    select * from (${gameSelect()}) g
    where id in ${sql(ids)} and stage in ${sql(stages)}
    ${hideDesktopOnly(filter)}`);
  return filterForDevice(rows.map(toGame), device ?? 'desktop');
}

/**
 * Public lookup: pending/rejected games are invisible unless `includeUnpublished` (owner-only
 * callers such as delete/createGame) or the `viewerId` owns the game (see canViewGame).
 */
export async function getGame(
  slugOrId: string,
  { includeUnpublished = false, viewerId, db = sql }: { includeUnpublished?: boolean; viewerId?: string | null; db?: GameDb } = {},
): Promise<Game | null> {
  const unfiltered = includeUnpublished || !!viewerId;
  const [row] = await db<GameRow[]>`${gameSelect()} where (g.slug = ${slugOrId} or g.id = ${slugOrId})
    ${unfiltered ? sql`` : sql`and g.stage in ${sql([...PUBLIC_STAGES])}`}`;
  if (!row) return null;
  const game = toGame(row);
  return includeUnpublished || canViewGame(game, viewerId) ? game : null;
}

export interface OwnerReviewMark {
  reviewNote: string | null;
  latestStatus: string | null;
}

/** Latest validation status and reviewer note for the owner's dashboard. */
export async function ownerReviewMarks(ids: string[]): Promise<Map<string, OwnerReviewMark>> {
  const out = new Map<string, OwnerReviewMark>();
  if (!ids.length) return out;
  const rows = await sql<{ id: string; review_note: string | null; latest_status: string | null }[]>`
    select g.id, g.review_note, v.status as latest_status
    from games g
    left join lateral (
      select status from game_validations
      where game_id = g.id
      order by version desc
      limit 1
    ) v on true
    where g.id in ${sql(ids)}`;
  for (const row of rows) out.set(row.id, { reviewNote: row.review_note, latestStatus: row.latest_status });
  return out;
}

export async function listTags(device?: DeviceKind): Promise<{ tag: string; count: number }[]> {
  return readWithInputSupport(device === 'mobile', (filter) => sql<{ tag: string; count: number }[]>`
    select t as tag, count(*)::int as count from games, unnest(tags) t
    where stage in ${sql([...LISTABLE_STAGES])}
    ${hideDesktopOnly(filter)}
    group by t order by count desc, t limit 30`);
}

export async function platformStats(device?: DeviceKind) {
  const [row] = await readWithInputSupport(device === 'mobile', (filter) => sql<{ games: number; live: number; plays: number; creators: number }[]>`
    select (select count(*)::int from games where stage in ${sql([...LISTABLE_STAGES])} ${hideDesktopOnly(filter)}) as games,
           (select count(*)::int from games where stage = 'live' ${hideDesktopOnly(filter)}) as live,
           (select count(*)::int from sessions s join games g on g.id = s.game_id where g.stage in ${sql([...LISTABLE_STAGES])} ${filter ? sql`and g.input_support is distinct from 'desktop'` : sql``}) as plays,
           (select count(distinct creator)::int from games where stage in ${sql([...LISTABLE_STAGES])} ${hideDesktopOnly(filter)}) as creators`);
  return row;
}

function bundleStorage(): BundleStorage {
  return {
    upload: (path, bytes, contentType) => bucket().upload(path, bytes, { contentType, upsert: true }),
    remove: (paths) => bucket().remove(paths),
  };
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
  /** New uploads stay pending until validation passes. Auto-publish is EF-1/EF-2, not this insert. */
  stage: 'pending';
}

export async function createGame(input: NewGame, storage: BundleStorage = bundleStorage()): Promise<Game> {
  const id = crypto.randomBytes(6).toString('base64url');
  const base = slugify(input.title);
  const [clash] = await sql`select 1 from games where slug = ${base}`;
  const slug = uniqueSlug(input.title, Boolean(clash), id);

  const stage = input.stage ?? 'pending';
  const thumb = input.thumb ? `thumb.${input.thumb.ext}` : null;
  const objects = [
    { path: `${id}/index.html`, bytes: input.html, contentType: 'text/html; charset=utf-8' },
    ...(input.thumb && thumb ? [{ path: `${id}/${thumb}`, bytes: input.thumb.bytes, contentType: input.thumb.type }] : []),
  ];
  await saveUploadedBundle({
    objects,
    storage,
    insert: () => sql`
      insert into games (id, slug, owner_id, creator, title, tagline, description, tags, license, forked_from, size_bytes, hue, thumb, stage)
      values (${id}, ${slug}, ${input.ownerId}, ${input.creator}, ${input.title}, ${input.tagline}, ${input.description},
              ${input.tags}, ${input.license}, ${input.forkedFrom}, ${input.html.byteLength}, ${crypto.randomInt(0, 360)}, ${thumb}, ${stage})`,
  });
  await recordScannedGameAssets(sql, id, input.html);
  return (await getGame(id, CREATED_GAME_LOOKUP))!;
}

export type ReplaceBundleResult = { ok: true; game: Game } | { ok: false; status: 404 | 409; error: string };

/**
 * MCP-1: replace an unpublished game's index.html (and optionally its thumbnail), then send it
 * back through validation as `pending`. A game approved while the bytes were uploading is held
 * as pending again, so new bytes never go public without a review.
 */
export async function replaceGameBundle(
  input: { gameKey: string; ownerId: string; html: Uint8Array; thumb?: { bytes: Uint8Array; ext: string; type: string } },
  storage: BundleStorage = bundleStorage(),
): Promise<ReplaceBundleResult> {
  const game = await getGame(input.gameKey, { includeUnpublished: true });
  if (!game || game.ownerId !== input.ownerId) return { ok: false, status: 404, error: 'Game not found.' };
  const [asset] = await sql`select 1 from game_assets where game_id = ${game.id} and status = 'uploaded' limit 1`;
  const blocker = replaceBlocker(game.stage, Boolean(asset));
  if (blocker) return { ok: false, status: 409, error: blocker };

  const thumb = input.thumb ? `thumb.${input.thumb.ext}` : game.thumb;
  const puts = await Promise.all([
    storage.upload(`${game.id}/index.html`, input.html, 'text/html; charset=utf-8'),
    ...(input.thumb ? [storage.upload(`${game.id}/${thumb}`, input.thumb.bytes, input.thumb.type)] : []),
  ]);
  const failed = puts.find((p) => p.error);
  if (failed?.error) throw new Error(`Storage upload failed: ${failed.error.message}`);

  await sql.begin(async (tx) => {
    const [row] = await tx<{ stage: Stage }[]>`select stage from games where id = ${game.id} for update`;
    await tx`delete from private.validation_dispatch where game_id = ${game.id}`;
    await tx`update games set size_bytes = ${input.html.byteLength}, thumb = ${thumb}, stage = 'pending' where id = ${game.id}`;
    // The enqueue trigger only fires on a stage change; an already-pending game is dispatched here.
    if (row?.stage === 'pending') await tx`select private.dispatch_validate_game(${game.id}, 'bundle_replaced')`;
  });
  if (game.thumb && thumb !== game.thumb) await storage.remove([`${game.id}/${game.thumb}`]);
  return { ok: true, game: (await getGame(game.id, { includeUnpublished: true }))! };
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
    insert into ratings (game_id, voter, user_id, stars)
    values (${gameId}, ${voter}, ${ratingUserId(voter)}, ${stars})
    on conflict (game_id, voter) do update
      set stars = excluded.stars, user_id = excluded.user_id, updated_at = now()`;
}

/** Removes a user's rating (no-op if they never rated). Returns true if a rating was deleted. */
export async function unrateGame(gameId: string, voter: string): Promise<boolean> {
  const rows = await sql`delete from ratings where game_id = ${gameId} and voter = ${voter} returning game_id`;
  return rows.length > 0;
}

export async function getUserRating(gameId: string, voter: string | undefined): Promise<number | null> {
  if (!voter) return null;
  const [row] = await sql<{ stars: number }[]>`select stars from ratings where game_id = ${gameId} and voter = ${voter}`;
  return row?.stars ?? null;
}

export type TelemetryType = 'session_start' | 'first_frame' | 'start' | 'complete' | 'crash' | 'heartbeat' | 'ready';

/**
 * Serializes the admit-then-write decision for one play across all telemetry events.
 * Transaction-scoped: released at commit on the same backend, so it stays correct behind
 * Supabase's transaction pooler (session-level advisory locks are unsupported there —
 * lock and unlock could land on different backends and leak).
 */
const lockSession = (tx: postgres.TransactionSql, sessionId: string) =>
  tx`select pg_advisory_xact_lock(hashtext(${sessionId}))`;

/**
 * One sessions column a telemetry event writes. `value` is what a freshly created
 * row stores; `merge(stored, incoming)` applies the event to an existing row —
 * the single source of truth for the field's rule, used verbatim in the fast
 * UPDATE, the locked retry and the INSERT's ON CONFLICT branch (where `stored`
 * is `sessions.<col>` and `incoming` is `excluded.<col>`).
 */
interface SessionEventColumn {
  col: string;
  value: postgres.Fragment;
  merge: (stored: postgres.Fragment, incoming: postgres.Fragment) => postgres.Fragment;
}

/** Flags latch false → true; no later or duplicate event clears them. */
const latchTrue = (col: string): SessionEventColumn => ({
  col,
  value: sql`true`,
  merge: (stored, incoming) => sql`(${stored} or ${incoming})`,
});

/** first_frame_ms is first-value-wins. */
const firstWins = (col: string, value: postgres.Fragment): SessionEventColumn => ({
  col,
  value,
  merge: (stored, incoming) => sql`coalesce(${stored}, ${incoming})`,
});

/** duration_ms only moves forward. */
const keepMax = (col: string, value: postgres.Fragment): SessionEventColumn => ({
  col,
  value,
  merge: (stored, incoming) => sql`greatest(${stored}, ${incoming})`,
});

/** Joins fragments with commas (a SET or column/SELECT list). */
const comma = (parts: postgres.Fragment[]): postgres.Fragment =>
  parts.slice(1).reduce<postgres.Fragment>((acc, part) => sql`${acc}, ${part}`, parts[0] ?? sql``);

/**
 * Applies an event's column merges to its session row. The fast path is one
 * unlocked UPDATE; on a miss the session lock serializes against a session_start
 * or another event that may be creating the row — under the lock a second miss
 * means the row really is absent, so only an admitted event may create it, and
 * only for a published game. The ON CONFLICT branch applies the same merge to a
 * row that raced in between; the game guard keeps a foreign session's row
 * untouched. Nothing inside the lock may use the pool: `tx` only, or a
 * pool-starved request deadlocks.
 */
async function upsertSessionEvent(
  sessionId: string,
  gameId: string,
  columns: SessionEventColumn[],
  admitNewSession?: (db: GameDb) => Promise<boolean>,
) {
  const where = sql`where id = ${sessionId} and game_id = ${gameId}`;
  const update = comma(columns.map((c) => sql`${sql(c.col)} = ${c.merge(sql`${sql(c.col)}`, c.value)}`));
  const hit = await sql`update sessions set ${update} ${where} returning id`;
  if (hit.length) return;
  await sql.begin(async (tx) => {
    await lockSession(tx, sessionId);
    const retry = await tx`update sessions set ${update} ${where} returning id`;
    if (!retry.length && admitNewSession && (await admitNewSession(tx))) {
      const conflict = comma(
        columns.map((c) => sql`${sql(c.col)} = ${c.merge(sql`sessions.${sql(c.col)}`, sql`excluded.${sql(c.col)}`)}`),
      );
      await tx`
        insert into sessions (id, game_id, ${comma(columns.map((c) => sql`${sql(c.col)}`))})
        select ${sessionId}, ${gameId}, ${comma(columns.map((c) => c.value))}
        where exists (select 1 from games where id = ${gameId} and stage in ${sql([...PUBLIC_STAGES])})
        on conflict (id) do update
          set ${conflict}
          where sessions.game_id = excluded.game_id`;
    }
  });
}

export async function recordTelemetry(
  sessionId: string,
  gameId: string,
  type: TelemetryType,
  value: unknown = 0,
  userId: string | null = null,
  /**
   * May a session row be created for this play? The route supplies getGame +
   * admitSessionStart. It runs inside the session lock, so it must only read via `db`
   * (the lock-holding transaction) — reaching the pool there can deadlock once every
   * pooled connection is held. Unset callers keep the old semantics: session_start
   * always writes, the other events never create a row.
   */
  admitNewSession?: (db: postgres.TransactionSql) => Promise<boolean>,
) {
  switch (type) {
    case 'session_start':
      await sql.begin(async (tx) => {
        await lockSession(tx, sessionId);
        const exists = await tx`select 1 from sessions where id = ${sessionId} and game_id = ${gameId}`;
        if (!exists.length && !(admitNewSession ? await admitNewSession(tx) : true)) return;
        // On conflict this only fills a null user_id: game_id and first_frame_ms keep
        // whatever an earlier first_frame already recorded (schema-rollout.ts).
        await insertSessionStart(postgresSchemaClient(tx), { sessionId, gameId, userId });
      });
      return;
    case 'first_frame': {
      const ms = clampFirstFrameMs(value);
      if (ms === null) return;
      return upsertSessionEvent(sessionId, gameId, [firstWins('first_frame_ms', sql`${ms}`)], admitNewSession);
    }
    case 'ready':
      // Acknowledged only. sessions has no ready column, and this ticket does not migrate.
      // first_frame_ms stays the automatic animation-frame metric.
      return;
    case 'start':
      return upsertSessionEvent(sessionId, gameId, [latchTrue('started')], admitNewSession);
    case 'complete':
      return upsertSessionEvent(sessionId, gameId, [latchTrue('started'), latchTrue('completed')], admitNewSession);
    case 'crash':
      return upsertSessionEvent(sessionId, gameId, [latchTrue('crashed')], admitNewSession);
    case 'heartbeat':
      return upsertSessionEvent(sessionId, gameId, [keepMax('duration_ms', sql`${clampDurationMs(value)}`)], admitNewSession);
  }
}

/** A query runner that is either the shared pool or a transaction on it. */
export type GameDb = postgres.Sql | postgres.TransactionSql;

export async function getHealth(gameId: string, db: GameDb = sql): Promise<{ checks: HealthCheck[]; eligible: boolean }> {
  const G = GRADUATION;
  const [s] = await db<
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
