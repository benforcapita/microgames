import type { AstroCookies } from 'astro';
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { GAMES_BUCKET, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, SUPABASE_URL } from './config';

/** Per-request client bound to the visitor's auth cookies. `headers` collects cache headers Supabase requires on cookie writes. */
export function createRequestClient(request: Request, cookies: AstroCookies, headers: Headers): SupabaseClient {
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get('Cookie') ?? '').map((c) => ({ name: c.name, value: c.value ?? '' })),
      setAll: (list, extra) => {
        list.forEach(({ name, value, options }) => cookies.set(name, value, options as Parameters<AstroCookies['set']>[2]));
        Object.entries(extra ?? {}).forEach(([k, v]) => headers.set(k, v));
      },
    },
  });
}

const g = globalThis as typeof globalThis & { __mgAdmin?: SupabaseClient };

/** Service-role client for server-only work (storage). Never expose to the browser. */
export const admin: SupabaseClient = (g.__mgAdmin ??= createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
}));

export const bucket = () => admin.storage.from(GAMES_BUCKET);
