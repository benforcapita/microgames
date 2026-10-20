#!/usr/bin/env node
// Meshground MCP server (stdio). Publish and update single-file HTML games on Meshground from
// any MCP client: Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI. Zero dependencies, Node >= 18.
//
// Env:
//   MESHGROUND_TOKEN  personal API token, created on your dashboard (/me#mcp)
//   MESHGROUND_URL    optional; defaults to the site this file was downloaded from
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const SITE = '__MESHGROUND_URL__';
const VERSION = '1.0.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LICENSES = ['MIT', 'CC-BY-SA-4.0', 'All rights reserved'];
const RULES = 'no unlicensed copyrighted art, music or characters, and no voice clones of real people';

class ToolError extends Error {}

const baseUrl = () => (process.env.MESHGROUND_URL || (SITE.startsWith('__') ? '' : SITE)).replace(/\/+$/, '');

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const base = baseUrl();
  if (!base) throw new ToolError('MESHGROUND_URL is not set.');
  const headers = { Accept: 'application/json' };
  if (auth) {
    const token = process.env.MESHGROUND_TOKEN;
    if (!token) throw new ToolError(`MESHGROUND_TOKEN is not set. Create a token at ${base}/me#mcp and add it to this MCP server's env.`);
    headers.Authorization = `Bearer ${token}`;
  }
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new ToolError(data?.errors?.join(' ') || data?.error || `Meshground returned HTTP ${res.status}.`);
  return data ?? text;
}

async function gameHtml(args) {
  if (args.html_path) return readFile(args.html_path, 'utf8');
  if (typeof args.html === 'string' && args.html) return args.html;
  throw new ToolError('Pass the game as `html` (the full file contents) or `html_path` (a local .html file).');
}

function imageType(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  throw new ToolError('Thumbnail must be a PNG, JPEG or WebP file (at most 640×360, under 512 KB).');
}

async function thumbnailFile(path) {
  const bytes = await readFile(path);
  return { data: bytes.toString('base64'), type: imageType(bytes) };
}

const describe = (g) =>
  `- ${g.title} [${g.status}] id=${g.id} slug=${g.slug}\n  ${g.stage === 'proving' || g.stage === 'live' ? g.playUrl : g.submissionUrl} · ${g.plays} plays`;

