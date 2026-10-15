// validate-game: POST { "gameId": "<id>", "reason"?: string } with the x-meshgrounds-hook secret or a service-role JWT (auth.ts).
// Loads games/<id>/index.html from Storage, runs the shared static check (SP-4), writes a
// game_validations row (SP-3) and auto-publishes: pending -> proving on pass, pending -> rejected on fail.
// Re-running for the same bundle (same sha256) is a no-op that returns the stored verdict.
// It has no npm dependencies (acorn is vendored), so the worker boots without registry access.
import type { Stage } from '../../../src/lib/server/game-rules.ts';
import { validateGame, type Store, type ValidationRow } from './validate.ts';
import { isAuthorized, parseBody, type AuthEnv } from './auth.ts';

// Env: VALIDATE_GAME_HOOK_SECRET (shared with the EF-2 hook; set via `supabase secrets set`, never logged),
// SUPABASE_SERVICE_ROLE_KEY / SUPABASE_JWT_SECRET (manual reruns with a service-role JWT). See auth.ts.
const AUTH: AuthEnv = {
  hookSecret: Deno.env.get('VALIDATE_GAME_HOOK_SECRET') || undefined,
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || undefined,
  jwtSecret: Deno.env.get('SUPABASE_JWT_SECRET') || undefined,
};

const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, 'Content-Type': 'application/json', ...init.headers } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}
const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

const store: Store = {
  async gameStage(gameId) {
    const [g] = await rest<{ stage: Stage }[]>(`games?select=stage&id=${eq(gameId)}`);
    return g?.stage ?? null;
  },
  async bundle(gameId) {
    const r = await fetch(`${URL_}/storage/v1/object/games/${gameId}/index.html`, { headers: H });
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  },
  async findValidation(gameId, sha256) {
    const [row] = await rest<ValidationRow[]>(`game_validations?select=id,status,bundle_sha256,version&game_id=${eq(gameId)}&bundle_sha256=${eq(sha256)}`);
    return row ?? null;
  },
  async recordValidation({ gameId, sha256, status, report }) {
    // The stage transition happens in SQL (record_game_validation mirrors stageAfterValidation) so it is atomic.
    const [row] = await rest<(ValidationRow & { stage: Stage })[]>('rpc/record_game_validation', {
      method: 'POST',
      body: JSON.stringify({ p_game_id: gameId, p_sha256: sha256, p_status: status, p_report: report }),
    });
    return row ? { row, stage: row.stage } : null;
  },
};

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
