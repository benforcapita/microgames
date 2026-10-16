/**
 * Identifies an uploaded asset from its bytes.
 * The browser's Content-Type is ignored. SVG and HTML are never accepted.
 */
import type { ExpectedType } from './asset-scan.ts';

export type SniffedFormat =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'mp3'
  | 'ogg'
  | 'wav'
  | 'woff'
  | 'woff2'
  | 'ttf'
  | 'otf'
  | 'json'
  | 'text';

export type SniffRejection = 'empty' | 'svg' | 'html' | 'unknown';

export type SniffResult =
  | { ok: true; format: SniffedFormat; expectedType: ExpectedType; contentType: string }
  | { ok: false; reason: SniffRejection };

const CONTENT_TYPE: Record<SniffedFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  json: 'application/json',
  text: 'text/plain; charset=utf-8',
};

const EXPECTED: Record<SniffedFormat, ExpectedType> = {
  png: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  mp3: 'audio',
  ogg: 'audio',
  wav: 'audio',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  json: 'json',
  text: 'text',
};

function has(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function accept(format: SniffedFormat): SniffResult {
  return { ok: true, format, expectedType: EXPECTED[format], contentType: CONTENT_TYPE[format] };
}

/** MPEG frame sync with a non-reserved version, layer, bitrate, and sample rate. */
function isMp3(bytes: Uint8Array): boolean {
  if (has(bytes, 0, 'ID3')) return true;
  if (bytes.length < 3 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return false;
  const version = (bytes[1] >> 3) & 0x03;
  const layer = (bytes[1] >> 1) & 0x03;
  const bitrate = (bytes[2] >> 4) & 0x0f;
  const sample = (bytes[2] >> 2) & 0x03;
  if (version === 1 || layer === 0 || bitrate === 0 || bitrate === 0x0f || sample === 3) return false;
  return true;
}

function binaryFormat(bytes: Uint8Array): SniffedFormat | null {
  if (has(bytes, 0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (has(bytes, 0, 'GIF87a') || has(bytes, 0, 'GIF89a')) return 'gif';
  if (has(bytes, 0, 'RIFF') && has(bytes, 8, 'WEBP')) return 'webp';
  if (has(bytes, 0, 'RIFF') && has(bytes, 8, 'WAVE')) return 'wav';
  if (has(bytes, 0, 'OggS')) return 'ogg';
  if (isMp3(bytes)) return 'mp3';
  if (has(bytes, 0, 'wOFF')) return 'woff';
  if (has(bytes, 0, 'wOF2')) return 'woff2';
  if (has(bytes, 0, 'OTTO')) return 'otf';
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) ||
      has(bytes, 0, 'true') ||
      has(bytes, 0, 'typ1'))
  ) {
    return 'ttf';
  }
  return null;
}

function markupKind(text: string): 'html' | 'svg' | null {
  const head = text.slice(0, 512).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body') ||
    head.startsWith('<script')
  ) {
    return 'html';
  }
  if (head.startsWith('<svg') || head.startsWith('<!doctype svg')) return 'svg';
  if (head.startsWith('<?xml') && head.includes('<svg')) return 'svg';
  return null;
}

function asJson(text: string): boolean {
  const start = text.trimStart()[0];
  if (!start || !'{["tfn-0123456789'.includes(start)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Sniff the real type. SVG and HTML fail closed, including when the name says otherwise. */
export function sniffAsset(bytes: Uint8Array): SniffResult {
  if (bytes.byteLength === 0) return { ok: false, reason: 'empty' };
  const binary = binaryFormat(bytes);
  if (binary) return accept(binary);

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'unknown' };
  }
  if (text.includes('\u0000')) return { ok: false, reason: 'unknown' };
  const markup = markupKind(text);
  if (markup) return { ok: false, reason: markup };
  if (asJson(text)) return accept('json');
  return accept('text');
}
