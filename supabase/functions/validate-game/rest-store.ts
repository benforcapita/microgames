// Store backed by Supabase REST + Storage, shared by the Edge Function (index.ts) and the e2e specs
// that run the same validation in-process against a local stack. Runtime-neutral: fetch only, no
// Deno or Node APIs, so both environments use the exact same calls.
import type { Stage } from '../../../src/lib/server/game-rules.ts';
import type { Store, ValidationRow } from './validate.ts';

export function createRestStore(supabaseUrl: string, secretKey: string): Store {
  const URL_ = supabaseUrl.replace(/\/$/, '');
  const H = { apikey: secretKey, Authorization: `Bearer ${secretKey}` };
  const rest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, 'Content-Type': 'application/json', ...init.headers } });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
    return r.json() as Promise<T>;
  };
  const eq = (v: string) => `eq.${encodeURIComponent(v)}`;
  return {
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
    async recordValidation({ gameId, sha256, status, report, manualReview }) {
      // The stage transition happens in SQL (record_game_validation mirrors stageAfterValidation) so it is atomic.
      const [row] = await rest<(ValidationRow & { stage: Stage })[]>('rpc/record_game_validation', {
        method: 'POST',
        body: JSON.stringify({ p_game_id: gameId, p_sha256: sha256, p_status: status, p_report: report, p_manual_review: manualReview }),
      });
      return row ? { row, stage: row.stage } : null;
    },
    async applyStoredVerdict(gameId, sha256, manualReview) {
      // Atomic in SQL too: lock the game, move it only if it is pending, using the stored verdict for this bundle.
      const [row] = await rest<{ stage: Stage }[]>('rpc/apply_stored_validation', {
        method: 'POST',
        body: JSON.stringify({ p_game_id: gameId, p_sha256: sha256, p_manual_review: manualReview }),
      });
      return row?.stage ?? null;
    },
  };
}
