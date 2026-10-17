import { defineConfig, devices } from '@playwright/test';

// Drives the shared player against an already-running portal (vmg web / `npm run dev`).
// The default `playwright.config.mjs` suite also runs e2e/fullscreen.spec.mjs on desktop Chromium.
const port = Number(process.env.E2E_WEB_PORT ?? 55728);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'fullscreen.spec.mjs',
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
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
