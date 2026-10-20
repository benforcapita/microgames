import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DISMISS_MS, detectPlatform, recentlyDismissed } from './install-prompt.ts';

describe('detectPlatform', () => {
  it('spots iPhone, iPad and iPadOS desktop-mode Safari', () => {
    assert.equal(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'), 'ios');
    assert.equal(detectPlatform('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'ios');
    assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5), 'ios');
  });
  it('spots Android and leaves desktops alone', () => {
    assert.equal(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36'), 'android');
    assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0), 'other');
    assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130'), 'other');
  });
});

describe('recentlyDismissed', () => {
  const now = 1_800_000_000_000;
  it('is quiet inside the window and prompts again after it', () => {
    assert.equal(recentlyDismissed(String(now - 1000), now), true);
    assert.equal(recentlyDismissed(String(now - DISMISS_MS - 1), now), false);
  });
  it('treats missing or garbage values as never dismissed', () => {
    assert.equal(recentlyDismissed(null, now), false);
    assert.equal(recentlyDismissed('nope', now), false);
  });
});
