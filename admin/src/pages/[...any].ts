import type { APIRoute } from 'astro';

// Catch-all: the same plain 404 as lock 1 produces for outside the prefix.
export const ALL: APIRoute = () =>
  new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
