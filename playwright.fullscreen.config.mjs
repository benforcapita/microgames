import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { localSupabaseEnv } from './scripts/lib/local-supabase.mjs';

// Drives the shared player against an already-running portal (vmg web / `npm run dev`).
// The default `playwright.config.mjs` suite also runs e2e/fullscreen.spec.mjs on desktop Chromium.
const port = Number(process.env.E2E_WEB_PORT ?? 55728);
const cdnPort = Number(process.env.E2E_CDN_PORT ?? 55729);
const baseURL = `http://127.0.0.1:${port}`;

function ciServers() {
  const cdn = `http://127.0.0.1:${cdnPort}`;
  process.env.CDN_PREVIEW_SECRET ||= randomBytes(32).toString('hex');
  process.env.MG_IP_HASH_SECRET ||= randomBytes(32).toString('hex');
  const env = {
    ...localSupabaseEnv(),
    CDN_PREVIEW_SECRET: process.env.CDN_PREVIEW_SECRET,
    MG_IP_HASH_SECRET: process.env.MG_IP_HASH_SECRET,
    SITE_URL: baseURL,
    HOST: '127.0.0.1',
    PORT: String(port),
    MG_CDN_PORT: String(cdnPort),
    MG_CDN_ORIGIN: cdn,
    MG_WEB_ORIGINS: `${baseURL} http://localhost:${port}`,
  };
  return [
    { command: 'node scripts/game-cdn.mjs', port: cdnPort, env, reuseExistingServer: false, timeout: 30_000 },
    {
      command: 'node scripts/seed.mjs && npx astro build && node dist/server/entry.mjs',
      url: `${baseURL}/`,
      env,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ];
}

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'fullscreen.spec.mjs',
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
  ...(process.env.CI === 'true' ? { webServer: ciServers() } : {}),
  projects: [
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1280, height: 800 }, baseURL },
    },
    {
      name: 'pixel',
      use: { ...devices['Pixel 7'], browserName: 'chromium', baseURL },
    },
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 13'],
        browserName: 'webkit',
        viewport: { width: 390, height: 844 },
        baseURL,
      },
    },
  ],
});
