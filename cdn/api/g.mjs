// Vercel entry for the game CDN (project root: cdn/). vercel.json rewrites /g/<id>/<file> here as ?__p=<id>/<file>.
import { handle } from '../handler.mjs';

export default function (req, res) {
  const url = new URL(req.url ?? '/', 'http://cdn');
  const p = url.searchParams.get('__p');
  if (p !== null) {
    url.searchParams.delete('__p');
    req.url = `/g/${p}${url.search}`;
  }
  return handle(req, res);
}
