#!/usr/bin/env node
/**
 * Draws every sprite and synthesizes every sound for the Temple Dash fixture.
 * Self-made art and audio only: pixel maps and oscillators written by hand here,
 * no third-party files, no network. Output goes to ../assets and ../thumb.png.
 *
 *   node e2e/fixtures/temple-run/tools/make-assets.mjs
 *
 * Only Node builtins are used (zlib for PNG deflate), so this runs anywhere the
 * repo's Node 22 runs. Re-running is deterministic: same bytes every time.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --out <dir> lets sibling fixtures (temple-run-multi) reuse this generator for their own copy.
const outAt = process.argv.indexOf('--out');
const ROOT = outAt >= 0 ? resolve(process.argv[outAt + 1]) : join(dirname(fileURLToPath(import.meta.url)), '..');
const SPRITES = join(ROOT, 'assets', 'sprites');
const AUDIO = join(ROOT, 'assets', 'audio');

/* ------------------------------------------------------------------ PNG */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** 8-bit RGBA PNG from a flat Uint8Array of w*h*4 bytes. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Tiny mutable image with the few drawing helpers the sprites need. */
function image(width, height) {
  const data = new Uint8Array(width * height * 4);
  const put = (x, y, [r, g, b, a = 255]) => {
    if (x < 0 || y < 0 || x >= width || y >= height || a === 0) return;
    const i = (y * width + x) * 4;
    if (a === 255) {
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      return;
    }
    const k = a / 255;
    data[i] = Math.round(data[i] * (1 - k) + r * k);
    data[i + 1] = Math.round(data[i + 1] * (1 - k) + g * k);
    data[i + 2] = Math.round(data[i + 2] * (1 - k) + b * k);
    data[i + 3] = Math.max(data[i + 3], a);
  };
  return {
    width,
    height,
    data,
    put,
    rect(x, y, w, h, colour) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, colour);
    },
    disc(cx, cy, r, colour) {
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(x, y, colour);
        }
      }
    },
    png: () => encodePng(width, height, data),
  };
}

/** Scales a pixel map (array of equal-length strings) by `scale` into a new image. */
function fromMap(map, palette, scale) {
  const w = map[0].length * scale;
  const h = map.length * scale;
  const img = image(w, h);
  map.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const colour = palette[ch];
      if (colour) img.rect(x * scale, y * scale, scale, scale, colour);
    });
  });
  return img;
}

const PAL = {
  k: [26, 20, 16],        // outline
  h: [150, 92, 38],       // hat / leather
  s: [232, 176, 122],     // skin
  b: [214, 78, 58],       // shirt
  p: [47, 75, 143],       // trousers
  o: [58, 42, 26],        // boots
  w: [245, 245, 240],     // highlight
  g: [120, 196, 74],      // jungle green
  t: [116, 104, 86],      // temple stone
  T: [84, 74, 60],        // temple stone shadow
  y: [255, 206, 61],      // gold
  Y: [255, 240, 170],     // gold highlight
  r: [168, 54, 44],       // dark red
  v: [86, 62, 120],       // vine shadow
};

/* --------------------------------------------------------------- sprites */

