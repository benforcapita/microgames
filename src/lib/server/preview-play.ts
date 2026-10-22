import { mintPreviewToken } from '../../../cdn/preview-token.mjs';
import { admitPreviewPage } from './abuse';
import { CDN_PREVIEW_SECRET } from './config';
import { sql } from './db';

const PATH_RE = /^([^/]+)\/([1-9]\d*)\/index\.html$/;

export type PreviewPlay =
  | { kind: 'play'; gameId: string; title: string; version: number; previewToken: string }
  | { kind: 'miss' }
  | { kind: 'limited' }
  | { kind: 'error' };

interface ResolvedRow {
  html_path: string;
  title: string;
}

export async function openPreviewLink(input: {
  token: string;
  ip: string;
  now?: number;
  previewSecret?: string;
}): Promise<PreviewPlay> {
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
    const version = Number(match[2]);
    if (!gameId || !Number.isSafeInteger(version) || version < 1) return { kind: 'error' };
    const previewToken = mintPreviewToken(input.previewSecret ?? CDN_PREVIEW_SECRET, gameId, { version });
    if (!previewToken) return { kind: 'miss' };
    return { kind: 'play', gameId, title: row.title, version, previewToken };
  } catch {
    console.error('preview play failed');
    return { kind: 'error' };
  }
}
