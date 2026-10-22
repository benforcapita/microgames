// Vercel entry for the game CDN (project root: cdn/). vercel.json rewrites /g/<id>/<file> here as ?__p=<id>/<file>.
import { handle } from '../handler.mjs';

export function rewriteGameUrl(reqUrl) {
  const url = new URL(reqUrl ?? '/', 'http://cdn');
  const p = url.searchParams.get('__p');
  if (p === null) return String(reqUrl ?? '/');
  url.searchParams.delete('__p');
  return `/g/${p}${url.search}`;
}

export default function (req, res) {
  req.url = rewriteGameUrl(req.url);
  return handle(req, res);
}
