import path from 'node:path';

const env = process.env;

export const DATA_DIR = path.resolve(env.MG_DATA_DIR ?? 'data');
export const GAMES_DIR = path.join(DATA_DIR, 'games');
export const SEED_DIR = path.resolve('seed');
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
