/** Admin-only reads and the review action. Every caller must already have checked isAdmin(). */
import { sql } from './db';
import type { Stage } from './game-rules';
import { reviewTransition, type ReviewInput } from '../admin-rules';

export interface AdminOverview {
  users: number;
  signups7d: number;
  games: Record<Stage, number>;
  awaitingReview: number;
  plays: { total: number; last7d: number; last24h: number; signedIn7d: number };
  ratings: number;
  avgRating: number | null;
  errors7d: number;
  gameLaunches7d: number;
}

export async function adminOverview(): Promise<AdminOverview> {
  const [row] = await sql<{
    users: number; signups7d: number; pending: number; proving: number; live: number; rejected: number; awaiting: number;
    plays: number; plays7d: number; plays24h: number; signed7d: number; ratings: number; avg_rating: number | null; errors7d: number; launches7d: number;
  }[]>`
    select
      (select count(*)::int from profiles) as users,
      (select count(*)::int from profiles where created_at > now() - interval '7 days') as signups7d,
      (select count(*)::int from games where stage = 'pending') as pending,
      (select count(*)::int from games where stage = 'proving') as proving,
      (select count(*)::int from games where stage = 'live') as live,
      (select count(*)::int from games where stage = 'rejected') as rejected,
      (select count(*)::int from games_awaiting_review) as awaiting,
      (select count(*)::int from sessions) as plays,
      (select count(*)::int from sessions where created_at > now() - interval '7 days') as plays7d,
      (select count(*)::int from sessions where created_at > now() - interval '24 hours') as plays24h,
      (select count(*)::int from sessions where created_at > now() - interval '7 days' and user_id is not null) as signed7d,
      (select count(*)::int from ratings) as ratings,
      (select avg(stars)::float8 from ratings) as avg_rating,
      (select count(*)::int from site_events where event_type = 'error' and created_at > now() - interval '7 days') as errors7d,
      (select count(*)::int from site_events where event_type = 'game_launch' and created_at > now() - interval '7 days') as launches7d`;
  return {
    users: row.users,
    signups7d: row.signups7d,
    games: { pending: row.pending, proving: row.proving, live: row.live, rejected: row.rejected },
    awaitingReview: row.awaiting,
    plays: { total: row.plays, last7d: row.plays7d, last24h: row.plays24h, signedIn7d: row.signed7d },
    ratings: row.ratings,
    avgRating: row.avg_rating,
    errors7d: row.errors7d,
    gameLaunches7d: row.launches7d,
  };
}

export interface DayCount { day: string; plays: number; signups: number }

/** One row per calendar day (UTC) for the last `days` days, zero-filled. */
export async function dailyActivity(days = 14): Promise<DayCount[]> {
  const rows = await sql<{ day: string; plays: number; signups: number }[]>`
    with d as (select generate_series((current_date - ${days - 1} * interval '1 day')::date, current_date, interval '1 day')::date as day)
    select to_char(d.day, 'YYYY-MM-DD') as day,
      (select count(*)::int from sessions s where s.created_at::date = d.day) as plays,
      (select count(*)::int from profiles p where p.created_at::date = d.day) as signups
    from d order by d.day`;
  return rows;
}

export interface AdminGame {
  id: string;
  slug: string;
  title: string;
  creator: string;
  ownerHandle: string | null;
  stage: Stage;
  thumb: string | null;
  hue: number;
  createdAt: number;
  reviewedAt: number | null;
  reviewNote: string | null;
  latestValidation: string | null;
  plays: number;
  plays7d: number;
  avgRating: number | null;
  ratingCount: number;
  crashRate: number | null;
  awaitingReview: boolean;
}

interface AdminGameRow {
  id: string; slug: string; title: string; creator: string; owner_handle: string | null; stage: Stage; thumb: string | null; hue: number;
  created_at: Date; reviewed_at: Date | null; review_note: string | null; latest_validation: string | null;
  plays: number; plays7d: number; avg_rating: number | null; rating_count: number; crash_rate: number | null; awaiting: boolean;
}

const toAdminGame = (r: AdminGameRow): AdminGame => ({
  id: r.id, slug: r.slug, title: r.title, creator: r.creator, ownerHandle: r.owner_handle, stage: r.stage, thumb: r.thumb, hue: r.hue,
  createdAt: r.created_at.getTime(), reviewedAt: r.reviewed_at?.getTime() ?? null, reviewNote: r.review_note, latestValidation: r.latest_validation,
  plays: r.plays, plays7d: r.plays7d, avgRating: r.avg_rating, ratingCount: r.rating_count, crashRate: r.crash_rate, awaitingReview: r.awaiting,
});

