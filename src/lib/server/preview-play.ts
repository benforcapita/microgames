import { mintPreviewToken } from '../../../cdn/preview-token.mjs';
import { admitPreviewPage } from './abuse';
import { CDN_PREVIEW_SECRET } from './config';
import { sql } from './db';

const PATH_RE = /^([^/]+)\/([1-9]\d*)\/index\.html$/;

export type PreviewPlay =
  | { kind: 'play'; gameId: string; title: string; previewToken: string }
  | { kind: 'miss' }
  | { kind: 'limited' }
  | { kind: 'error' };

interface ResolvedRow {
  html_path: string;
  title: string;
}

export async function openPreviewLink(input: { token: string; ip: string; now?: number }): Promise<PreviewPlay> {
  const now = input.now ?? Date.now();
  try {
    const admitted = await sql.begin((tx) => admitPreviewPage(tx, input.ip, now));
    if (!admitted) return { kind: 'limited' };
    const rows = await sql<ResolvedRow[]>`
      select html_path, title from public.resolve_preview_link(${input.token})`;
    const row = rows[0];
    if (!row) return { kind: 'miss' };
    const match = PATH_RE.exec(row.html_path);
    if (!match) return { kind: 'error' };
    const gameId = match[1];
    if (!gameId) return { kind: 'error' };
    const previewToken = mintPreviewToken(CDN_PREVIEW_SECRET, gameId);
    if (!previewToken) return { kind: 'error' };
    return { kind: 'play', gameId, title: row.title, previewToken };
  } catch {
    console.error('preview play failed');
    return { kind: 'error' };
  }
}
