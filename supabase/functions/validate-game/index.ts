// validate-game: POST { "gameId": "<id>", "reason"?: string } with the x-meshgrounds-hook secret or a service-role JWT (auth.ts).
// Loads games/<id>/index.html from Storage, runs the shared static check (SP-4), writes a
// game_validations row (SP-3). Manual review (default) leaves a pass pending; a fail still rejects.
// Re-running for the same bundle (same sha256) is a no-op that returns the stored verdict.
// It has no npm dependencies (acorn is vendored), so the worker boots without registry access.
import { validateGame } from './validate.ts';
import { createRestStore } from './rest-store.ts';
import { isAuthorized, parseBody, type AuthEnv } from './auth.ts';

// Env: VALIDATE_GAME_HOOK_SECRET (shared with the EF-2 hook; set via `supabase secrets set`, never logged),
// SUPABASE_SERVICE_ROLE_KEY / SUPABASE_JWT_SECRET (manual reruns with a service-role JWT). See auth.ts.
const AUTH: AuthEnv = {
  hookSecret: Deno.env.get('VALIDATE_GAME_HOOK_SECRET') || undefined,
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || undefined,
  jwtSecret: Deno.env.get('SUPABASE_JWT_SECRET') || undefined,
};

const store = createRestStore(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

Deno.serve(async (req) => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!(await isAuthorized(req, AUTH))) return json(401, { error: 'unauthorized' });
  const parsed = await parseBody(req);
  if ('error' in parsed) return json(400, { error: parsed.error });
  const { gameId, reason } = parsed;
  try {
    const r = await validateGame(store, gameId);
    return json(r.httpStatus, { ...r.body, ...(reason ? { reason } : {}) });
  } catch (e) {
    console.error('validate-game', e);
    return json(500, { error: 'validation failed to run' });
  }
});
