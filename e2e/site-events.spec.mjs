import { test, expect } from '@playwright/test';

test('a portal page sends a page_view to /api/events with no query or hash in the path', async ({ page }) => {
  // Chromium does not expose sendBeacon bodies to Playwright, so record each body and still send it for real.
  await page.addInitScript(() => {
    const real = navigator.sendBeacon.bind(navigator);
    window.__beacons = [];
    navigator.sendBeacon = (url, data) => {
      data.text().then((t) => window.__beacons.push({ url: String(url), body: t }));
      return real(url, data);
    };
  });
  const responded = page.waitForResponse((r) => r.url().endsWith('/api/events') && r.request().method() === 'POST');
  await page.goto('/games?email=ben%40example.com&utm_source=x#tok');
  expect((await responded).status()).toBe(204);
  await expect.poll(() => page.evaluate(() => window.__beacons.length)).toBeGreaterThan(0);
  const [first] = await page.evaluate(() => window.__beacons);
  expect(new URL(first.url, 'http://x').pathname).toBe('/api/events');
  const body = JSON.parse(first.body);
  expect(body).toEqual({ type: 'page_view', path: '/games' });
  expect(first.body).not.toMatch(/email|utm_source|tok|%40|\?|#/);
});
