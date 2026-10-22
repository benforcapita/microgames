import type { SupabaseClient } from '@supabase/supabase-js';
import { shareTarget, type ShareableValidation, type ShareTarget } from '../preview-link-rules';
import { SITE_URL } from './config';
import { sql } from './db';

export interface ActivePreviewLink {
  id: string;
  versionId: string;
  version?: number;
  expiresAt: string;
  viewCount: number;
  createdAt: string;
}

export type CreatePreviewLinkResult =
  | {
      kind: 'success';
      link: {
        id: string;
        token: string;
        url: string;
        version: number;
        expiresAt: string;
        viewCount: number;
      };
    }
  | {
      kind: 'error';
      status: number;
      message: string;
    };

export type RevokePreviewLinkResult =
  | { kind: 'success' }
  | { kind: 'error'; status: number; message: string };

export type ListPreviewLinksResult =
  | { kind: 'success'; links: ActivePreviewLink[] }
  | { kind: 'error'; status: number; message: string };

export interface MappedPreviewLinkError {
  status: number;
  message: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractErrorText(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (isRecord(error)) {
    const parts: string[] = [];
    if (typeof error.message === 'string') parts.push(error.message);
    if (typeof error.details === 'string') parts.push(error.details);
    if (typeof error.hint === 'string') parts.push(error.hint);
    return parts.join(' ');
  }
  return '';
}

export function buildPreviewLinkUrl(opts: {
  siteUrl?: string | null;
  requestOrigin?: string | null;
  token: string;
}): string {
  const base = opts.siteUrl?.trim() || opts.requestOrigin?.trim() || '';
  const trimmed = base.replace(/\/+$/, '');
  const encodedToken = encodeURIComponent(opts.token);
  return trimmed ? `${trimmed}/p/${encodedToken}` : `/p/${encodedToken}`;
}

export function mapPreviewLinkError(error: unknown): MappedPreviewLinkError {
  const capMessage = 'You already have 5 active preview links. Revoke one to create another.';
  const hourMessage = "You've created 10 preview links in the last hour. Try again later.";
  const genericMessage = 'Could not create preview link. Please try again.';

  const str = extractErrorText(error);
  if (str.includes('preview_link_cap')) {
    return { status: 409, message: capMessage };
  }
  if (str.includes('preview_link_hour')) {
    return { status: 400, message: hourMessage };
  }
  if (str.includes('preview_link_ttl')) {
    return { status: 400, message: 'Choose how long the link lasts.' };
  }
  return { status: 500, message: genericMessage };
}

export function validateRpcCreatedLink(data: unknown): { id: string; token: string; expiresAt: string } | null {
  const item = Array.isArray(data) ? data[0] : data;
  if (!isRecord(item)) return null;
  const id = typeof item.id === 'string' ? item.id : null;
  const token = typeof item.token === 'string' ? item.token : null;
  const expiresAt = typeof item.expires_at === 'string' ? item.expires_at : null;
  if (!id || !token || !expiresAt) return null;
  return { id, token, expiresAt };
}

export function validateActiveLinks(data: unknown): ActivePreviewLink[] {
  if (!Array.isArray(data)) return [];
  const result: ActivePreviewLink[] = [];
  for (const item of data) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id : null;
    const versionId = typeof item.version_id === 'string' ? item.version_id : null;
    const expiresAt = typeof item.expires_at === 'string' ? item.expires_at : null;
    const viewCount = typeof item.view_count === 'number' ? item.view_count : 0;
    const createdAt = typeof item.created_at === 'string' ? item.created_at : '';
    if (id && versionId && expiresAt) {
      result.push({
        id,
        versionId,
        expiresAt,
        viewCount,
        createdAt,
      });
    }
  }
  return result;
}

export async function getGameOwnerId(gameId: string): Promise<string | null> {
  const rows = await sql<{ owner_id: string }[]>`
    select owner_id from public.games where id = ${gameId}
  `;
  const first = rows[0];
  if (!first || typeof first.owner_id !== 'string') return null;
  return first.owner_id;
}

