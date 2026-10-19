import type { APIRoute } from 'astro';
import source from '../../../mcp/meshground-mcp.mjs?raw';
import { siteOrigin } from '../../lib/server/api-v1';

/** MCP-1: the stdio MCP server, with this site baked in as its default MESHGROUND_URL. */
export const GET: APIRoute = ({ url }) =>
  new Response(source.replace("'__MESHGROUND_URL__'", JSON.stringify(siteOrigin(url))), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Disposition': 'attachment; filename="meshground-mcp.mjs"',
      'Cache-Control': 'public, max-age=300',
    },
  });