// 16 x 20 pixel maps, scaled 3x -> 48 x 60 sprites.
const RUN_A = [
  '.....kkkkkk.....',
  '....khhhhhhk....',
  '...khhhhhhhhk...',
  '....kssssssk....',
  '....ksksksk.....',
  '.....ksssk......',
  '....kkbbbkk.....',
  '...kbbbbbbbk....',
  '..kbsbbbbbbsk...',
  '..ksbbbbbbbbk...',
  '...kbbbbbbbk....',
  '....kppppk......',
  '....kppppk......',
  '...kppk.kppk....',
  '...kppk.kppk....',
  '..kppk...kppk...',
  '..kook...kook...',
  '.kook.....kook..',
  '.kkk.......kkk..',
  '................',
];
const RUN_B = [
  '.....kkkkkk.....',
  '....khhhhhhk....',
  '...khhhhhhhhk...',
  '....kssssssk....',
  '....ksksksk.....',
  '.....ksssk......',
  '....kkbbbkk.....',
  '...kbbbbbbbk....',
  '..ksbbbbbbbsk...',
  '...kbbbbbbbk....',
  '....kbbbbbk.....',
  '....kppppk......',
  '....kppppk......',
  '....kppppk......',
  '...kppkkppk.....',
  '...kpk...kpk....',
  '..kook....kok...',
  '..kook.....kook.',
  '..kkk.......kkk.',
  '................',
];
const JUMP = [
  '.....kkkkkk.....',
  '....khhhhhhk....',
  '...khhhhhhhhk...',
  '....kssssssk....',
  '....ksksksk.....',
  '.k...ksssk....k.',
  'ksk.kkbbbkk..ksk',
  'ksk.kbbbbbk.ksk.',
  '.kskkbbbbbkksk..',
  '..kssbbbbbssk...',
  '...kbbbbbbbk....',
  '....kppppk......',
  '...kppkkppk.....',
  '..kppk..kppk....',
  '..kpk....kpk....',
  '.kook....kook...',
  '.kkk......kkk...',
  '................',
  '................',
  '................',
];
// Sliding: wide and low, 20 x 12 scaled 3x -> 60 x 36.
const SLIDE = [
  '....................',
  '....................',
  '....................',
  '....................',
  '.........kkkkkkkk...',
  '......kkkbbbbbbbbk..',
  '...kkhhkbsbbbbbbbk..',
  '..khhhhksssbbbbbbk..',
  '..khhhksksksbbbbk...',
  '.kppppkkssskbbbk....',
  'kookppppppkkkkk.....',
  '.kkkkooookk.........',
];
const BLOCK = [
  'kkkkkkkkkkkkkkkk',
  'kttttttttttttttk',
  'kttwwttttwwttttk',
  'kttttttttttttttk',
  'kTTTTTTTTTTTTTTk',
  'kttttttttttttttk',
  'kttttwwttttwwttk',
  'kttttttttttttttk',
  'kTTTTTTTTTTTTTTk',
  'kttttttttttttttk',
  'kttwwttttwwttttk',
  'kttttttttttttttk',
  'kTTTTTTTTTTTTTTk',
  'kttttttttttttttk',
  'kttttttttttttttk',
  'kkkkkkkkkkkkkkkk',
];
// Overhead bar to slide under: 24 x 8 scaled 3x -> 72 x 24.
const BAR = [
  'kkkkkkkkkkkkkkkkkkkkkkkk',
  'krrrrrrrrrrrrrrrrrrrrrrk',
  'kryyyyyyyyyyyyyyyyyyyyrk',
  'krrrrrrrrrrrrrrrrrrrrrrk',
  'kkkvvkkkkkvvkkkkkvvkkkkk',
  '..kvvk...kvvk....kvvk...',
  '..kggk...kggk....kggk...',
  '...kk.....kk......kk....',
];
const COIN = [
  '....kkkk....',
  '..kkyyyykk..',
  '.kyyYYYYyyk.',
  'kyyYYwwYYyyk',
  'kyYYwwwwYYyk',
  'kyYYwwwwYYyk',
  'kyyYYwwYYyyk',
  'kyyYYYYYYyyk',
  '.kyyYYYYyyk.',
  '..kkyyyykk..',
  '....kkkk....',
  '............',
];
const TILE = [
  'TTTTTTTTTTTTTTTT',
  'TttttttTtttttttT',
  'TttttttTtttttttT',
  'TttttttTtttttttT',
  'TTTTTTTTTTTTTTTT',
  'TtttTttttttttttT',
  'TtttTttttttttttT',
  'TtttTttttttttttT',
  'TTTTTTTTTTTTTTTT',
  'TttttttttttTtttT',
  'TttttttttttTtttT',
  'TttttttttttTtttT',
  'TTTTTTTTTTTTTTTT',
  'TttTtttttttttttT',
  'TttTtttttttttttT',
  'TTTTTTTTTTTTTTTT',
];

const sprites = {
  'runner-run-a.png': fromMap(RUN_A, PAL, 3),
  'runner-run-b.png': fromMap(RUN_B, PAL, 3),
  'runner-jump.png': fromMap(JUMP, PAL, 3),
  'runner-slide.png': fromMap(SLIDE, PAL, 3),
  'obstacle-block.png': fromMap(BLOCK, PAL, 4),
  'obstacle-bar.png': fromMap(BAR, PAL, 3),
  'coin.png': fromMap(COIN, PAL, 3),
  'tile-stone.png': fromMap(TILE, PAL, 4),
};

