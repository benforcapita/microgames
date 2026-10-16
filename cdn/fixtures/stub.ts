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
    const m = /\/storage\/v1\/object\/authenticated\/games\/([^/]+)\/(.+)$/.exec(u.pathname);
    const file = m && DIRS[m[1]] ? new URL(`./${DIRS[m[1]]}/${m[2]}`, import.meta.url) : null;
    if (file && fs.existsSync(file)) return new Response(fs.readFileSync(file));
    return new Response('nope', { status: 404 });
  };
  const handle = createHandler({ supabaseUrl: 'http://sb.local', secret: 'sb_secret_x', webOrigins: opts.webOrigins ?? 'http://127.0.0.1:4321', cdnOrigin: opts.cdnOrigin, fetch: fakeFetch as typeof fetch });
  return { handle, calls };
}
