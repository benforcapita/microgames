// Cookieless origin for user-submitted game bundles (local / Node). Logic lives in cdn/handler.mjs,
// which is also deployed as its own Vercel project (cdn/) so it gets a separate origin in production.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (fs.existsSync(path.join(root, '.env')) && !process.env.PUBLIC_SUPABASE_URL) process.loadEnvFile(path.join(root, '.env'));

const PORT = Number(process.env.MG_CDN_PORT ?? 4322);
const { handle } = await import('../cdn/handler.mjs');
http.createServer(handle).listen(PORT, () => console.log(`[game-cdn] serving Supabase bucket "games" on http://localhost:${PORT}`));
