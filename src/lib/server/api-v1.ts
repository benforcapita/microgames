/** MCP-1: shared pieces of the token API under /api/v1. Cookies are never read there. */
import { authenticateApiToken } from './api-tokens';
import { createLimiter } from './abuse';
import { SITE_URL } from './config';
import { submissionStageLabel, type ValidationStatus } from './submissions';
import type { Game } from './games';
import type { Profile } from './profiles';

export const apiWrites = createLimiter({ windowMs: 60 * 60_000, max: 30 });

export const apiJson = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export type ApiCaller = { user: { id: string; email: null }; profile: Profile };

export async function requireApiCaller(request: Request): Promise<ApiCaller | Response> {
  const caller = await authenticateApiToken(request);
  if (caller) return caller;
  return apiJson({ error: 'Missing or invalid API token. Create one at /me#mcp.' }, 401);
}

export const siteOrigin = (url: URL): string => SITE_URL ?? url.origin;

export function apiGame(game: Game, origin: string, validationStatus: string | null) {
  return {
    id: game.id,
    slug: game.slug,
    title: game.title,
    stage: game.stage,
    status: submissionStageLabel(game.stage, validationStatus as ValidationStatus | null),
    playUrl: `${origin}/play/${game.slug}`,
    submissionUrl: `${origin}/submissions/${game.id}`,
    plays: game.plays,
    avgRating: game.avgRating,
    ratingCount: game.ratingCount,
    createdAt: new Date(game.createdAt).toISOString(),
  };
}

export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}