/* ----------------------------------------------------------------- thumb */

/** 640 x 360 title card: temple corridor, a runner and some gold. */
function thumbnail() {
  const img = image(640, 360);
  for (let y = 0; y < 360; y++) {
    const k = y / 360;
    img.rect(0, y, 640, 1, [Math.round(24 + 40 * k), Math.round(20 + 52 * k), Math.round(18 + 28 * k)]);
  }
  // Corridor: two walls converging on a vanishing point.
  for (let y = 180; y < 360; y++) {
    const t = (y - 180) / 180;
    const half = Math.round(30 + t * 300);
    img.rect(320 - half, y, half * 2, 1, [Math.round(90 + 40 * t), Math.round(80 + 34 * t), Math.round(64 + 24 * t)]);
    img.rect(320 - half, y, 4, 1, PAL.T);
    img.rect(320 + half - 4, y, 4, 1, PAL.T);
    if ((y - 180) % 26 < 3) img.rect(320 - half, y, half * 2, 1, PAL.T);
    // Lane seams.
    img.rect(Math.round(320 - half / 3) - 2, y, 4, 1, [64, 56, 44]);
    img.rect(Math.round(320 + half / 3) - 2, y, 4, 1, [64, 56, 44]);
  }
  // Jungle canopy over the entrance.
  for (let x = 0; x < 640; x++) {
    const h = 40 + Math.round(26 * Math.sin(x / 37) + 18 * Math.sin(x / 11));
    img.rect(x, 0, 1, Math.max(8, h), PAL.g);
  }
  const blit = (src, dx, dy, scale = 1) => {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = (y * src.width + x) * 4;
        const colour = [src.data[i], src.data[i + 1], src.data[i + 2], src.data[i + 3]];
        if (colour[3] === 0) continue;
        for (let j = 0; j < scale; j++) for (let k = 0; k < scale; k++) img.put(dx + x * scale + k, dy + y * scale + j, colour);
      }
    }
  };
  blit(sprites['runner-run-a.png'], 272, 230, 2);
  blit(sprites['coin.png'], 150, 250, 2);
  blit(sprites['coin.png'], 440, 262, 2);
  blit(sprites['obstacle-block.png'], 108, 196, 1);
  blit(sprites['obstacle-bar.png'], 404, 192, 1);
  return img;
}

/* ----------------------------------------------------------------- audio */

const RATE = 11025;

/** 8-bit unsigned mono PCM WAV (small on purpose: every asset stays well under 100 KB). */
function encodeWav(samples) {
  const pcm = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(0, Math.min(255, Math.round(samples[i] * 127 + 128)));
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE, 28); // byte rate (1 byte per frame)
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const square = (phase, duty = 0.5) => (phase % 1 < duty ? 1 : -1);
const triangle = (phase) => 4 * Math.abs((phase % 1) - 0.5) - 1;
// Deterministic pseudo-noise so re-running the script produces identical bytes.
let noiseState = 0x2f6e2b1;
const noise = () => {
  noiseState ^= noiseState << 13;
  noiseState ^= noiseState >>> 17;
  noiseState ^= noiseState << 5;
  noiseState |= 0;
  return ((noiseState >>> 8) % 2000) / 1000 - 1;
};

const NOTE = (semitonesFromA4) => 440 * 2 ** (semitonesFromA4 / 12);
/** Scale degrees of an A minor pentatonic, as semitone offsets from A4. */
const N = { a2: -24, c3: -21, d3: -19, e3: -17, g3: -14, a3: -12, c4: -9, d4: -7, e4: -5, g4: -2, a4: 0, c5: 3, d5: 5, e5: 7 };

