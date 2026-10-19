import type { APIRoute } from 'astro';

// The one stylesheet, served by an SSR route under the prefix — no static
// assets exist in this package (LLD §1).
const CSS = `body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #111418;
  color: #e6e8eb;
}
main {
  max-width: 42rem;
  margin: 4rem auto;
  padding: 0 1rem;
}
h1 {
  font-size: 1.4rem;
}
form {
  margin-top: 2rem;
}
button {
  font: inherit;
  padding: 0.5rem 1rem;
}
label, input {
  display: block;
}
input {
  margin: 0.25rem 0 1rem;
  padding: 0.4rem;
  font: inherit;
  max-width: 24rem;
}
p.error {
  color: #ffb4a8;
}
img.qr {
  width: 12rem;
  height: auto;
  background: #fff;
  padding: 0.5rem;
}
code {
  font-family: ui-monospace, monospace;
}
`;

export const GET: APIRoute = () =>
  new Response(CSS, { headers: { 'content-type': 'text/css; charset=utf-8' } });
