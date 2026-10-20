import type { AstroGlobal } from 'astro';
import { isAdmin } from './profiles';

const NO_STORE = 'private, no-store';

/**
 * Gate for admin pages: `const gate = await requireAdmin(Astro); if (gate) return gate;`.
 * Signed-out visitors go to login; signed-in non-admins get a 404 so the route's existence
 * is not advertised. Admin pages are never cacheable.
 */
export async function requireAdmin(Astro: AstroGlobal): Promise<Response | null> {
  Astro.response.headers.set('Cache-Control', NO_STORE);
  if (!Astro.locals.user) {
    const r = Astro.redirect(`/login?next=${encodeURIComponent(Astro.url.pathname + Astro.url.search)}`);
    r.headers.set('Cache-Control', NO_STORE);
    return r;
  }
  if (!isAdmin(Astro.locals.profile)) return Astro.rewrite('/404');
  return null;
}
