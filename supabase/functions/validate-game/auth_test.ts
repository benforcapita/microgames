// deno test --config supabase/functions/validate-game/deno.json supabase/functions/validate-game/
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { isAuthorized, parseBody, timingSafeEqual, verifyServiceJwt } from './auth.ts';

const SECRET = 'hook-secret-0123456789abcdef';
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
const b64u = (b: Uint8Array | string) => btoa(typeof b === 'string' ? b : String.fromCharCode(...b)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function jwt(payload: Record<string, unknown>, secret = JWT_SECRET, alg = 'HS256') {
  const head = `${b64u(JSON.stringify({ alg, typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${head}.${b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(head))))}`;
}
const req = (headers: Record<string, string>, body: unknown = { gameId: 'abc123' }) =>
  new Request('http://x/functions/v1/validate-game', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ENV = { hookSecret: SECRET, jwtSecret: JWT_SECRET, serviceRoleKey: 'sr-key-literal' };

Deno.test('hook secret: good secret is accepted', async () => {
  assert(await isAuthorized(req({ 'x-meshgrounds-hook': SECRET }), ENV));
});
Deno.test('hook secret: bad secret, wrong length, or missing header is rejected', async () => {
  for (const h of [SECRET.slice(0, -1) + 'X', SECRET + 'x', '', 'x']) assert(!(await isAuthorized(req({ 'x-meshgrounds-hook': h }), ENV)), h);
  assert(!(await isAuthorized(req({}), ENV)));
});
Deno.test('hook secret: env unset means the header path is always rejected', async () => {
  for (const hookSecret of [undefined, '']) {
    assert(!(await isAuthorized(req({ 'x-meshgrounds-hook': '' }), { hookSecret })));
    assert(!(await isAuthorized(req({ 'x-meshgrounds-hook': 'anything' }), { hookSecret })));
  }
});
Deno.test('service-role JWT: valid signed token or the literal service key is accepted', async () => {
  assert(await isAuthorized(req({ Authorization: `Bearer ${await jwt({ role: 'service_role', exp: 9999999999 })}` }), ENV));
  assert(await isAuthorized(req({ Authorization: 'Bearer sr-key-literal' }), { serviceRoleKey: 'sr-key-literal' }));
});
Deno.test('JWT: anon role, wrong signature, expired, alg none are rejected', async () => {
  for (const t of [
    await jwt({ role: 'anon', exp: 9999999999 }),
    await jwt({ role: 'service_role' }, 'another-secret-another-secret-another-secret'),
    await jwt({ role: 'service_role', exp: 1 }),
    `${b64u('{"alg":"none"}')}.${b64u('{"role":"service_role"}')}.`,
    'not-a-jwt',
  ]) assert(!(await isAuthorized(req({ Authorization: `Bearer ${t}` }), ENV)), t);
  assert(!(await verifyServiceJwt(await jwt({ role: 'service_role' }), '')));
});
Deno.test('body: {gameId, reason?}, unknown fields ignored, missing gameId is an error', async () => {
  assertEquals(await parseBody(req({}, { gameId: 'g1', reason: 'stage_pending', extra: 1 })), { gameId: 'g1', reason: 'stage_pending' });
  assertEquals(await parseBody(req({}, { gameId: 'g1' })), { gameId: 'g1' });
  for (const b of [{}, { reason: 'sweep' }, { gameId: 5 }, { gameId: '' }, null]) assertEquals('error' in (await parseBody(req({}, b))), true, JSON.stringify(b));
  assertEquals('error' in (await parseBody(req({}, 'not json'))), true);
});
Deno.test('timingSafeEqual', () => {
  assert(timingSafeEqual('abc', 'abc'));
  assert(!timingSafeEqual('abc', 'abd') && !timingSafeEqual('abc', 'abcd') && !timingSafeEqual('', 'a'));
});