const adminGameSelect = () => sql`
  select g.id, g.slug, g.title, g.creator, p.handle as owner_handle, g.stage, g.thumb, g.hue, g.created_at, g.reviewed_at, g.review_note,
    v.status as latest_validation,
    (select count(*)::int from sessions s where s.game_id = g.id) as plays,
    (select count(*)::int from sessions s where s.game_id = g.id and s.created_at > now() - interval '7 days') as plays7d,
    (select avg(stars)::float8 from ratings r where r.game_id = g.id) as avg_rating,
    (select count(*)::int from ratings r where r.game_id = g.id) as rating_count,
    (select avg(crashed::int)::float8 from sessions s where s.game_id = g.id) as crash_rate,
    exists (select 1 from games_awaiting_review q where q.id = g.id) as awaiting
  from games g
  left join profiles p on p.id = g.owner_id
  left join lateral (select status from game_validations where game_id = g.id order by version desc limit 1) v on true`;

/** Games a person must act on (MR-1 queue: games_awaiting_review decides membership), oldest first. */
export async function reviewQueue(): Promise<AdminGame[]> {
  const rows = await sql<AdminGameRow[]>`${adminGameSelect()}
    where exists (select 1 from games_awaiting_review q where q.id = g.id)
    order by g.created_at asc`;
  return rows.map(toAdminGame);
}

export interface AdminListOptions {
  stage?: Stage;
  q?: string;
  sort?: 'new' | 'plays' | 'plays7d';
  limit?: number;
}

const ADMIN_ORDER = { new: 'g.created_at desc', plays: 'plays desc, g.created_at desc', plays7d: 'plays7d desc, g.created_at desc' } as const;

/** Every game in any stage, for the admin table. */
export async function listAdminGames({ stage, q, sort = 'new', limit = 200 }: AdminListOptions = {}): Promise<AdminGame[]> {
  const needle = q?.trim() ? `%${q.trim()}%` : null;
  const rows = await sql<AdminGameRow[]>`
    select * from (${adminGameSelect()}) g
    where true
      ${stage ? sql`and stage = ${stage}` : sql``}
      ${needle ? sql`and (title ilike ${needle} or slug ilike ${needle} or creator ilike ${needle} or id = ${q!.trim()})` : sql``}
    order by ${sql.unsafe(ADMIN_ORDER[sort] ?? ADMIN_ORDER.new)}
    limit ${limit}`;
  return rows.map(toAdminGame);
}

export async function getAdminGame(id: string): Promise<AdminGame | null> {
  const [row] = await sql<AdminGameRow[]>`${adminGameSelect()} where g.id = ${id} or g.slug = ${id}`;
  return row ? toAdminGame(row) : null;
}

export interface RecentError { at: number; path: string | null; message: string; gameId: string | null }

export async function recentErrors(limit = 20): Promise<RecentError[]> {
  const rows = await sql<{ created_at: Date; path: string | null; details: Record<string, unknown>; game_id: string | null }[]>`
    select created_at, path, details, game_id from site_events
    where event_type = 'error' order by created_at desc limit ${limit}`;
  return rows.map((r) => ({
    at: r.created_at.getTime(),
    path: r.path,
    message: String(r.details?.message ?? r.details?.error ?? r.details?.kind ?? JSON.stringify(r.details)).slice(0, 200),
    gameId: r.game_id,
  }));
}

export type ReviewResult =
  | { ok: true; from: Stage; to: Stage }
  | { ok: false; status: 404 | 409; error: string };

/**
 * The human review (MR-1): a stage write by a person. Runs under a row lock so a validator
 * verdict landing at the same moment cannot interleave. The games_touch_review trigger stamps
 * reviewed_at; a rejection stores the note the owner sees, an approval clears any old one.
 */
export async function reviewGame(gameId: string, input: ReviewInput): Promise<ReviewResult> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string; stage: Stage }[]>`select id, stage from games where id = ${gameId} for update`;
    if (!row) return { ok: false, status: 404, error: 'No such game.' };
    const to = reviewTransition(row.stage, input.decision);
    if (!to) return { ok: false, status: 409, error: `Cannot ${input.decision} a game that is ${row.stage}.` };
    await tx`update games set stage = ${to}, review_note = ${input.decision === 'reject' ? input.note : null} where id = ${row.id}`;
    return { ok: true, from: row.stage, to };
  }) as Promise<ReviewResult>;
}
