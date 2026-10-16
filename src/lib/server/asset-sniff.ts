/**
 * Identifies an uploaded asset from its bytes.
 * The browser's Content-Type is ignored. SVG and HTML documents are never accepted.
 * PNG, JPEG, and GIF must end at their format trailer so trailing bytes cannot ride along.
 */
import type { ExpectedType } from './asset-scan.ts';

export type SniffedFormat =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'avif'
  | 'ico'
  | 'mp3'
  | 'ogg'
  | 'wav'
  | 'm4a'
  | 'aac'
  | 'flac'
  | 'weba'
  | 'woff'
  | 'woff2'
  | 'ttf'
  | 'otf'
  | 'wasm'
  | 'json'
  | 'text';

export type SniffRejection = 'empty' | 'svg' | 'html' | 'unknown' | 'trailing';

export type SniffResult =
  | { ok: true; format: SniffedFormat; expectedType: ExpectedType | 'wasm'; contentType: string }
  | { ok: false; reason: SniffRejection };

const CONTENT_TYPE: Record<SniffedFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  weba: 'audio/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  json: 'application/json',
  text: 'text/plain; charset=utf-8',
};

const EXPECTED: Record<SniffedFormat, ExpectedType | 'wasm'> = {
  png: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  ico: 'image',
  mp3: 'audio',
  ogg: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  weba: 'audio',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  wasm: 'wasm',
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

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function accept(format: SniffedFormat): SniffResult {
  return { ok: true, format, expectedType: EXPECTED[format], contentType: CONTENT_TYPE[format] };
}

/** Case-insensitive `<script` or `<html` anywhere in the bytes. */
export function containsHtmlMarker(bytes: Uint8Array): boolean {
  const script = [0x73, 0x63, 0x72, 0x69, 0x70, 0x74];
  const html = [0x68, 0x74, 0x6d, 0x6c];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x3c) continue;
    if (matchesLower(bytes, i + 1, script) || matchesLower(bytes, i + 1, html)) return true;
  }
  return false;
}

function matchesLower(bytes: Uint8Array, offset: number, ascii: readonly number[]): boolean {
  if (offset + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    let c = bytes[offset + i];
    if (c >= 65 && c <= 90) c += 32;
    if (c !== ascii[i]) return false;
  }
  return true;
}

function binaryOrMarker(format: SniffedFormat, bytes: Uint8Array): SniffResult {
  if (containsHtmlMarker(bytes)) return { ok: false, reason: 'html' };
  return accept(format);
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

function isAdts(bytes: Uint8Array): boolean {
  if (bytes.length < 2 || bytes[0] !== 0xff) return false;
  return (bytes[1] & 0xf6) === 0xf0;
}

function brandAt(bytes: Uint8Array, offset: number): string {
  if (bytes.length < offset + 4) return '';
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function ftypBrands(bytes: Uint8Array): string[] {
  if (!has(bytes, 4, 'ftyp')) return [];
  const box = u32(bytes, 0);
  const end = Math.min(bytes.length, box > 0 ? box : bytes.length);
  const brands: string[] = [];
  for (let i = 8; i + 4 <= end; i += 4) brands.push(brandAt(bytes, i));
  return brands;
}

function isAvif(bytes: Uint8Array): boolean {
  return ftypBrands(bytes).some((brand) => brand === 'avif' || brand === 'avis');
}

function isM4a(bytes: Uint8Array): boolean {
  return ftypBrands(bytes).some((brand) => brand === 'M4A ' || brand === 'M4B ');
}

function isWeba(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) return false;
  const head = bytes.subarray(0, Math.min(bytes.length, 64));
  return has(head, 0, 'webm') || latinIncludes(head, 'webm');
}

function latinIncludes(bytes: Uint8Array, text: string): boolean {
  const limit = bytes.length - text.length;
  for (let i = 0; i <= limit; i++) {
    if (has(bytes, i, text)) return true;
  }
  return false;
}

/** True when every chunk parses and the file ends on IEND. */
function pngEndsClean(bytes: Uint8Array): boolean {
  if (!has(bytes, 0, '\x89PNG\r\n\x1a\n')) return false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = u32(bytes, offset);
    const next = offset + 12 + length;
    if (next > bytes.length) return false;
    const type = brandAt(bytes, offset + 4);
    offset = next;
    if (type === 'IEND') return offset === bytes.length;
  }
  return false;
}

