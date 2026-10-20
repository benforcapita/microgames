/** Personal API tokens for the MCP server (MCP-1). No database or environment access. */
import crypto from 'node:crypto';

export const API_TOKEN_PREFIX = 'mgp_';
export const MAX_API_TOKENS = 10;
const TOKEN_RE = /^mgp_[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const generateApiToken = (): string => API_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');

export const hashApiToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

/** What the dashboard shows so a creator can tell tokens apart. Never enough to use. */
export const apiTokenPrefix = (token: string): string => token.slice(0, API_TOKEN_PREFIX.length + 6);

/** The token from an `Authorization: Bearer mgp_…` header, or null when absent or malformed. */
export function bearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match && TOKEN_RE.test(match[1]) ? match[1] : null;
}

export function apiTokenName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return name || 'MCP token';
}

export const isTokenId = (id: string): boolean => UUID_RE.test(id);
