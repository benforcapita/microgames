import { test, expect } from '@playwright/test';

test('/api/events accepts only errors; page_view and game_launch get 400', async ({ request }) => {
  const post = (data) => request.post('/api/events', { data });
  expect((await post({ type: 'page_view', path: '/games' })).status()).toBe(400);
  expect((await post({ type: 'game_launch', path: '/play/x', gameId: 'x' })).status()).toBe(400);
  expect((await post({ type: 'error', path: '/games', details: { source: 'e2e', message: 'boom' } })).status()).toBe(204);
});

test('loading a page sends nothing to /api/events; a script error sends one error event', async ({ page }) => {
  const types = [];
  await page.addInitScript(() => {
    const real = navigator.sendBeacon.bind(navigator);
    window.__beacons = [];
    navigator.sendBeacon = (url, data) => {
      data.text().then((t) => window.__beacons.push(JSON.parse(t).type));
      return real(url, data);
    };
  });
  page.on('request', (r) => { if (r.url().endsWith('/api/events')) types.push(r.method()); });
  await page.goto('/games?ref=x#h');
  await page.waitForTimeout(1000);
  expect(types).toEqual([]);
  await page.evaluate(() => setTimeout(() => { throw new Error('lg2 e2e boom'); }));
  await expect.poll(() => page.evaluate(() => window.__beacons)).toEqual(['error']);
});
