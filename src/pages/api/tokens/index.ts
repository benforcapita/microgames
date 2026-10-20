import type { APIRoute } from 'astro';
import { createApiToken } from '../../../lib/server/api-tokens';

/** Creates a personal API token for the MCP server. The plaintext is in this response only. */
export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.user || !locals.profile) return Response.json({ error: 'Log in and pick a handle first.' }, { status: 401 });
  const form = await request.formData().catch(() => null);
  const result = await createApiToken(locals.user.id, form?.get('name'));
  if ('error' in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json(
    { token: result.token, id: result.summary.id, name: result.summary.name, prefix: result.summary.prefix },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
};