const TOOLS = [
  {
    name: 'get_sdk_guide',
    title: 'Meshground SDK guide',
    description:
      'Returns the Meshground game SDK guide (EXCHANGE_SDK.md). Read it before writing a game: it covers the single-file format, size limits, allowed CDNs, saves, ads and the window.Meshground API.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async () => api('/EXCHANGE_SDK.md', { auth: false }),
  },
  {
    name: 'publish_game',
    title: 'Publish a game',
    description:
      `Uploads a new single-file HTML game to Meshground. It is validated automatically and reviewed before it goes public. Before calling, confirm with the user that the game contains ${RULES}, and which license to use. A thumbnail is generated from the title when none is given.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 2, maxLength: 60 },
        license: { type: 'string', enum: LICENSES, description: 'Ask the user. MIT and CC-BY-SA-4.0 allow others to fork the game.' },
        html: { type: 'string', description: 'The complete game as one self-contained HTML document. Use this or html_path.' },
        html_path: { type: 'string', description: 'Absolute path to a local .html file. Use this or html.' },
        tagline: { type: 'string', maxLength: 90 },
        description: { type: 'string', maxLength: 2000 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        fork_of: { type: 'string', description: 'Slug or id of the game this one remixes.' },
        thumbnail_path: { type: 'string', description: 'Optional local PNG/JPEG/WebP, at most 640×360 and under 512 KB.' },
        confirm_content_rules: { type: 'boolean', description: `True only after the user confirmed: ${RULES}.` },
      },
      required: ['title', 'license', 'confirm_content_rules'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (args) => {
      if (args.confirm_content_rules !== true) {
        throw new ToolError(`Ask the user to confirm the game contains ${RULES} (${baseUrl()}/creators#rules), then call again with confirm_content_rules: true.`);
      }
      const html = await gameHtml(args);
      const title = String(args.title ?? '');
      const thumbnail = args.thumbnail_path
        ? await thumbnailFile(args.thumbnail_path)
        : { data: placeholderThumbnail(title).toString('base64'), type: 'image/png' };
      const { game } = await api('/api/v1/games', {
        method: 'POST',
        body: {
          title,
          license: args.license,
          html,
          tagline: args.tagline,
          description: args.description,
          tags: args.tags,
          forkOf: args.fork_of,
          thumbnail,
          agreeToContentRules: true,
        },
      });
      return [
        `Uploaded "${game.title}" (id ${game.id}, slug ${game.slug}). Status: ${game.status}.`,
        `Track validation and review: ${game.submissionUrl}`,
        `Once approved it will be playable at ${game.playUrl}`,
        'If validation fails, fix the game and call update_game with this id. Call list_my_games with this id to see the checks.',
      ].join('\n');
    },
  },
  {
    name: 'update_game',
    title: 'Update an unpublished game',
    description:
      'Replaces the HTML (and optionally the thumbnail) of one of your games that is not published yet (validating, awaiting review, or rejected). It goes back through validation. Published games cannot be replaced; publish a new game with fork_of instead.',
    inputSchema: {
      type: 'object',
      properties: {
        game: { type: 'string', description: 'Game id or slug (see list_my_games).' },
        html: { type: 'string', description: 'The complete new HTML document. Use this or html_path.' },
        html_path: { type: 'string', description: 'Absolute path to a local .html file. Use this or html.' },
        thumbnail_path: { type: 'string', description: 'Optional new PNG/JPEG/WebP thumbnail, at most 640×360 and under 512 KB.' },
      },
      required: ['game'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: async (args) => {
      const html = await gameHtml(args);
      const thumbnail = args.thumbnail_path ? await thumbnailFile(args.thumbnail_path) : undefined;
      const { game } = await api(`/api/v1/games/${encodeURIComponent(String(args.game ?? ''))}`, { method: 'PUT', body: { html, thumbnail } });
      return `Updated "${game.title}" (id ${game.id}). Status: ${game.status}.\nTrack validation and review: ${game.submissionUrl}`;
    },
  },
  {
    name: 'list_my_games',
    title: 'List my games',
    description:
      'Lists your Meshground games with their status (Pending, Awaiting review, Proving Grounds, Live, Rejected). Pass `game` (id or slug) to get that game\'s latest validation checks instead.',
    inputSchema: { type: 'object', properties: { game: { type: 'string', description: 'Optional game id or slug.' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args) => {
      if (args.game) {
        const { game, validation } = await api(`/api/v1/games/${encodeURIComponent(String(args.game))}`);
        const checks = (validation?.checks ?? []).map((c) => `  [${c.level}] ${c.name}: ${c.message}`);
        return [describe(game), validation ? `${validation.headline}: ${validation.detail}` : 'No validation yet.', ...checks].join('\n');
      }
      const { games } = await api('/api/v1/games');
      return games.length ? games.map(describe).join('\n') : 'You have not uploaded any games yet.';
    },
  },
];

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  try {
    const text = await tool.run(args ?? {});
    return { content: [{ type: 'text', text: String(text) }] };
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `Error: ${err?.message ?? err}`;
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

async function handle(msg) {
  const { id, method, params } = msg ?? {};
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      result = {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'meshground', title: 'Meshground', version: VERSION },
        instructions:
          'Meshground hosts single-file HTML browser games. Call get_sdk_guide before writing a game, publish_game to upload it, list_my_games to follow validation and review, and update_game to fix an unpublished game.',
      };
    } else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: TOOLS.map(({ run, ...tool }) => tool) };
    else if (method === 'tools/call') result = await callTool(params?.name, params?.arguments);
    else if (isRequest) return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    else return null;
    return isRequest ? { jsonrpc: '2.0', id, result } : null;
  } catch (err) {
    return isRequest ? { jsonrpc: '2.0', id, error: { code: err?.code ?? -32603, message: String(err?.message ?? err) } } : null;
  }
}

function serve() {
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  if (process.stdin.isTTY) console.error(`Meshground MCP server ${VERSION}: add this file to your MCP client's config. See ${baseUrl() || 'the site'}/me#mcp`);
  createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const reply = await handle(msg);
    if (reply) send(reply);
  });
}

