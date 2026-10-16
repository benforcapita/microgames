import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sniffAsset, type SniffedFormat } from './asset-sniff.ts';

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function withMagic(magic: number[], extra = 0): Uint8Array {
  const bytes = new Uint8Array(magic.length + extra);
  bytes.set(magic);
  return bytes;
}

const SAMPLES: { format: SniffedFormat; expectedType: string; contentType: string; bytes: Uint8Array }[] = [
  { format: 'png', expectedType: 'image', contentType: 'image/png', bytes: withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { format: 'jpeg', expectedType: 'image', contentType: 'image/jpeg', bytes: withMagic([0xff, 0xd8, 0xff, 0xe0]) },
  { format: 'gif', expectedType: 'image', contentType: 'image/gif', bytes: bytesOf('GIF89a') },
  { format: 'webp', expectedType: 'image', contentType: 'image/webp', bytes: bytesOf('RIFF\x00\x00\x00\x00WEBP') },
  { format: 'wav', expectedType: 'audio', contentType: 'audio/wav', bytes: bytesOf('RIFF\x00\x00\x00\x00WAVE') },
  { format: 'ogg', expectedType: 'audio', contentType: 'audio/ogg', bytes: bytesOf('OggS') },
  { format: 'mp3', expectedType: 'audio', contentType: 'audio/mpeg', bytes: bytesOf('ID3') },
  { format: 'woff', expectedType: 'font', contentType: 'font/woff', bytes: bytesOf('wOFF') },
  { format: 'woff2', expectedType: 'font', contentType: 'font/woff2', bytes: bytesOf('wOF2') },
  { format: 'ttf', expectedType: 'font', contentType: 'font/ttf', bytes: withMagic([0x00, 0x01, 0x00, 0x00]) },
  { format: 'otf', expectedType: 'font', contentType: 'font/otf', bytes: bytesOf('OTTO') },
  { format: 'json', expectedType: 'json', contentType: 'application/json', bytes: bytesOf('{"ok":true}') },
  { format: 'text', expectedType: 'text', contentType: 'text/plain; charset=utf-8', bytes: bytesOf('hello') },
];

describe('asset sniffing', () => {
  for (const sample of SAMPLES) {
    it(`accepts ${sample.format} from its bytes`, () => {
      const sniffed = sniffAsset(sample.bytes);
      assert.equal(sniffed.ok, true);
      if (!sniffed.ok) return;
      assert.equal(sniffed.format, sample.format);
      assert.equal(sniffed.expectedType, sample.expectedType);
      assert.equal(sniffed.contentType, sample.contentType);
    });
  }

  it('accepts an MPEG frame as mp3 and GIF87a as gif', () => {
    const frame = sniffAsset(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]));
    assert.equal(frame.ok && frame.format, 'mp3');
    const gif = sniffAsset(bytesOf('GIF87a'));
    assert.equal(gif.ok && gif.format, 'gif');
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

  it('does not treat a real PNG as SVG just because the name or a later comment says svg', () => {
    const bytes = withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 16);
    bytes.set(bytesOf('<svg'), 8);
    const sniffed = sniffAsset(bytes);
    assert.equal(sniffed.ok && sniffed.format, 'png');
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
