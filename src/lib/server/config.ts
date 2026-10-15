import { GRADUATION_DEFAULTS } from './game-rules';

const env = process.env;

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

/** SP-6: shared with the game CDN to mint owner preview tokens for pending/rejected games (cdn/preview-token.mjs). */
export const CDN_PREVIEW_SECRET = env.CDN_PREVIEW_SECRET ?? '';

export const SUPABASE_URL = required('PUBLIC_SUPABASE_URL').replace(/\/$/, '');
export const SUPABASE_ANON_KEY = required('PUBLIC_SUPABASE_PUBLISHABLE_KEY');
export const SUPABASE_SERVICE_KEY = required('SUPABASE_SECRET_KEY');
export const DATABASE_URL = required('DATABASE_URL');
export const GAMES_BUCKET = 'games';

/** Not used for auth emails. Those use the request-origin allowlist in email-redirect.ts. */
export const SITE_URL = env.SITE_URL?.replace(/\/$/, '');
export const CDN_ORIGIN = (env.MG_CDN_ORIGIN ?? 'http://localhost:4322').replace(/\/$/, '');
export const ADSENSE_CLIENT = env.PUBLIC_ADSENSE_CLIENT || import.meta.env.PUBLIC_ADSENSE_CLIENT || '';

/** CM-1: a featured game is skipped as broken at >= this many plays ... */
export const FEATURED_BROKEN_MIN_PLAYS = 5;
/** ... with a crash rate strictly above this (0.5 = 50%). */
export const FEATURED_BROKEN_MAX_CRASH_RATE = 0.5;

export const GRADUATION = {
  ...GRADUATION_DEFAULTS,
  minPlays: Number(env.MG_MIN_PLAYS ?? GRADUATION_DEFAULTS.minPlays),
};

export const REVENUE = { creatorShare: 0.65, forkRoyalty: 0.1, minPayoutUsd: 25 };

export { UPLOAD } from './upload';

export const MAX_SAVE_BYTES = 1024 * 1024;
