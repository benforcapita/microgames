import { readFileSync } from 'node:fs';

function getSupabaseDbPort(): number {
  try {
    const toml = readFileSync(new URL('../../../supabase/config.toml', import.meta.url), 'utf8');
    const match = toml.match(/\[db\][^\[]*?\bport\s*=\s*(\d+)/s);
    if (match?.[1]) {
      return Number(match[1]);
    }
  } catch {}
  return 54322;
}

process.env.PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'mock';
process.env.SUPABASE_SECRET_KEY ??= 'mock';
process.env.DATABASE_URL ??= `postgresql://postgres:postgres@127.0.0.1:${getSupabaseDbPort()}/postgres`;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildPreviewLinkUrl,
  mapPreviewLinkError,
  validateRpcCreatedLink,
  validateActiveLinks,
  isUuid,
} = await import('./preview-links');

test('buildPreviewLinkUrl forms site url with token', () => {
  assert.equal(
    buildPreviewLinkUrl({ siteUrl: 'http://localhost:4321', token: 'tok123' }),
    'http://localhost:4321/p/tok123',
  );
  assert.equal(
    buildPreviewLinkUrl({ siteUrl: 'https://meshground.app/', token: 'tok_abc-def' }),
    'https://meshground.app/p/tok_abc-def',
  );
});

test('buildPreviewLinkUrl falls back to request origin when siteUrl is not provided', () => {
  assert.equal(
    buildPreviewLinkUrl({ requestOrigin: 'http://127.0.0.1:4321', token: 'tok456' }),
    'http://127.0.0.1:4321/p/tok456',
  );
  assert.equal(
    buildPreviewLinkUrl({ requestOrigin: 'http://127.0.0.1:4321/', token: 'tok456' }),
    'http://127.0.0.1:4321/p/tok456',
  );
});

test('buildPreviewLinkUrl handles empty origins', () => {
  assert.equal(
    buildPreviewLinkUrl({ token: 'tok789' }),
    '/p/tok789',
  );
});

test('mapPreviewLinkError maps cap error to 409 status and clear limit message', () => {
  const expected = {
    status: 409,
    message: 'You already have 5 active preview links. Revoke one to create another.',
  };
  assert.deepEqual(mapPreviewLinkError('preview_link_cap'), expected);
  assert.deepEqual(mapPreviewLinkError('error: preview_link_cap occurred'), expected);
  assert.deepEqual(mapPreviewLinkError({ message: 'preview_link_cap' }), expected);
  assert.deepEqual(mapPreviewLinkError({ details: 'preview_link_cap' }), expected);
  assert.deepEqual(mapPreviewLinkError(new Error('preview_link_cap')), expected);
});

test('mapPreviewLinkError maps hour error to 429 status and clear limit message', () => {
  const expected = {
    status: 429,
    message: "You've created 10 preview links in the last hour. Try again later.",
  };
  assert.deepEqual(mapPreviewLinkError('preview_link_hour'), expected);
  assert.deepEqual(mapPreviewLinkError('error: preview_link_hour occurred'), expected);
  assert.deepEqual(mapPreviewLinkError({ message: 'preview_link_hour' }), expected);
  assert.deepEqual(mapPreviewLinkError({ details: 'preview_link_hour' }), expected);
  assert.deepEqual(mapPreviewLinkError(new Error('preview_link_hour')), expected);
});

test('mapPreviewLinkError maps raw database and unknown errors to generic 500 message', () => {
  const generic = {
    status: 500,
    message: 'Could not create preview link. Please try again.',
  };
  assert.deepEqual(mapPreviewLinkError('preview_link_denied'), generic);
  assert.deepEqual(mapPreviewLinkError({ message: 'new row violates row-level security policy' }), generic);
  assert.deepEqual(mapPreviewLinkError(new Error('database connection failed')), generic);
  assert.deepEqual(mapPreviewLinkError(null), generic);
  assert.deepEqual(mapPreviewLinkError(undefined), generic);
  assert.deepEqual(mapPreviewLinkError(123), generic);
});

test('validateRpcCreatedLink extracts valid created link payload', () => {
  const validArray = [{ id: 'link-1', token: 'token-1', expires_at: '2026-10-28T12:00:00Z' }];
  assert.deepEqual(validateRpcCreatedLink(validArray), {
    id: 'link-1',
    token: 'token-1',
    expiresAt: '2026-10-28T12:00:00Z',
  });

  const validObject = { id: 'link-2', token: 'token-2', expires_at: '2026-10-28T13:00:00Z' };
  assert.deepEqual(validateRpcCreatedLink(validObject), {
    id: 'link-2',
    token: 'token-2',
    expiresAt: '2026-10-28T13:00:00Z',
  });
});

test('validateRpcCreatedLink returns null for invalid payloads', () => {
  assert.equal(validateRpcCreatedLink(null), null);
  assert.equal(validateRpcCreatedLink(undefined), null);
  assert.equal(validateRpcCreatedLink([]), null);
  assert.equal(validateRpcCreatedLink([{ id: 'link-1' }]), null);
  assert.equal(validateRpcCreatedLink([{ id: 123, token: 'tok', expires_at: 'date' }]), null);
});

test('validateActiveLinks parses active link rows and ignores invalid items', () => {
  const rows = [
    {
      id: 'l-1',
      version_id: 'v-1',
      expires_at: '2026-10-28T12:00:00Z',
      view_count: 3,
      created_at: '2026-10-21T12:00:00Z',
    },
    {
      id: 'l-2',
      version_id: 'v-2',
      expires_at: '2026-10-29T12:00:00Z',
      view_count: 0,
      created_at: '2026-10-21T13:00:00Z',
    },
    null,
    'garbage',
    { id: 'l-3' },
  ];

  const parsed = validateActiveLinks(rows);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    id: 'l-1',
    versionId: 'v-1',
    expiresAt: '2026-10-28T12:00:00Z',
    viewCount: 3,
    createdAt: '2026-10-21T12:00:00Z',
  });
  assert.deepEqual(parsed[1], {
    id: 'l-2',
    versionId: 'v-2',
    expiresAt: '2026-10-29T12:00:00Z',
    viewCount: 0,
    createdAt: '2026-10-21T13:00:00Z',
  });
});

test('isUuid validates uuid strings correctly', () => {
  assert.equal(isUuid('f47ac10b-58cc-4372-a567-0e02b2c3d479'), true);
  assert.equal(isUuid('00000000-0000-0000-0000-000000000000'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(undefined), false);
  assert.equal(isUuid(123), false);
  assert.equal(isUuid({}), false);
});
