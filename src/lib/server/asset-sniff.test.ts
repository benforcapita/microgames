import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sniffAsset, type SniffedFormat } from './asset-sniff.ts';

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(bytesOf(type), 4);
  out.set(data, 8);
  return out;
}

function png(extra?: Uint8Array, trailing?: Uint8Array): Uint8Array {
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk('IHDR', Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
  const parts = [sig, ihdr];
  if (extra && extra.byteLength) parts.push(chunk('tEXt', extra));
  parts.push(chunk('IEND', new Uint8Array()));
  if (trailing && trailing.byteLength) parts.push(trailing);
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function gif(version: 'GIF87a' | 'GIF89a'): Uint8Array {
  const bytes = new Uint8Array(14);
  bytes.set(bytesOf(version));
  bytes[6] = 1;
  bytes[8] = 1;
  bytes[13] = 0x3b;
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** JPEG marker whose 2-byte length includes those length bytes. */
function jpegMarker(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  out[0] = 0xff;
  out[1] = type;
  const length = payload.byteLength + 2;
  out[2] = length >> 8;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}

function ftyp(brand: string): Uint8Array {
  const body = bytesOf(brand);
  const size = 8 + body.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(bytesOf('ftyp'), 4);
  out.set(body, 8);
  return out;
}

const SAMPLES: { format: SniffedFormat; expectedType: string; contentType: string; bytes: Uint8Array }[] = [
  { format: 'png', expectedType: 'image', contentType: 'image/png', bytes: png() },
  { format: 'jpeg', expectedType: 'image', contentType: 'image/jpeg', bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) },
  { format: 'gif', expectedType: 'image', contentType: 'image/gif', bytes: gif('GIF89a') },
  { format: 'webp', expectedType: 'image', contentType: 'image/webp', bytes: bytesOf('RIFF\x00\x00\x00\x00WEBP') },
  { format: 'avif', expectedType: 'image', contentType: 'image/avif', bytes: ftyp('avif') },
  { format: 'ico', expectedType: 'image', contentType: 'image/x-icon', bytes: Uint8Array.from([0, 0, 1, 0, 1, 0]) },
  { format: 'wav', expectedType: 'audio', contentType: 'audio/wav', bytes: bytesOf('RIFF\x00\x00\x00\x00WAVE') },
  { format: 'ogg', expectedType: 'audio', contentType: 'audio/ogg', bytes: bytesOf('OggS') },
  { format: 'mp3', expectedType: 'audio', contentType: 'audio/mpeg', bytes: bytesOf('ID3') },
  { format: 'm4a', expectedType: 'audio', contentType: 'audio/mp4', bytes: ftyp('M4A ') },
  { format: 'aac', expectedType: 'audio', contentType: 'audio/aac', bytes: Uint8Array.from([0xff, 0xf1, 0x50, 0x80]) },
  { format: 'flac', expectedType: 'audio', contentType: 'audio/flac', bytes: bytesOf('fLaC') },
  { format: 'weba', expectedType: 'audio', contentType: 'audio/webm', bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...bytesOf('webm')]) },
  { format: 'woff', expectedType: 'font', contentType: 'font/woff', bytes: bytesOf('wOFF') },
  { format: 'woff2', expectedType: 'font', contentType: 'font/woff2', bytes: bytesOf('wOF2') },
  { format: 'ttf', expectedType: 'font', contentType: 'font/ttf', bytes: Uint8Array.from([0x00, 0x01, 0x00, 0x00]) },
  { format: 'otf', expectedType: 'font', contentType: 'font/otf', bytes: bytesOf('OTTO') },
  { format: 'wasm', expectedType: 'wasm', contentType: 'application/wasm', bytes: Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]) },
  { format: 'json', expectedType: 'json', contentType: 'application/json', bytes: bytesOf('{"ok":true}') },
  { format: 'text', expectedType: 'text', contentType: 'text/plain; charset=utf-8', bytes: bytesOf('hello') },
];

