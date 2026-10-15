// validate-game: POST { "gameId": "<id>" } using the service-role key.
// Loads games/<id>/index.html from Storage, runs the shared static check (SP-4), writes a
// game_validations row (SP-3) and auto-publishes: pending -> proving on pass, pending -> rejected on fail.
// Re-running for the same bundle (same sha256) is a no-op that returns the stored verdict.
// It has no npm dependencies (acorn is vendored), so the worker boots without registry access.
import type { Stage } from '../../../src/lib/server/game-rules.ts';
import { validateGame, type Store, type ValidationRow } from './validate.ts';

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

function isServiceRole(req: Request): boolean {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  if (KEY && token === KEY) return true;
  // The gateway has already verified the JWT signature (verify_jwt); just check the role claim.
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!isServiceRole(req)) return json(403, { error: 'service role required' });
  let gameId: unknown;
  try {
    ({ gameId } = await req.json());
  } catch {
    return json(400, { error: 'body must be JSON { gameId }' });
  }
  if (typeof gameId !== 'string') return json(400, { error: 'gameId required' });
  try {
    const r = await validateGame(store, gameId);
    return json(r.httpStatus, r.body);
  } catch (e) {
    console.error('validate-game', e);
    return json(500, { error: 'validation failed to run' });
  }
});