/** Four-bar chiptune loop: pentatonic lead, bass pulse, noise percussion. */
function musicLoop() {
  const bpm = 132;
  const beat = 60 / bpm;
  const bars = 4;
  const total = Math.round(bars * 4 * beat * RATE);
  const out = new Float32Array(total);

  const lead = [
    N.a4, N.c5, N.e5, N.d5, N.c5, N.a4, N.g4, N.a4,
    N.e4, N.g4, N.a4, N.c5, N.d5, N.c5, N.a4, N.g4,
  ];
  const bass = [N.a2, N.a2, N.g3 - 12, N.g3 - 12, N.c3, N.c3, N.e3, N.e3];

  const step = beat / 2; // eighth notes
  lead.forEach((semi, i) => {
    const start = Math.round(i * 2 * step * RATE);
    const length = Math.round(step * 1.7 * RATE);
    const freq = NOTE(semi);
    for (let s = 0; s < length && start + s < total; s++) {
      const t = s / RATE;
      const env = Math.min(1, t * 90) * Math.exp(-t * 5.5);
      out[start + s] += 0.32 * env * square((freq * t) % 1, 0.25);
    }
  });
  bass.forEach((semi, i) => {
    const start = Math.round(i * 2 * beat * RATE);
    const length = Math.round(beat * 1.8 * RATE);
    const freq = NOTE(semi);
    for (let s = 0; s < length && start + s < total; s++) {
      const t = s / RATE;
      const env = Math.min(1, t * 60) * Math.exp(-t * 2.2);
      out[start + s] += 0.34 * env * triangle(freq * t);
    }
  });
  for (let i = 0; i < bars * 8; i++) {
    const start = Math.round(i * step * RATE);
    const length = Math.round(0.07 * RATE);
    const accent = i % 4 === 2 ? 0.3 : 0.14;
    for (let s = 0; s < length && start + s < total; s++) {
      out[start + s] += accent * noise() * Math.exp(-(s / RATE) * 42);
    }
  }
  // Fade the first and last few milliseconds into each other so the loop has no click.
  const edge = Math.round(0.004 * RATE);
  for (let s = 0; s < edge; s++) {
    const k = s / edge;
    out[s] *= k;
    out[total - 1 - s] *= k;
  }
  return out;
}

function sfxCoin() {
  const length = Math.round(0.26 * RATE);
  const out = new Float32Array(length);
  for (let s = 0; s < length; s++) {
    const t = s / RATE;
    const freq = t < 0.06 ? NOTE(N.e5) : NOTE(N.e5 + 5);
    out[s] = 0.55 * Math.exp(-t * 11) * square(freq * t, 0.5);
  }
  return out;
}

function sfxJump() {
  const length = Math.round(0.22 * RATE);
  const out = new Float32Array(length);
  let phase = 0;
  for (let s = 0; s < length; s++) {
    const t = s / RATE;
    phase += (NOTE(N.a3) + 900 * t) / RATE;
    out[s] = 0.5 * Math.exp(-t * 9) * square(phase, 0.35);
  }
  return out;
}

function sfxHit() {
  const length = Math.round(0.42 * RATE);
  const out = new Float32Array(length);
  let phase = 0;
  for (let s = 0; s < length; s++) {
    const t = s / RATE;
    phase += Math.max(40, NOTE(N.a3) - 420 * t) / RATE;
    out[s] = Math.exp(-t * 6) * (0.42 * triangle(phase) + 0.32 * noise());
  }
  return out;
}

/* ------------------------------------------------------------------ main */

mkdirSync(SPRITES, { recursive: true });
mkdirSync(AUDIO, { recursive: true });

const written = [];
const save = (path, bytes) => {
  writeFileSync(path, bytes);
  written.push([path.slice(ROOT.length + 1), bytes.length]);
};

for (const [name, img] of Object.entries(sprites)) save(join(SPRITES, name), img.png());
save(join(ROOT, 'thumb.png'), thumbnail().png());
save(join(AUDIO, 'music-loop.wav'), encodeWav(musicLoop()));
save(join(AUDIO, 'sfx-coin.wav'), encodeWav(sfxCoin()));
save(join(AUDIO, 'sfx-jump.wav'), encodeWav(sfxJump()));
save(join(AUDIO, 'sfx-hit.wav'), encodeWav(sfxHit()));

const limit = 100 * 1024;
const over = written.filter(([, size]) => size >= limit);
for (const [name, size] of written) console.log(`${String(size).padStart(7)}  ${name}`);
if (over.length) {
  console.error(`assets over 100 KB: ${over.map(([name]) => name).join(', ')}`);
  process.exit(1);
}
