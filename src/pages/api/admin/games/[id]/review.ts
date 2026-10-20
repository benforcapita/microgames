import type { APIRoute } from 'astro';
import { parseReviewInput } from '../../../../../lib/admin-rules';
import { reviewGame } from '../../../../../lib/server/admin';
import { safeNext } from '../../../../../lib/server/auth';
import { isAdmin } from '../../../../../lib/server/profiles';

/** `next` may already carry a query (the admin table filters), so merge rather than append. */
function back(next: string, params: Record<string, string | undefined>): string {
  const u = new URL(next, 'https://next.invalid');
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.pathname + u.search + u.hash;
}

/** The human review (MR-1): approve → proving, reject (with a note) → rejected. Admins only. */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 });
  if (!isAdmin(locals.profile)) return new Response('Not found', { status: 404 });
  const form = await request.formData();
  const next = safeNext(String(form.get('next') ?? ''), '/admin');
  const { input, error } = parseReviewInput(form);
  if (!input) return redirect(back(next, { error }), 303);
  const result = await reviewGame(params.id ?? '', input);
  if (!result.ok) return redirect(back(next, { error: result.error }), 303);
  return redirect(back(next, { reviewed: params.id, to: result.to }), 303);
};
