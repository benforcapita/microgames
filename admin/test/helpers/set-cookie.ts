import assert from 'node:assert/strict';

export type ParsedSetCookie = {
  name: string;
  value: string;
  attrs: Map<string, string | true>;
};

export function parseSetCookie(header: string): ParsedSetCookie {
  const parts = header.split(';').map((part) => part.trim());
  const first = parts[0] ?? '';
  const eq = first.indexOf('=');
  const name = eq >= 0 ? first.slice(0, eq) : first;
  const value = eq >= 0 ? first.slice(eq + 1) : '';
  const attrs = new Map<string, string | true>();
  for (const part of parts.slice(1)) {
    const i = part.indexOf('=');
    if (i === -1) attrs.set(part.toLowerCase(), true);
    else attrs.set(part.slice(0, i).toLowerCase(), part.slice(i + 1));
  }
  return { name, value, attrs };
}

export function assertStrictSetCookie(header: string): ParsedSetCookie {
  const cookie = parseSetCookie(header);
  assert.equal(cookie.attrs.get('httponly'), true, cookie.name);
  assert.equal(cookie.attrs.get('secure'), true, cookie.name);
  assert.equal(String(cookie.attrs.get('samesite')).toLowerCase(), 'strict', cookie.name);
  assert.equal(cookie.attrs.get('path'), '/', cookie.name);
  assert.equal(cookie.attrs.has('domain'), false, cookie.name);
  return cookie;
}
