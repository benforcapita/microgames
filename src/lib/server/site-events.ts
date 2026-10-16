import { createLimiter } from './abuse';

/** Client-reportable types. sign_up and upload are written by DB triggers only. */
export const SITE_EVENT_TYPES = ['page_view', 'game_launch', 'error'] as const;
export type SiteEventType = (typeof SITE_EVENT_TYPES)[number];
export const SITE_EVENT_MAX_PATH = 512;
export const SITE_EVENT_MAX_DETAILS_BYTES = 4096;

/** Keyed by client IP in memory only. The IP is never stored. */
export const siteEventsByIp = createLimiter({ windowMs: 60_000, max: 60 });

export interface SiteEventInput {
  type: SiteEventType;
  path: string | null;
  gameId: string | null;
  details: Record<string, unknown>;
}

const EMAIL = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/i;

/** Validates an untrusted body. user_id is never read from it; the route takes it from the session. */
export function parseSiteEvent(body: unknown): { ok: true; event: SiteEventInput } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'body' };
  const b = body as Record<string, unknown>;
  if (typeof b.type !== 'string' || !(SITE_EVENT_TYPES as readonly string[]).includes(b.type)) return { ok: false, reason: 'type' };
  let path: string | null = null;
  if (b.path !== undefined && b.path !== null) {
    if (typeof b.path !== 'string' || b.path.length > SITE_EVENT_MAX_PATH) return { ok: false, reason: 'path' };
    path = b.path;
  }
  let gameId: string | null = null;
  if (b.gameId !== undefined && b.gameId !== null) {
    if (typeof b.gameId !== 'string' || b.gameId.length > 128) return { ok: false, reason: 'gameId' };
    gameId = b.gameId;
  }
  let details: Record<string, unknown> = {};
  if (b.details !== undefined && b.details !== null) {
    if (typeof b.details !== 'object' || Array.isArray(b.details)) return { ok: false, reason: 'details' };
    details = b.details as Record<string, unknown>;
  }
  const json = JSON.stringify(details);
  if (Buffer.byteLength(json, 'utf8') > SITE_EVENT_MAX_DETAILS_BYTES) return { ok: false, reason: 'details-size' };
  // No emails or IPs at rest, in any field.
  const text = `${path ?? ''}\n${json}`;
  if (EMAIL.test(text) || IPV4.test(text) || IPV6.test(text)) return { ok: false, reason: 'pii' };
  return { ok: true, event: { type: b.type as SiteEventType, path, gameId, details } };
}

/** game_id resolves to an existing game or null, atomically in the insert. */
export async function recordSiteEvent(event: SiteEventInput, userId: string | null): Promise<void> {
  const { sql } = await import('./db');
  await sql`insert into public.site_events (event_type, user_id, game_id, path, details)
    values (${event.type}, ${userId}, (select id from public.games where id = ${event.gameId}), ${event.path}, ${sql.json(event.details as never)})`;
}
