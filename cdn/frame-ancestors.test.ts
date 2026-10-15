import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { frameAncestors, matchEmbedder, normalizeOrigin, refererOrigin } from './frame-ancestors.mjs';

const PROD = 'https://meshgrounds.vercel.app';
const WEB = `${PROD} http://localhost:* http://127.0.0.1:*`;
const PREVIEW = 'https://meshgrounds-abc123-benteam2.vercel.app';
const fa = (h: { origin?: unknown; referer?: unknown; embed?: unknown }, webOrigins = WEB) =>
  frameAncestors({ ...h, webOrigins });

describe('frameAncestors: accepted embedders', () => {
  it('echoes a preview origin from the Origin header', () => {
    assert.equal(fa({ origin: PREVIEW }), `${WEB} ${PREVIEW}`);
  });
  it('echoes a preview origin from the Referer (path stripped)', () => {
    assert.equal(fa({ referer: `${PREVIEW}/play/neon?x=1` }), `${WEB} ${PREVIEW}`);
  });
  it('echoes a preview origin from the embed hint', () => {
    assert.equal(fa({ embed: PREVIEW }), `${WEB} ${PREVIEW}`);
  });
  it('accepts multi-segment preview names', () => {
    const o = 'https://meshgrounds-git-ag-mg-11-frame-ancestors-benteam2.vercel.app';
    assert.equal(fa({ embed: o }), `${WEB} ${o}`);
  });
  it('keeps prod working without duplicating it', () => {
    assert.equal(fa({ embed: PROD }), WEB);
    assert.equal(fa({}), WEB);
  });
  it('keeps the localhost wildcard default unchanged', () => {
    const def = 'http://localhost:* http://127.0.0.1:*';
    assert.equal(fa({ embed: 'http://localhost:4321' }, def), def);
    assert.equal(fa({ embed: PREVIEW }, def), `${def} ${PREVIEW}`);
  });
  it("keeps 'self' only when already configured", () => {
    assert.equal(fa({ embed: PREVIEW }, `'self' ${PROD}`), `'self' ${PROD} ${PREVIEW}`);
    assert.ok(!fa({ embed: PREVIEW }).includes("'self'"));
  });
  it('prefers Origin, then Referer, then embed', () => {
    const other = 'https://meshgrounds-other-benteam2.vercel.app';
    assert.equal(fa({ origin: PREVIEW, referer: `${other}/`, embed: other }), `${WEB} ${PREVIEW}`);
    assert.equal(fa({ origin: 'https://evil.com', referer: `${other}/`, embed: PREVIEW }), `${WEB} ${other}`);
  });
});

describe('frameAncestors: rejected look-alikes fall back to the configured list', () => {
  const bad: unknown[] = [
    'https://meshgrounds-x-benteam2.vercel.app.evil.com',
    'http://meshgrounds-x-benteam2.vercel.app',
    'https://evilmeshgrounds-x-benteam2.vercel.app',
    'https://meshgrounds-x-benteam3.vercel.app',
    'https://MESHGROUNDS-X-BENTEAM2.VERCEL.APP',
    'https://Meshgrounds-x-benteam2.vercel.app',
    ' https://meshgrounds-x-benteam2.vercel.app',
    'https://meshgrounds-x-benteam2.vercel.app ',
    'https://meshgrounds-x-benteam2.vercel.app\n',
    'https://meshgrounds-x-benteam2.vercel.app\t',
    'https://meshgrounds-x-benteam2.vercel.app/',
    'https://user@meshgrounds-x-benteam2.vercel.app',
    'https://meshgrounds-x-benteam2.vercel.app:8443',
    'https://meshgrounds-x_y-benteam2.vercel.app',
    'https://meshgrounds-x-benteam2.vercel.app; script-src *',
    'https://meshgrounds-x-benteam2.vercel.app https://evil.com',
    'https://evil.com',
    'http://localhost:4321',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
    undefined,
    42,
    ['https://meshgrounds-x-benteam2.vercel.app'],
  ];
  for (const value of bad) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      assert.equal(fa({ origin: value, embed: value }), WEB);
    });
  }
  it('rejects malformed or look-alike Referers', () => {
    for (const r of ['not a url', 'javascript:alert(1)', '//meshgrounds-x-benteam2.vercel.app/', 'https://meshgrounds-x-benteam2.vercel.app.evil.com/play', 'https://user:pw@meshgrounds-x-benteam2.vercel.app/', ' https://meshgrounds-x-benteam2.vercel.app/']) {
      assert.equal(fa({ referer: r }), WEB, r);
    }
  });
});

describe('helpers', () => {
  it('normalizeOrigin requires an exact canonical origin', () => {
    assert.equal(normalizeOrigin(PREVIEW), PREVIEW);
    assert.equal(normalizeOrigin(`${PREVIEW}/`), null);
    assert.equal(normalizeOrigin('ftp://x.com'), null);
  });
  it('refererOrigin extracts the origin or returns null', () => {
    assert.equal(refererOrigin(`${PREVIEW}/a/b`), PREVIEW);
    assert.equal(refererOrigin('nope'), null);
  });
  it('matchEmbedder never matches wildcard allow-list entries literally', () => {
    assert.equal(matchEmbedder('http://localhost:*', ['http://localhost:*']), null);
  });
});
