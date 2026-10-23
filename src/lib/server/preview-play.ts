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

type PreviewFailureStage = 'connect' | 'admit' | 'resolve';

const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

function errorCode(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('code' in err)) return '';
  const code = err.code;
  return typeof code === 'string' ? code : '';
}

function sqlState(err: unknown): string {
  const code = errorCode(err);
  return /^[0-9A-Z]{5}$/.test(code) ? code : 'none';
}

function failureStage(attempt: 'admit' | 'resolve', err: unknown): PreviewFailureStage {
  const code = errorCode(err);
  if (code.startsWith('08') || CONNECT_CODES.has(code)) return 'connect';
  return attempt;
}

export async function openPreviewLink(input: {
  token: string;
  ip: string;
  now?: number;
  previewSecret?: string;
}): Promise<PreviewPlay> {
  const now = input.now ?? Date.now();
  let attempt: 'admit' | 'resolve' = 'admit';
  try {
    const admitted = await sql.begin((tx) => admitPreviewPage(tx, input.ip, now));
    if (!admitted) return { kind: 'limited' };
    attempt = 'resolve';
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
  } catch (err) {
    console.error(`preview play failed stage=${failureStage(attempt, err)} code=${sqlState(err)}`);
    return { kind: 'error' };
  }
}
