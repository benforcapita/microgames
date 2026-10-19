import type { APIRoute } from 'astro';

export const GET: APIRoute = () =>
  new Response('User-agent: *\nDisallow: /\n', {
    headers: { 'content-type': 'text/plain' },
  });
