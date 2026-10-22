import { randomBytes } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import { localSupabaseEnv } from './scripts/lib/local-supabase.mjs';

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4721);
const CDN_PORT = Number(process.env.E2E_CDN_PORT ?? 4722);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const CDN = `http://127.0.0.1:${CDN_PORT}`;
// Runs against the LOCAL Supabase stack (`npm run db:start`). Keys come from `supabase status` at runtime
// and are only passed as env vars to the servers below; nothing is written to disk.
// Owner previews of pending games need a CDN preview secret shared by the portal and the CDN.
// A throwaway one per run (set on process.env so workers inherit the same value); never written to disk.
process.env.CDN_PREVIEW_SECRET ||= randomBytes(32).toString('hex');
process.env.MG_IP_HASH_SECRET ||= randomBytes(32).toString('hex');
const env = {
  ...localSupabaseEnv(),
  CDN_PREVIEW_SECRET: process.env.CDN_PREVIEW_SECRET,
  MG_IP_HASH_SECRET: process.env.MG_IP_HASH_SECRET,
  SITE_URL: WEB,
  HOST: '127.0.0.1',
  PORT: String(WEB_PORT),
  MG_CDN_PORT: String(CDN_PORT),
  MG_CDN_ORIGIN: CDN,
  MG_WEB_ORIGINS: `${WEB} http://localhost:${WEB_PORT}`,
};

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  projects: [
    { name: 'chromium', testIgnore: /preview-play-phone\.spec\.mjs/ },
    {
      name: 'webkit-phone',
      testMatch: /preview-play-phone\.spec\.mjs/,
      use: {
        browserName: 'webkit',
        viewport: { width: 390, height: 844 },
        launchOptions: { args: [] },
      },
    },
  ],
  use: {
    baseURL: WEB,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    // Opaque-origin game iframes are out-of-process; this lets the test call into the frame.
    launchOptions: { args: ['--disable-site-isolation-trials'] },
  },
  // Playwright starts these and kills them (only these) when the run ends.
  webServer: [
    { command: 'node scripts/game-cdn.mjs', port: CDN_PORT, env, reuseExistingServer: false, timeout: 30_000 },
    {
      command: 'node scripts/seed.mjs && npx astro build && node dist/server/entry.mjs',
      url: `${WEB}/`,
      env,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
