import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  applyDeviceHeaders,
  desktopOnlyNotice,
  detectDevice,
  filterForDevice,
  isMissingInputSupportColumn,
  playSurface,
  readWithInputSupport,
  resetInputSupportWarning,
  variesByDevice,
  visibleOnDevice,
  type InputSupport,
} from './device.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function headers(init: Record<string, string> = {}) {
  return new Headers(init);
}

describe('detectDevice', () => {
  it('trusts Sec-CH-UA-Mobile over the User-Agent', () => {
    assert.equal(detectDevice(headers({ 'sec-ch-ua-mobile': '?1', 'user-agent': DESKTOP })), 'mobile');
    assert.equal(detectDevice(headers({ 'sec-ch-ua-mobile': '?0', 'user-agent': IPHONE })), 'desktop');
  });

  it('accepts a hint with surrounding whitespace', () => {
    assert.equal(detectDevice(headers({ 'sec-ch-ua-mobile': ' ?1 ' })), 'mobile');
    assert.equal(detectDevice(headers({ 'sec-ch-ua-mobile': '?0\t' })), 'desktop');
  });

  it('falls back to the User-Agent when the hint is missing or unrecognized', () => {
    assert.equal(detectDevice(headers({ 'user-agent': IPHONE })), 'mobile');
    assert.equal(detectDevice(headers({ 'user-agent': ANDROID })), 'mobile');
    assert.equal(detectDevice(headers({ 'user-agent': IPAD })), 'mobile');
    assert.equal(detectDevice(headers({ 'user-agent': DESKTOP })), 'desktop');
    assert.equal(detectDevice(headers()), 'desktop');
    assert.equal(detectDevice(headers({ 'sec-ch-ua-mobile': 'true', 'user-agent': IPHONE })), 'mobile');
    assert.equal(detectDevice(headers({ 'sec-ch-ua-mobile': 'true', 'user-agent': DESKTOP })), 'desktop');
    assert.equal(detectDevice(headers({ 'sec-ch-ua-mobile': '' })), 'desktop');
  });
});

describe('catalog filtering', () => {
  const games: { id: string; inputSupport: InputSupport | null | 'weird' }[] = [
    { id: 'desktop', inputSupport: 'desktop' },
    { id: 'mobile', inputSupport: 'mobile' },
    { id: 'both', inputSupport: 'both' },
    { id: 'unknown', inputSupport: 'unknown' },
    { id: 'null', inputSupport: null },
    { id: 'weird', inputSupport: 'weird' },
  ];

  it('hides only desktop-only games on mobile', () => {
    assert.deepEqual(filterForDevice(games, 'mobile').map((g) => g.id), ['mobile', 'both', 'unknown', 'null', 'weird']);
    for (const support of ['unknown', 'mobile', 'both', null, undefined, 'nope'] as const) {
      assert.equal(visibleOnDevice(support, 'mobile'), true, String(support));
    }
    assert.equal(visibleOnDevice('desktop', 'mobile'), false);
    assert.equal(visibleOnDevice(' DESKTOP ', 'mobile'), false);
  });

  it('leaves the desktop catalog unchanged', () => {
    assert.deepEqual(filterForDevice(games, 'desktop').map((g) => g.id), games.map((g) => g.id));
    assert.equal(visibleOnDevice('desktop', 'desktop'), true);
  });
});

describe('desktop-only notice', () => {
  it('shows the notice only for a desktop-only game on mobile', () => {
    assert.equal(playSurface('mobile', 'desktop'), 'desktop-only');
    assert.equal(playSurface('mobile', 'DESKTOP'), 'desktop-only');
    assert.equal(playSurface('desktop', 'desktop'), 'player');
    assert.equal(playSurface('mobile', 'unknown'), 'player');
    assert.equal(playSurface('mobile', 'both'), 'player');
    assert.equal(playSurface('mobile', 'mobile'), 'player');
    assert.equal(playSurface('mobile', null), 'player');
  });

  it('includes the title and tells the visitor to open the game on a computer', () => {
    const notice = desktopOnlyNotice('  Stack Tower ');
    assert.equal(notice.heading, 'Desktop only');
    assert.equal(notice.title, 'Stack Tower');
    assert.match(notice.message, /open stack tower on a computer/i);
    assert.equal(desktopOnlyNotice('   ').title, 'This game');
    assert.match(desktopOnlyNotice('   ').message, /open this game on a computer/i);
  });
});

