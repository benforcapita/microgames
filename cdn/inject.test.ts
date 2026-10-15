import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore -- plain .mjs module
import { injectHead, hasViewport, VIEWPORT } from './inject.mjs';

const BOOT = 'window.__boot=1';
const metaRe = /<meta\b[^>]*name="viewport"[^>]*>/gi;

test('game without a viewport meta gets the zoom-locked one, touch-action and boot right after <head>', () => {
  const out = injectHead('<!doctype html><html><head><title>x</title></head><body></body></html>', BOOT);
  assert.equal(VIEWPORT, 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  assert.equal(out.match(metaRe)?.length, 1);
  assert.ok(out.startsWith(`<!doctype html><html><head><meta name="viewport" content="${VIEWPORT}"><style>html,body{touch-action:manipulation}</style><script>${BOOT}</script><title>`));
});

test("game with its own viewport meta keeps it; we don't add a second one", () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body></body></html>';
  const out = injectHead(html, BOOT);
  assert.equal(out.match(metaRe)?.length, 1);
  assert.match(out, /content="width=device-width"/);
  assert.ok(out.includes('touch-action:manipulation'));
  assert.ok(out.includes(`<script>${BOOT}</script>`));
});

test('viewport detection: attribute order, quotes and case', () => {
  assert.ok(hasViewport('<META content="x" NAME=viewport>'));
  assert.ok(hasViewport("<meta name='viewport' content='x'/>"));
  assert.ok(!hasViewport('<meta name="viewport-fit" content="x">'));
  assert.ok(!hasViewport('<meta name="description" content="viewport">'));
});

test('documents without <head> still get the boot (existing behaviour) plus meta and style', () => {
  const out = injectHead('<!doctype html><canvas></canvas>', BOOT);
  assert.ok(out.startsWith(`<!doctype html><meta name="viewport" content="${VIEWPORT}"><style>`));
  assert.ok(out.endsWith('<canvas></canvas>'));
});