export async function verifyGameOwner(opts: {
  gameId: string;
  userId: string | null | undefined;
}): Promise<{ kind: 'ok'; ownerId: string } | { kind: 'error'; status: number; message: string }> {
  if (!opts.userId) {
    return { kind: 'error', status: 401, message: 'Unauthorized' };
  }
  const ownerId = await getGameOwnerId(opts.gameId);
  if (!ownerId || ownerId !== opts.userId) {
    return { kind: 'error', status: 404, message: 'Not found' };
  }
  return { kind: 'ok', ownerId };
}

export async function loadShareTarget(gameId: string): Promise<ShareTarget> {
  const [games, validations] = await Promise.all([
    sql<{ stage: string }[]>`select stage from public.games where id = ${gameId}`,
    sql<ShareableValidation[]>`
      select id, version, status from public.game_validations
      where game_id = ${gameId}
      order by version desc, created_at desc
    `,
  ]);
  return shareTarget(games[0]?.stage ?? '', validations);
}

export async function createPreviewLink(opts: {
  supabase: SupabaseClient;
  gameId: string;
  userId: string;
  ttlHours: number;
  requestOrigin?: string;
}): Promise<CreatePreviewLinkResult> {
  const ownerCheck = await verifyGameOwner({ gameId: opts.gameId, userId: opts.userId });
  if (ownerCheck.kind === 'error') {
    return {
      kind: 'error',
      status: ownerCheck.status,
      message: ownerCheck.message,
    };
  }

  const target = await loadShareTarget(opts.gameId);
  if (target.kind === 'blocked') {
    return { kind: 'error', status: target.status, message: target.message };
  }

  const { data, error } = await opts.supabase.rpc('create_preview_link', {
    p_version_id: target.versionId,
    p_ttl_hours: opts.ttlHours,
  });

  if (error) {
    const mapped = mapPreviewLinkError(error);
    return { kind: 'error', status: mapped.status, message: mapped.message };
  }

  const parsed = validateRpcCreatedLink(data);
  if (!parsed) {
    return {
      kind: 'error',
      status: 500,
      message: 'Could not create preview link. Please try again.',
    };
  }

  const url = buildPreviewLinkUrl({
    siteUrl: SITE_URL,
    requestOrigin: opts.requestOrigin,
    token: parsed.token,
  });

  return {
    kind: 'success',
    link: {
      id: parsed.id,
      token: parsed.token,
      url,
      version: target.version,
      expiresAt: parsed.expiresAt,
      viewCount: 0,
    },
  };
}

export async function revokePreviewLink(opts: {
  supabase: SupabaseClient;
  gameId: string;
  linkId: string;
  userId: string;
}): Promise<RevokePreviewLinkResult> {
  const ownerCheck = await verifyGameOwner({ gameId: opts.gameId, userId: opts.userId });
  if (ownerCheck.kind === 'error') {
    return {
      kind: 'error',
      status: ownerCheck.status,
      message: ownerCheck.message,
    };
  }

  if (!isUuid(opts.linkId)) {
    return { kind: 'error', status: 404, message: 'Not found' };
  }

  const links = await sql<{ id: string }[]>`
    select l.id
    from public.preview_links l
    join public.game_validations gv on gv.id = l.version_id
    where l.id = ${opts.linkId} and gv.game_id = ${opts.gameId} and l.owner_id = ${opts.userId}
  `;
  if (!links || links.length === 0) {
    return { kind: 'error', status: 404, message: 'Not found' };
  }

  const { error } = await opts.supabase.rpc('revoke_preview_link', {
    p_id: opts.linkId,
  });
  if (error) {
    return { kind: 'error', status: 404, message: 'Not found' };
  }
  return { kind: 'success' };
}

export async function listActivePreviewLinks(opts: {
  supabase: SupabaseClient;
  gameId: string;
}): Promise<ActivePreviewLink[]> {
  const validations = await sql<{ id: string; version: number }[]>`
    select id, version from public.game_validations where game_id = ${opts.gameId}
  `;
  const versionById = new Map(validations.map((v) => [v.id, v.version]));
  if (versionById.size === 0) {
    return [];
  }

  const { data, error } = await opts.supabase
    .from('preview_links')
    .select('id, version_id, expires_at, view_count, created_at')
    .in('version_id', [...versionById.keys()])
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  if (error || !data) {
    return [];
  }

  return validateActiveLinks(data).map((link) => ({ ...link, version: versionById.get(link.versionId) }));
}
