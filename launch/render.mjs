// Renders the launch film: synthesizes the soundtrack, captures launch/video.html frame by frame, muxes an MP4.
//   node launch/render.mjs                 → launch/out/meshground-launch.mp4 (1920×1080, 30 fps)
//   node launch/render.mjs --stills 3,9.5  → launch/out/still-<t>.png only (quick visual check)
//   node launch/render.mjs --audio         → launch/out/soundtrack.wav only
// Needs ffmpeg on PATH and Playwright's Chromium (npx playwright install chromium).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const FPS = 30, DURATION = 46, SR = 44100;

/* ------------------------------------------------------------------ soundtrack (120 bpm, A minor) */
function soundtrack() {
  const N = SR * DURATION;
  const bus = () => new Float32Array(N);
  const chip = bus(), lead = bus(), pad = bus(), bass = bus(), drums = bus(), fx = bus();
  const midi = (m) => 440 * 2 ** ((m - 69) / 12);
  let seed = 7;
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1;
  const wave = (type, p, duty = 0.5) => {
    p -= Math.floor(p);
    if (type === 'square') return p < duty ? 1 : -1;
    if (type === 'tri') return 4 * Math.abs(p - 0.5) - 1;
    if (type === 'saw') return 2 * p - 1;
    return Math.sin(2 * Math.PI * p);
  };
  /** One note into `buf`: ADSR, optional detuned voices, one-pole lowpass with a cutoff sweep. */
  function note(buf, t, dur, freq, o = {}) {
    const { type = 'square', vol = 0.2, a = 0.004, d = 0.08, s = 0.6, r = 0.06, duty = 0.5, voices = 1, detune = 0.008, cutoff = 0, cutoffEnd = cutoff } = o;
    const i0 = Math.floor(t * SR), len = Math.floor((dur + r) * SR);
    const phases = Array.from({ length: voices }, (_, v) => v / voices);
    let y = 0;
    for (let i = 0; i < len && i0 + i < N; i++) {
      const tt = i / SR;
      const env = tt < a ? tt / a : tt < a + d ? 1 - (1 - s) * ((tt - a) / d) : tt < dur ? s : s * Math.max(0, 1 - (tt - dur) / r);
      let x = 0;
      for (let v = 0; v < voices; v++) {
        const f = freq * (1 + (voices > 1 ? (v / (voices - 1) - 0.5) * 2 * detune : 0));
        phases[v] += f / SR; x += wave(type, phases[v], duty);
      }
      x /= Math.sqrt(voices);
      if (cutoff) { const fc = cutoff + (cutoffEnd - cutoff) * Math.min(1, tt / dur); y += (1 - Math.exp((-2 * Math.PI * fc) / SR)) * (x - y); x = y; }
      if (i0 + i >= 0) buf[i0 + i] += x * env * vol;
    }
  }
  const kick = (buf, t, vol = 0.9, square = false) => {
    let p = 0;
    for (let i = 0; i < 0.35 * SR; i++) {
      const tt = i / SR, f = 45 + 110 * Math.exp(-tt * 28);
      p += f / SR;
      const k = Math.floor(t * SR) + i; if (k < N) buf[k] += (square ? wave('square', p) * 0.5 : Math.sin(2 * Math.PI * p)) * Math.exp(-tt * 9) * vol;
    }
  };
  const snare = (buf, t, vol = 0.5) => {
    let y = 0;
    for (let i = 0; i < 0.22 * SR; i++) {
      const tt = i / SR, n = noise(); y += 0.35 * (n - y);
      const k = Math.floor(t * SR) + i; if (k < N) buf[k] += ((n - y) * Math.exp(-tt * 16) + Math.sin(2 * Math.PI * 185 * tt) * Math.exp(-tt * 30) * 0.6) * vol;
    }
  };
  const hat = (buf, t, vol = 0.18, len = 0.05) => {
    let y = 0;
    for (let i = 0; i < len * SR; i++) {
      const n = noise(); y += 0.6 * (n - y);
      const k = Math.floor(t * SR) + i; if (k < N) buf[k] += (n - y) * Math.exp((-i / SR) * (3 / len)) * vol;
    }
  };
  const swell = (buf, t0, t1, f0, f1, vol, decay = false) => {
    let y = 0;
    for (let i = Math.floor(t0 * SR); i < t1 * SR && i < N; i++) {
      const k = (i / SR - t0) / (t1 - t0), fc = f0 * (f1 / f0) ** k;
      y += (1 - Math.exp((-2 * Math.PI * fc) / SR)) * (noise() - y);
      buf[i] += y * vol * (decay ? Math.exp(-k * 5) : k * k);
    }
  };

  const CHORDS = [[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]]; // Am F C G
  const ROOTS = [45, 41, 48, 43];
  const MELODY = [
    [76, null, 72, 74, 76, 79, 76, 74],
    [72, null, 69, 72, 77, 76, 72, 69],
    [72, 74, 76, null, 79, 76, 74, 72],
    [74, null, 71, 74, 79, 78, 79, null],
  ];
  const BAR = 2, BEAT = 0.5, E8 = 0.25, S16 = 0.125;
  const arp = (buf, bar, c, o) => { for (let s = 0; s < 16; s++) note(buf, bar * BAR + s * S16, S16 * 0.9, midi(CHORDS[c][s % 3] + 12 + (s % 6 > 2 ? 12 : 0)), o); };
  const melody = (buf, bar, c, o) => MELODY[c].forEach((m, s) => m && note(buf, bar * BAR + s * E8, E8 * 0.92, midi(m), o));

  // 0–14 s: the 2003 chiptune (bars 0–6, plus bar 7 so the tape stop has something to drag down)
  for (let bar = 0; bar < 8; bar++) {
    const c = bar % 4;
    arp(chip, bar, c, { duty: 0.25, vol: bar < 2 ? 0.05 : 0.07, d: 0.05, s: 0.4 });
    if (bar >= 2) for (let b = 0; b < 8; b++) note(chip, bar * BAR + b * E8, E8 * 0.8, midi(ROOTS[c] - 12 + (b % 2 ? 12 : 0)), { type: 'tri', vol: 0.22, s: 0.9 });
    if (bar >= 3) {
      melody(chip, bar, c, { duty: 0.5, vol: 0.1, s: 0.7 });
      for (let b = 0; b < 4; b++) { kick(chip, bar * BAR + b * BEAT, 0.5, true); if (b % 2) snare(chip, bar * BAR + b * BEAT, 0.28); }
    }
    if (bar >= 2) for (let h = 0; h < 8; h++) hat(chip, bar * BAR + h * E8 + (h % 2 ? 0 : 0.0), 0.06);
  }
  // 14–15.5 s: tape stop, then nothing
  const src = chip.slice();
  for (let i = 14 * SR; i < N; i++) {
    const tau = i / SR - 14;
    if (tau > 1.5) { chip[i] = 0; continue; }
    const pos = (14 + tau - (tau * tau) / 3) * SR, k = Math.floor(pos), f = pos - k;
    chip[i] = (src[k] * (1 - f) + src[k + 1] * f) * (1 - tau / 1.5) ** 0.5;
  }
  // 15.5–19 s: one lonely, detuned voice + crackle; 19 s: CRT power-off zap
  [[76, 15.6], [72, 16.4], [74, 17.2], [69, 18.0]].forEach(([m, t]) => note(lead, t, 0.7, midi(m) * 0.995, { duty: 0.5, vol: 0.07, s: 0.5, r: 0.5 }));
  for (let i = 15.5 * SR; i < 20 * SR; i++) if (noise() > 0.9993) fx[i] += noise() * 0.25;
  for (let i = 15.5 * SR; i < 19.2 * SR; i++) fx[i] += Math.sin((2 * Math.PI * 60 * i) / SR) * 0.012;
  { let p = 0; for (let i = 0; i < 0.7 * SR; i++) { const tt = i / SR; p += (40 + 1400 * Math.exp(-tt * 7)) / SR; fx[19 * SR + i] += Math.sin(2 * Math.PI * p) * 0.18 * Math.exp(-tt * 3); } }

  // 20–28 s: the build — pad, rising saw arp, noise riser, snare roll, a breath before the drop
  for (let bar = 10; bar < 14; bar++) {
    const c = bar % 4;
    CHORDS[c].forEach((m) => note(pad, bar * BAR, BAR, midi(m), { type: 'saw', voices: 3, vol: 0.09, a: 0.6, d: 0.2, s: 0.9, r: 0.6, cutoff: 500, cutoffEnd: 900 }));
    note(bass, bar * BAR, BAR * 0.95, midi(ROOTS[c] - 12), { type: 'sine', vol: 0.25, a: 0.3, s: 1, r: 0.3 });
    if (bar >= 12) arp(lead, bar, c, { type: 'saw', vol: 0.06, s: 0.5, cutoff: 300 + (bar - 12) * 1800, cutoffEnd: 2100 + (bar - 12) * 2400 });
  }
  swell(fx, 25.5, 27.85, 200, 9000, 0.22);
  for (let i = 0; i < 16; i++) { const t = 26 + 1.85 * (1 - (1 - i / 16) ** 1.6); snare(drums, t, 0.08 + i * 0.02); }

  // 28–38 s: the drop — modern kit, sidechained pad, saw lead playing the 2003 melody, chip arp on top
  for (let bar = 14; bar < 19; bar++) {
    const c = bar % 4, t0 = bar * BAR;
    for (let b = 0; b < 4; b++) { kick(drums, t0 + b * BEAT, 0.95); if (b % 2) snare(drums, t0 + b * BEAT, 0.42); }
    for (let h = 0; h < 8; h++) hat(drums, t0 + h * E8 + E8 / 2, 0.12);
    for (let b = 0; b < 8; b++) note(bass, t0 + b * E8 + E8 / 2, E8 * 0.8, midi(ROOTS[c] - 12), { type: 'saw', voices: 2, vol: 0.28, s: 0.8, cutoff: 700 });
    CHORDS[c].forEach((m) => note(pad, t0, BAR, midi(m), { type: 'saw', voices: 5, detune: 0.012, vol: 0.08, a: 0.02, s: 0.8, r: 0.3, cutoff: 3000 }));
    melody(lead, bar, c, { type: 'saw', voices: 3, vol: 0.09, s: 0.7, cutoff: 3500 });
    melody(lead, bar, c, { duty: 0.25, vol: 0.035, s: 0.6 });
    arp(chip, bar, c, { duty: 0.25, vol: 0.035, d: 0.05, s: 0.4 });
  }
  swell(fx, 28, 30, 9000, 1500, 0.2, true);
  // sidechain the pad and bass to the kick
  for (let i = 28 * SR; i < 38 * SR; i++) { const ph = ((i / SR - 28) % BEAT) / BEAT, g = 0.35 + 0.65 * Math.min(1, ph * 3.2); pad[i] *= g; bass[i] *= 0.5 + 0.5 * g; }

  // 38–46 s: the chip melody returns over a big pad; logo impact at 40.3; ring out on A minor
  [[19, 0], [20, 1], [21, 3]].forEach(([bar, c]) => {
    CHORDS[c].forEach((m) => note(pad, bar * BAR, BAR, midi(m), { type: 'saw', voices: 5, detune: 0.01, vol: 0.075, a: 0.4, s: 0.9, r: 0.5, cutoff: 1400 }));
    arp(chip, bar, c, { duty: 0.25, vol: 0.05, d: 0.05, s: 0.4 });
    melody(lead, bar, c, { duty: 0.5, vol: 0.085, s: 0.7 });
    note(bass, bar * BAR, BAR * 0.95, midi(ROOTS[c] - 12), { type: 'sine', vol: 0.3, a: 0.05, s: 1, r: 0.3 });
    if (bar >= 20) for (let h = 0; h < 8; h++) hat(drums, bar * BAR + h * E8 + E8 / 2, 0.06);
  });
  kick(drums, 40.3, 1.1); swell(fx, 40.3, 42.6, 12000, 3000, 0.22, true);
  [57, 60, 64, 71].forEach((m) => note(pad, 44, 1.6, midi(m), { type: 'saw', voices: 5, detune: 0.01, vol: 0.075, a: 0.05, s: 0.9, r: 0.4, cutoff: 1800, cutoffEnd: 500 }));
  note(lead, 44, 1.4, midi(81), { duty: 0.5, vol: 0.085, s: 0.8, r: 0.5 });
  note(bass, 44, 1.6, midi(33), { type: 'sine', vol: 0.35, s: 1, r: 0.4 });

  // effects + mix
  const L = new Float32Array(N), R = new Float32Array(N);
  const delay = (buf, secs, fb, mix) => {
    const d = Math.floor(secs * SR), l = new Float32Array(N), r = new Float32Array(N);
    for (let i = 0; i < N; i++) { l[i] = buf[i] + (i >= d ? r[i - d] * fb : 0); r[i] = i >= d ? l[i - d] * fb + (i >= 2 * d ? 0 : 0) : 0; }
    return [(i) => buf[i] + l[i] * mix - buf[i] * mix, (i) => buf[i] + r[i] * mix];
  };
  const reverb = (buf, mix) => {
    const combs = [1557, 1617, 1491, 1422].map((n) => ({ b: new Float32Array(n), i: 0 }));
    const outBuf = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (const c of combs) { const y = c.b[c.i]; c.b[c.i] = buf[i] + y * 0.82; c.i = (c.i + 1) % c.b.length; s += y; }
      outBuf[i] = buf[i] + (s / 4) * mix;
    }
    return outBuf;
  };
  const [leadL, leadR] = delay(lead, 0.375, 0.38, 0.35);
  const padV = reverb(pad, 0.5), chipV = reverb(chip, 0.18);
  const fade = (i) => Math.min(1, (N - i) / (0.6 * SR));
  for (let i = 0; i < N; i++) {
    const c = chipV[i] * 0.9, p = padV[i], b = bass[i], d = drums[i], f = fx[i];
    L[i] = (c * 1.05 + leadL(i) + p * 1.1 + b + d + f * 1.1) * fade(i);
    R[i] = (c * 0.95 + leadR(i) + p * 0.9 + b + d + f * 0.9) * fade(i);
  }
  let peak = 0;
  for (let i = 0; i < N; i++) { L[i] = Math.tanh(L[i] * 1.3); R[i] = Math.tanh(R[i] * 1.3); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
  const gain = 0.9 / peak;
  const wav = Buffer.alloc(44 + N * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 4, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++) { wav.writeInt16LE(Math.round(L[i] * gain * 32767), 44 + i * 4); wav.writeInt16LE(Math.round(R[i] * gain * 32767), 46 + i * 4); }
  const file = path.join(out, 'soundtrack.wav');
  fs.writeFileSync(file, wav);
  return file;
}

