// Test harness: createHandler over a fake Supabase that serves cdn/fixtures/* as the games bucket.
import fs from 'node:fs';
import { createHandler } from '../handler.mjs';

export const STAGES: Record<string, string> = { assetgm1: 'live', provgm01: 'proving', othergm1: 'live' };
const DIRS: Record<string, string> = { assetgm1: 'asset-game', provgm01: 'asset-game', othergm1: 'other-game' };

export function fixtureHandler(opts: { webOrigins?: string; cdnOrigin?: string } = {}) {
  const calls: string[] = [];
  const fakeFetch = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/rest/v1/games') {
      const id = (u.searchParams.get('id') ?? '').replace(/^eq\./, '');
      return new Response(JSON.stringify(STAGES[id] ? [{ stage: STAGES[id] }] : []));
    }
    // All fixture games are at bundle version 1 (the real source is max(game_validations.version)).
    if (u.pathname === '/rest/v1/game_validations') {
      const id = (u.searchParams.get('game_id') ?? '').replace(/^eq\./, '');
      return new Response(JSON.stringify(STAGES[id] ? [{ version: 1 }] : []));
    }
    if (u.pathname === '/rest/v1/game_assets') {
      // The CDN serves a versioned asset only with a finalized 'uploaded' row. Every object that
      // exists in a fixture dir counts as finalized; everything else has no row (orphan uploads).
      const id = (u.searchParams.get('game_id') ?? '').replace(/^eq\./, '');
      const version = (u.searchParams.get('version') ?? '').replace(/^eq\./, '');
      const assetPath = decodeURIComponent((u.searchParams.get('path') ?? '').replace(/^eq\./, ''));
      const file = DIRS[id] ? new URL(`./${DIRS[id]}/${version}/${assetPath}`, import.meta.url) : null;
      return new Response(JSON.stringify(file && fs.existsSync(file) ? [{ status: 'uploaded' }] : []), { status: 200 });
    }
    const m = /\/storage\/v1\/object\/authenticated\/games\/([^/]+)\/(.+)$/.exec(u.pathname);
    const file = m && DIRS[m[1]] ? new URL(`./${DIRS[m[1]]}/${m[2]}`, import.meta.url) : null;
    if (file && fs.existsSync(file)) return new Response(fs.readFileSync(file));
    return new Response('nope', { status: 404 });
  };
  const handle = createHandler({ supabaseUrl: 'http://sb.local', secret: 'sb_secret_x', webOrigins: opts.webOrigins ?? 'http://127.0.0.1:4321', cdnOrigin: opts.cdnOrigin, fetch: fakeFetch as typeof fetch });
  return { handle, calls };
}
