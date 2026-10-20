import { mintPreviewToken } from '../../../cdn/preview-token.mjs';
import { CDN_PREVIEW_SECRET } from './config';
import { isPublicStage } from './game-rules';
import type { Game } from './games';

/**
 * SP-6 / MR-2: the CDN serves pending and rejected games only with a short-lived token.
 * One rule for every page that renders an owner's game: minted only for the owner, only
 * while the game is not public. Everyone else, and every public game, gets null (plain URLs).
 */
export function ownerPreviewToken(game: Pick<Game, 'id' | 'ownerId' | 'stage'>, userId: string | null | undefined): string | null {
  if (!userId || game.ownerId !== userId || isPublicStage(game.stage)) return null;
  return mintPreviewToken(CDN_PREVIEW_SECRET, game.id);
}

/**
 * AD-1: a reviewer needs to play a held game before approving it. Same token, same lifetime;
 * the caller must have checked isAdmin(). Public games get null like everyone else.
 */
export function reviewerPreviewToken(game: Pick<Game, 'id' | 'stage'>, admin: boolean): string | null {
  if (!admin || isPublicStage(game.stage)) return null;
  return mintPreviewToken(CDN_PREVIEW_SECRET, game.id);
}