// ---- Placeholder thumbnail: a 320×180 PNG with the title in a 5×7 pixel font. ----

const FONT = {
  A: '0e11111f111111', B: '1e11111e11111e', C: '0e11101010110e', D: '1e11111111111e', E: '1f10101e10101f',
  F: '1f10101e101010', G: '0e11101711110f', H: '1111111f111111', I: '0e04040404040e', J: '0702020202120c',
  K: '11121418141211', L: '1010101010101f', M: '111b1515111111', N: '11111915131111', O: '0e11111111110e',
  P: '1e11111e101010', Q: '0e11111115120d', R: '1e11111e141211', S: '0f10100e01011e', T: '1f040404040404',
  U: '1111111111110e', V: '11111111110a04', W: '1111111515150a', X: '11110a040a1111', Y: '1111110a040404',
  Z: '1f01020408101f', 0: '0e11131519110e', 1: '040c040404040e', 2: '0e11010204081f', 3: '1f02040201110e',
  4: '02060a121f0202', 5: '1f101e0101110e', 6: '0608101e11110e', 7: '1f010204080808', 8: '0e11110e11110e',
  9: '0e11110f01020c', '-': '0000001f000000', '!': '04040404040004', '?': '0e110102040004', '.': '00000000000c0c',
  ':': '000c0c000c0c00', "'": '04040800000000', '&': '0c12140815120d', ' ': '00000000000000',
};

function glyph(ch) {
  const hex = FONT[ch];
  return hex ? Array.from({ length: 7 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)) : null;
}

function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

function wrap(text, max) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ').filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= max) line = next;
    else {
      if (line) lines.push(line);
      line = word.slice(0, max);
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function placeholderThumbnail(title) {
  const W = 320;
  const H = 180;
  const stride = W * 3 + 1;
  const raw = Buffer.alloc(stride * H);
  let seed = 0;
  for (const ch of title) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = seed % 360;
  const from = hsl(hue, 0.65, 0.16);
  const to = hsl((hue + 55) % 360, 0.75, 0.42);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (x / W) * 0.65 + (y / H) * 0.35;
      const grid = x % 20 === 0 || y % 20 === 0 ? 18 : 0;
      for (let c = 0; c < 3; c++) raw[y * stride + 1 + x * 3 + c] = Math.min(255, from[c] + (to[c] - from[c]) * t + grid);
    }
  }
  const plot = (x, y, rgb, alpha = 1) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * stride + 1 + x * 3;
    for (let c = 0; c < 3; c++) raw[i + c] = Math.round(raw[i + c] * (1 - alpha) + rgb[c] * alpha);
  };
  const draw = (text, left, top, scale, rgb, alpha) => {
    [...text].forEach((ch, n) => {
      const rows = glyph(ch);
      rows?.forEach((bits, r) => {
        for (let col = 0; col < 5; col++) {
          if (!(bits & (16 >> col))) continue;
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) plot(left + (n * 6 + col) * scale + dx, top + r * scale + dy, rgb, alpha);
        }
      });
    });
  };
  const clean = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9\-!?.:'& ]/g, ' ').replace(/\s+/g, ' ').trim() || 'MESHGROUND';
  let scale = 2;
  let lines = wrap(clean, 24).slice(0, 3);
  for (const s of [4, 3]) {
    const candidate = wrap(clean, Math.floor((W - 32) / (6 * s)));
    if (candidate.length <= 2) {
      scale = s;
      lines = candidate;
      break;
    }
  }
  const lineHeight = 10 * scale;
  const top = Math.round((H - lines.length * lineHeight + 3 * scale) / 2);
  lines.forEach((line, i) => {
    const left = Math.round((W - (line.length * 6 - 1) * scale) / 2);
    const y = top + i * lineHeight;
    draw(line, left + Math.max(1, scale >> 1), y + Math.max(1, scale >> 1), scale, [0, 0, 0], 0.45);
    draw(line, left, y, scale, [255, 255, 255], 1);
  });
  draw('MESHGROUND', 12, H - 20, 1, [255, 255, 255], 0.55);
  return encodePng(W, H, raw);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(width, height, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
if (isMain) serve();
