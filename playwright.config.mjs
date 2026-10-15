import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4721);
const CDN_PORT = Number(process.env.E2E_CDN_PORT ?? 4722);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const CDN = `http://127.0.0.1:${CDN_PORT}`;
// Throwaway data dir so the test re-seeds from seed/ and never touches ./data.
// Config is re-evaluated in workers; share one dir via env.
process.env.E2E_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mg-e2e-'));
const env = {
  HOST: '127.0.0.1',
  PORT: String(WEB_PORT),
  MG_CDN_PORT: String(CDN_PORT),
  MG_CDN_ORIGIN: CDN,
  MG_WEB_ORIGINS: `${WEB} http://localhost:${WEB_PORT}`,
  MG_DATA_DIR: process.env.E2E_DATA_DIR,
};

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: WEB, browserName: 'chromium', headless: true, viewport: { width: 1280, height: 800 } },
  // Playwright starts these and kills them (only these) when the run ends.
  webServer: [
    { command: 'node scripts/game-cdn.mjs', port: CDN_PORT, env, reuseExistingServer: false, timeout: 30_000 },
    {
      command: 'npx astro build && node dist/server/entry.mjs',
      url: `${WEB}/`,
      env,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
