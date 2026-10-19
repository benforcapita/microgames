import type { APIRoute } from 'astro';
import { CSRF_FIELD } from '../../lib/csrf';

// Placeholder page: middleware guarantees valid config, authenticated basic
// auth and a CSRF field bound to this request's cookie in locals.
export const GET: APIRoute = (context) => {
  const field = context.locals.csrfField ?? '';
  const cssHref = context.url.pathname.replace(/\/?$/, '/admin.css');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Meshgrounds admin</title>
<link rel="stylesheet" href="${cssHref}">
</head>
<body>
<main>
<h1>Meshgrounds admin</h1>
<p>Placeholder. Nothing here yet.</p>
<form method="post" action="">
<input type="hidden" name="${CSRF_FIELD}" value="${field}">
<button type="submit">No-op</button>
</form>
</main>
</body>
</html>
`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
};

// Placeholder POST target so the CSRF contract is exercisable end to end.
export const POST: APIRoute = (context) =>
  new Response(null, { status: 303, headers: { location: context.url.pathname } });