describe('device variance headers', () => {
  it('marks catalog and play responses so device types do not share a cache', () => {
    for (const path of ['/', '/games', '/games/', '/proving', '/play/stack-tower', '/u/polyprism']) {
      assert.equal(variesByDevice(path), true, path);
      const headers = new Headers({ Vary: 'Accept-Encoding' });
      applyDeviceHeaders(headers, path);
      assert.equal(headers.get('Accept-CH'), 'Sec-CH-UA-Mobile');
      assert.equal(headers.get('Critical-CH'), 'Sec-CH-UA-Mobile');
      assert.equal(headers.get('Vary'), 'Accept-Encoding, Sec-CH-UA-Mobile, User-Agent');
      assert.equal(headers.get('Cache-Control'), 'private, no-store');
    }
  });

  it('does not vary unrelated pages', () => {
    for (const path of ['/login', '/upload', '/me', '/creators', '/api/telemetry', '/api/games']) {
      assert.equal(variesByDevice(path), false, path);
      const headers = new Headers();
      applyDeviceHeaders(headers, path);
      assert.equal(headers.get('Vary'), null);
      assert.equal(headers.get('Cache-Control'), null);
      assert.equal(headers.get('Accept-CH'), null);
    }
  });

  it('does not duplicate vary tokens', () => {
    const headers = new Headers({ Vary: 'User-Agent, sec-ch-ua-mobile' });
    applyDeviceHeaders(headers, '/games');
    assert.equal(headers.get('Vary'), 'User-Agent, sec-ch-ua-mobile');
  });
});

describe('readWithInputSupport', { concurrency: 1 }, () => {
  afterEach(() => {
    resetInputSupportWarning();
    mock.restoreAll();
  });

  it('applies the desktop filter when the column exists', async () => {
    const calls: boolean[] = [];
    const rows = await readWithInputSupport(true, async (filter) => {
      calls.push(filter);
      return ['kept'];
    });
    assert.deepEqual(calls, [true]);
    assert.deepEqual(rows, ['kept']);
  });

  it('retries without the filter when Postgres says input_support does not exist, and warns once', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const calls: boolean[] = [];
    const missing = Object.assign(new Error('column "input_support" does not exist'), { code: '42703' });
    const run = async (filter: boolean) => {
      calls.push(filter);
      if (filter) throw missing;
      return ['all-unknown'];
    };
    assert.deepEqual(await readWithInputSupport(true, run), ['all-unknown']);
    assert.deepEqual(await readWithInputSupport(true, run), ['all-unknown']);
    assert.deepEqual(calls, [true, false, true, false]);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /games\.input_support/);
  });

  it('recognizes a missing-column message without a SQLSTATE', () => {
    assert.equal(isMissingInputSupportColumn(new Error('column "input_support" of relation "games" does not exist')), true);
    assert.equal(isMissingInputSupportColumn(Object.assign(new Error('other'), { code: '23502' })), false);
  });

  it('does not swallow an unrelated query error', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const fk = Object.assign(new Error('violates foreign key'), { code: '23503' });
    await assert.rejects(() => readWithInputSupport(true, async () => { throw fk; }), (err: unknown) => (err as { code?: string }).code === '23503');
    await assert.rejects(() => readWithInputSupport(false, async () => { throw fk; }));
    assert.equal(warn.mock.calls.length, 0);
  });
});
