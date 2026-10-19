import { sql } from './db';
import { getProfile, type Profile } from './profiles';
import { MAX_API_TOKENS, apiTokenName, apiTokenPrefix, bearerToken, generateApiToken, hashApiToken, isTokenId } from '../api-token';

export interface ApiTokenSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** The portal can ship before migration 20261019130000_api_tokens: a missing table reads as no tokens. */
async function untilMigrated<T>(fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string }).code !== '42P01') throw err;
    console.warn('api_tokens table is missing; apply migration 20261019130000_api_tokens');
    return fallback;
  }
}

export async function listApiTokens(userId: string): Promise<ApiTokenSummary[]> {
  return untilMigrated<ApiTokenSummary[]>([], () => sql<ApiTokenSummary[]>`
    select id, name, prefix, created_at as "createdAt", last_used_at as "lastUsedAt"
    from api_tokens where user_id = ${userId} order by created_at desc`);
}

/** Returns the plaintext token once. Only its hash is stored. */
export async function createApiToken(userId: string, rawName: unknown): Promise<{ token: string; summary: ApiTokenSummary } | { error: string }> {
  return untilMigrated({ error: 'MCP tokens are not available yet. Try again later.' }, () => insertApiToken(userId, rawName));
}

async function insertApiToken(userId: string, rawName: unknown): Promise<{ token: string; summary: ApiTokenSummary } | { error: string }> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from api_tokens where user_id = ${userId}`;
  if (n >= MAX_API_TOKENS) return { error: `You can have up to ${MAX_API_TOKENS} tokens. Revoke one first.` };
  const token = generateApiToken();
  const [summary] = await sql<ApiTokenSummary[]>`
    insert into api_tokens (user_id, name, token_hash, prefix)
    values (${userId}, ${apiTokenName(rawName)}, ${hashApiToken(token)}, ${apiTokenPrefix(token)})
    returning id, name, prefix, created_at as "createdAt", last_used_at as "lastUsedAt"`;
  return { token, summary };
}

export async function revokeApiToken(userId: string, id: string): Promise<boolean> {
  if (!isTokenId(id)) return false;
  const rows = await untilMigrated([], () => sql`delete from api_tokens where id = ${id} and user_id = ${userId} returning id`);
  return rows.length > 0;
}

/** The creator behind an `Authorization: Bearer mgp_…` header, or null. */
export async function authenticateApiToken(request: Request): Promise<{ user: { id: string; email: null }; profile: Profile } | null> {
  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return null;
  const [row] = await untilMigrated<{ user_id: string }[]>([], () => sql<{ user_id: string }[]>`
    update api_tokens set last_used_at = now() where token_hash = ${hashApiToken(token)} returning user_id`);
  const profile = row ? await getProfile(row.user_id) : null;
  return profile ? { user: { id: profile.id, email: null }, profile } : null;
}