/* ------------------------------------------------------------------ frames */
async function openFilm() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(path.join(here, 'video.html')).href + '?render=1');
  await page.evaluate(() => document.fonts.ready);
  return { browser, page };
}
const grab = (page, t, type = 'image/jpeg') =>
  page.evaluate(([t, type]) => { window.renderFrame(t); return document.getElementById('c').toDataURL(type, 0.94); }, [t, type])
    .then((url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));

if (args[0] === '--audio') {
  console.log('wrote', soundtrack());
} else if (args[0] === '--stills') {
  const { browser, page } = await openFilm();
  for (const t of (args[1] ?? '1,8,12,17,24,27,29,35,42,44').split(',').map(Number)) {
    fs.writeFileSync(path.join(out, `still-${t}.png`), await grab(page, t, 'image/png'));
  }
  await browser.close();
  console.log('stills in', out);
} else {
  const wav = soundtrack();
  console.log('soundtrack:', wav);
  const mp4 = path.join(out, 'meshground-launch.mp4');
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-i', wav,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (code) => (code ? rej(new Error(`ffmpeg exited ${code}`)) : res())));
  const { browser, page } = await openFilm();
  const frames = FPS * DURATION;
  for (let f = 0; f < frames; f++) {
    const jpg = await grab(page, f / FPS);
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % FPS === 0) process.stdout.write(`\rframe ${f}/${frames}`);
  }
  ff.stdin.end();
  await browser.close();
  await done;
  console.log(`\nwrote ${mp4}`);
}