function jpegEndsClean(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

function skipSubBlocks(bytes: Uint8Array, offset: number): number | null {
  while (offset < bytes.length) {
    const len = bytes[offset];
    offset += 1;
    if (len === 0) return offset;
    offset += len;
    if (offset > bytes.length) return null;
  }
  return null;
}

/** True when the GIF trailer is the last byte and the blocks before it parse. */
function gifEndsClean(bytes: Uint8Array): boolean {
  if (bytes.length < 14 || !(has(bytes, 0, 'GIF87a') || has(bytes, 0, 'GIF89a'))) return false;
  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * (1 << ((bytes[10] & 7) + 1));
  if (offset > bytes.length) return false;
  while (offset < bytes.length) {
    const sep = bytes[offset];
    offset += 1;
    if (sep === 0x3b) return offset === bytes.length;
    if (sep === 0x21) {
      if (offset >= bytes.length) return false;
      offset += 1;
      const next = skipSubBlocks(bytes, offset);
      if (next === null) return false;
      offset = next;
      continue;
    }
    if (sep === 0x2c) {
      if (offset + 9 > bytes.length) return false;
      const packed = bytes[offset + 8];
      offset += 9;
      if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
      if (offset >= bytes.length) return false;
      offset += 1;
      const next = skipSubBlocks(bytes, offset);
      if (next === null) return false;
      offset = next;
      continue;
    }
    return false;
  }
  return false;
}

function binaryFormat(bytes: Uint8Array): SniffedFormat | 'trailing' | null {
  if (has(bytes, 0, '\x89PNG\r\n\x1a\n')) return pngEndsClean(bytes) ? 'png' : 'trailing';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return jpegEndsClean(bytes) ? 'jpeg' : 'trailing';
  }
  if (has(bytes, 0, 'GIF87a') || has(bytes, 0, 'GIF89a')) return gifEndsClean(bytes) ? 'gif' : 'trailing';
  if (has(bytes, 0, 'RIFF') && has(bytes, 8, 'WEBP')) return 'webp';
  if (has(bytes, 0, 'RIFF') && has(bytes, 8, 'WAVE')) return 'wav';
  if (has(bytes, 0, 'OggS')) return 'ogg';
  if (isMp3(bytes)) return 'mp3';
  if (isAdts(bytes)) return 'aac';
  if (has(bytes, 0, 'fLaC')) return 'flac';
  if (isAvif(bytes)) return 'avif';
  if (isM4a(bytes)) return 'm4a';
  if (isWeba(bytes)) return 'weba';
  if (bytes.length >= 6 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'ico';
  if (has(bytes, 0, 'wOFF')) return 'woff';
  if (has(bytes, 0, 'wOF2')) return 'woff2';
  if (has(bytes, 0, 'OTTO')) return 'otf';
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) return 'wasm';
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

export function markupKind(text: string): 'html' | 'svg' | null {
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

/** Sniff the real type. SVG, HTML, and trailing bytes after a PNG, JPEG, or GIF trailer fail closed. */
export function sniffAsset(bytes: Uint8Array): SniffResult {
  if (bytes.byteLength === 0) return { ok: false, reason: 'empty' };
  const binary = binaryFormat(bytes);
  if (binary === 'trailing') {
    return { ok: false, reason: containsHtmlMarker(bytes) ? 'html' : 'trailing' };
  }
  if (binary) return binaryOrMarker(binary, bytes);

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
