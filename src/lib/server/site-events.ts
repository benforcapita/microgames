import { containsPii, truncateText, utf8Bytes, wellFormed } from '../pii';
import { createLimiter } from './abuse';

/** Client-reportable types. sign_up and upload are written by DB triggers only. */
export const SITE_EVENT_TYPES = ['page_view', 'game_launch', 'error'] as const;
export type SiteEventType = (typeof SITE_EVENT_TYPES)[number];
export const SITE_EVENT_MAX_PATH = 512;
/** UTF-8 bytes of the details JSON. Kept under the DB's pg_column_size(details) <= 4096 (jsonb is larger than its text). */
export const SITE_EVENT_MAX_DETAILS_BYTES = 4000;
/** Whole request body, in bytes. Reading stops as soon as this is passed. */
export const SITE_EVENT_MAX_BODY_BYTES = 6144;
export const SITE_EVENT_WRITE_TIMEOUT_MS = 1500;

/** Keyed by client IP in memory only (per server instance). The IP is never stored. */
export const siteEventsByIp = createLimiter({ windowMs: 60_000, max: 60 });

export interface SiteEventInput {
  type: SiteEventType;
  path: string | null;
  gameId: string | null;
  details: Record<string, unknown>;
}

/* PII detection and UTF-8-safe text live in ../pii (shared with the browser sender). */

/** Lone surrogates anywhere (keys and values) become U+FFFD, so jsonb accepts the row instead of failing it. */
function wellFormedDeep(v: unknown): unknown {
  if (typeof v === 'string') return wellFormed(v);
  if (Array.isArray(v)) return v.map(wellFormedDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [wellFormed(k), wellFormedDeep(x)]));
  return v;
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number') out.push(String(v));
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
}

/** Validates an untrusted body. user_id is never read from it; the caller supplies it from the session. */
export function parseSiteEvent(body: unknown): { ok: true; event: SiteEventInput } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'body' };
  const b = body as Record<string, unknown>;
  if (typeof b.type !== 'string' || !(SITE_EVENT_TYPES as readonly string[]).includes(b.type)) return { ok: false, reason: 'type' };
  let path: string | null = null;
  if (b.path !== undefined && b.path !== null) {
    if (typeof b.path !== 'string' || b.path.length > SITE_EVENT_MAX_PATH) return { ok: false, reason: 'path' };
    path = wellFormed(b.path);
  }
  let gameId: string | null = null;
  if (b.gameId !== undefined && b.gameId !== null) {
    if (typeof b.gameId !== 'string' || b.gameId.length > 128) return { ok: false, reason: 'gameId' };
    gameId = b.gameId;
  }
  let details: Record<string, unknown> = {};
  if (b.details !== undefined && b.details !== null) {
    if (typeof b.details !== 'object' || Array.isArray(b.details)) return { ok: false, reason: 'details' };
    details = wellFormedDeep(b.details) as Record<string, unknown>;
  }
  if (utf8Bytes(JSON.stringify(details)) > SITE_EVENT_MAX_DETAILS_BYTES) return { ok: false, reason: 'details-size' };
  // No emails or IPs at rest, in any stored field.
  if ([path ?? '', gameId ?? '', ...strings(details)].some(containsPii)) return { ok: false, reason: 'pii' };
  return { ok: true, event: { type: b.type as SiteEventType, path, gameId, details } };
}

/* ---------- write ---------- */

/** game_id resolves to an existing game or null, atomically in the insert. */
export async function recordSiteEvent(event: SiteEventInput, userId: string | null): Promise<void> {
  const { sql } = await import('./db');
  await sql`insert into public.site_events (event_type, user_id, game_id, path, details)
    values (${event.type}, ${userId}, (select id from public.games where id = ${event.gameId}), ${event.path}, ${sql.json(event.details as never)})`;
}

export type WriteOutcome = 'ok' | 'timeout' | 'invalid' | 'error';

/**
 * Awaits the write, bounded by a timer that is always cleared. Never throws, never hangs past timeoutMs.
 * 'invalid' = the DB rejected the row with a check violation (23514); the caller answers 400.
 */
export async function recordSiteEventBounded(
  event: SiteEventInput,
  userId: string | null,
  { write = recordSiteEvent, timeoutMs = SITE_EVENT_WRITE_TIMEOUT_MS }: { write?: typeof recordSiteEvent; timeoutMs?: number } = {},
): Promise<WriteOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<WriteOutcome>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  const written = write(event, userId).then(
    () => 'ok' as const,
    (err: { code?: string; message?: string }) => {
      // DB messages carry no row values for these errors; the event itself is never logged.
      console.warn(`[events] insert failed: ${err?.code ?? ''} ${truncateText(String(err?.message ?? err), 200)}`);
      return err?.code === '23514' ? ('invalid' as const) : ('error' as const);
    },
  );
  try {
    return await Promise.race([written, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- request handling ---------- */

/** Reads at most maxBytes of the body (UTF-8 bytes); stops reading and returns null once past it. */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface HandleDeps {
  write?: typeof recordSiteEvent;
  timeoutMs?: number;
  limiter?: { hit(key: string): boolean };
}

/**
 * POST /api/events behaviour. `userId` must come from the verified session; the body cannot set it.
 * 429 rate limited, 413 body over SITE_EVENT_MAX_BODY_BYTES, 400 invalid or PII, else 204 after the
 * awaited (<= ~1.5s) insert. A slow or failing DB still gets 204 and the event is dropped.
 */
export async function handleSiteEvent(
  request: Request,
  { ip, userId }: { ip: string; userId: string | null },
  { write, timeoutMs, limiter = siteEventsByIp }: HandleDeps = {},
): Promise<Response> {
  if (!limiter.hit(ip)) return new Response('Too many requests', { status: 429 });
  const declared = Number(request.headers.get('content-length'));
  if (declared > SITE_EVENT_MAX_BODY_BYTES) return new Response('Payload too large', { status: 413 });
  const raw = await readBodyLimited(request, SITE_EVENT_MAX_BODY_BYTES).catch(() => '');
  if (raw === null) return new Response('Payload too large', { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const parsed = parseSiteEvent(body);
  if (!parsed.ok) return new Response('Bad request', { status: 400 });
  const outcome = await recordSiteEventBounded(parsed.event, userId, { write, timeoutMs });
  if (outcome === 'invalid') return new Response('Bad request', { status: 400 });
  if (outcome !== 'ok') console.warn(`[events] dropped (${outcome})`);
  return new Response(null, { status: 204 });
}
