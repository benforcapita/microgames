const env = process.env;

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

export const SUPABASE_URL = required('PUBLIC_SUPABASE_URL').replace(/\/$/, '');
export const SUPABASE_ANON_KEY = required('PUBLIC_SUPABASE_PUBLISHABLE_KEY');
export const SUPABASE_SERVICE_KEY = required('SUPABASE_SECRET_KEY');
export const DATABASE_URL = required('DATABASE_URL');
export const GAMES_BUCKET = 'games';

export const SITE_URL = env.SITE_URL?.replace(/\/$/, '');
export const CDN_ORIGIN = (env.MG_CDN_ORIGIN ?? 'http://localhost:4322').replace(/\/$/, '');
export const ADSENSE_CLIENT = env.PUBLIC_ADSENSE_CLIENT || import.meta.env.PUBLIC_ADSENSE_CLIENT || '';

export const GRADUATION = {
  minPlays: Number(env.MG_MIN_PLAYS ?? 100),
  maxFirstFrameMs: 3000,
  minFirstFrameOkRate: 0.9,
  maxCrashRate: 0.05,
  minStartRate: 0.6,
  minCompletionRate: 0.25,
  minMedianSessionSec: 60,
  minAvgRating: 3,
  minRatingsForRatingGate: 10,
};

export const REVENUE = { creatorShare: 0.65, forkRoyalty: 0.1, minPayoutUsd: 25 };

export const UPLOAD = {
  maxHtmlBytes: 5 * 1024 * 1024,
  maxThumbBytes: 512 * 1024,
  thumbTypes: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>,
  licenses: ['MIT', 'CC-BY-SA-4.0', 'All rights reserved'],
};

export const MAX_SAVE_BYTES = 1024 * 1024;