describe('asset sniffing', () => {
  for (const sample of SAMPLES) {
    it(`accepts ${sample.format} from its bytes`, () => {
      const sniffed = sniffAsset(sample.bytes);
      assert.equal(sniffed.ok, true, sample.format);
      if (!sniffed.ok) return;
      assert.equal(sniffed.format, sample.format);
      assert.equal(sniffed.expectedType, sample.expectedType);
      assert.equal(sniffed.contentType, sample.contentType);
    });
  }

  it('accepts an MPEG frame as mp3 and GIF87a as gif', () => {
    const frame = sniffAsset(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]));
    assert.equal(frame.ok && frame.format, 'mp3');
    const oldGif = sniffAsset(gif('GIF87a'));
    assert.equal(oldGif.ok && oldGif.format, 'gif');
  });

  it('rejects SVG and HTML even when the name would have been an image or text', () => {
    for (const body of [
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<?xml version="1.0"?><svg></svg>',
      '<!DOCTYPE html><html></html>',
      '<html><body>hi</body></html>',
      '  \n<script>alert(1)</script>',
    ]) {
      const sniffed = sniffAsset(bytesOf(body));
      assert.equal(sniffed.ok, false);
      if (sniffed.ok) return;
      assert.ok(sniffed.reason === 'svg' || sniffed.reason === 'html');
    }
  });

  it('keeps a real PNG that mentions svg inside a chunk', () => {
    const sniffed = sniffAsset(png(bytesOf('comment svg')));
    assert.equal(sniffed.ok && sniffed.format, 'png');
  });

  it('rejects a PNG with <html><script> appended after IEND', () => {
    const sniffed = sniffAsset(png(undefined, bytesOf('<html><script>alert(1)</script>')));
    assert.equal(sniffed.ok, false);
    if (sniffed.ok) return;
    assert.equal(sniffed.reason, 'html');
  });

  it('accepts a JPEG with EXIF and a comment, including FF bytes inside those segments', () => {
    const jpeg = concat(
      Uint8Array.from([0xff, 0xd8]),
      jpegMarker(0xe1, concat(bytesOf('Exif\0\0'), Uint8Array.from([0xff, 0xd9, 0x00]))),
      jpegMarker(0xfe, Uint8Array.from([0x68, 0x69, 0xff, 0xd9])),
      jpegMarker(0xda, Uint8Array.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
      Uint8Array.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
      Uint8Array.from([0xff, 0xd9]),
    );
    const sniffed = sniffAsset(jpeg);
    assert.equal(sniffed.ok && sniffed.format, 'jpeg');
  });

  it('rejects a JPEG with a ZIP appended and a second EOI at the end', () => {
    const jpeg = concat(
      Uint8Array.from([0xff, 0xd8]),
      jpegMarker(0xe1, bytesOf('Exif\0\0')),
      Uint8Array.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
      Uint8Array.from([0xff, 0x00, 0xff, 0xd7]),
      Uint8Array.from([0xff, 0xd9]),
    );
    const polyglot = concat(jpeg, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), Uint8Array.from([0xff, 0xd9]));
    const sniffed = sniffAsset(polyglot);
    assert.equal(sniffed.ok, false);
    if (!sniffed.ok) assert.equal(sniffed.reason, 'trailing');
    assert.equal(polyglot[polyglot.length - 2], 0xff);
    assert.equal(polyglot[polyglot.length - 1], 0xd9);
  });

  it('rejects trailing bytes after PNG IEND, JPEG EOI, and the GIF trailer', () => {
    for (const bytes of [
      png(undefined, bytesOf('XYZ')),
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0x00]),
      Uint8Array.from([...gif('GIF89a'), 0x00]),
    ]) {
      const sniffed = sniffAsset(bytes);
      assert.equal(sniffed.ok, false);
      if (!sniffed.ok) assert.equal(sniffed.reason, 'trailing');
    }
  });

  it('rejects an otherwise valid PNG that hides <html or <script in a chunk', () => {
    for (const marker of ['<html', '<ScRiPt', '<HTML']) {
      const sniffed = sniffAsset(png(bytesOf(marker)));
      assert.equal(sniffed.ok, false, marker);
      if (!sniffed.ok) assert.equal(sniffed.reason, 'html');
    }
  });

  it('rejects an empty file and bytes that are not an allowed type', () => {
    assert.deepEqual(sniffAsset(new Uint8Array()), { ok: false, reason: 'empty' });
    const unknown = sniffAsset(Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
    assert.equal(unknown.ok, false);
  });

  it('keeps ordinary prose as text, including a mention of svg', () => {
    const sniffed = sniffAsset(bytesOf('see the svg format later'));
    assert.equal(sniffed.ok && sniffed.format, 'text');
  });
});
