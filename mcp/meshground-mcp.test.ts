// Drives the stdio MCP server as a client would, against a fake Meshground API.
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, it } from 'node:test';
import { validateThumb } from '../src/lib/server/upload.ts';

const SCRIPT = new URL('./meshground-mcp.mjs', import.meta.url).pathname;
const TOKEN = 'mgp_test';
const game = { id: 'g1', slug: 'sky-loop', title: 'Sky Loop', stage: 'pending', status: 'Pending', playUrl: 'http://x/play/sky-loop', submissionUrl: 'http://x/submissions/g1', plays: 0 };

type Seen = { method: string; url: string; auth: string | undefined; body: any };
const seen: Seen[] = [];
let api: Server;
let base = '';

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });

function rpcClient(env: Record<string, string>) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? '', ...env } });
  const pending = new Map<number, (msg: any) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let id = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      pending.set(++id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await request('tools/call', { name, arguments: args })).result;
  return { child, request, call, close: () => child.kill() };
}

before(async () => {
  api = createServer(async (req, res) => {
    const raw = await readBody(req);
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/EXCHANGE_SDK.md') return void res.end('# Meshground SDK');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'Missing or invalid API token.' });
    if (req.url === '/api/v1/games' && req.method === 'POST') return json(201, { game });
    if (req.url === '/api/v1/games' && req.method === 'GET') return json(200, { games: [game] });
    if (req.url === '/api/v1/games/sky-loop' && req.method === 'PUT') return json(409, { error: 'This game is published.' });
    if (req.url === '/api/v1/games/g1' && req.method === 'PUT') return json(200, { game });
    if (req.url === '/api/v1/games/g1' && req.method === 'GET') {
      return json(200, { game, validation: { headline: 'Failed', detail: 'Fix it.', checks: [{ level: 'fail', name: 'Canvas', message: 'No canvas.' }] } });
    }
    json(404, { error: 'Not found' });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const addr = api.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => api.close());

describe('meshground MCP server', () => {
  it('initializes and lists the four tools', async () => {
    const c = rpcClient({ MESHGROUND_URL: base, MESHGROUND_TOKEN: TOKEN });
    try {
      const init = await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      assert.equal(init.result.protocolVersion, '2025-03-26');
      assert.equal(init.result.serverInfo.name, 'meshground');
      const list = await c.request('tools/list');
      assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name).sort(), ['get_sdk_guide', 'list_my_games', 'publish_game', 'update_game']);
      assert.equal((await c.request('nope')).error.code, -32601);
      assert.equal((await c.request('tools/call', { name: 'nope' })).error.code, -32602);
    } finally {
      c.close();
    }
  });

  it('publishes with a generated thumbnail that passes the upload rules', async () => {
    const c = rpcClient({ MESHGROUND_URL: base, MESHGROUND_TOKEN: TOKEN });
    try {
      const refused = await c.call('publish_game', { title: 'Sky Loop', license: 'MIT', html: '<canvas>' });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /confirm/);

      seen.length = 0;
      const ok = await c.call('publish_game', { title: 'Sky Loop', license: 'MIT', html: '<canvas></canvas>', tags: ['arcade'], confirm_content_rules: true });
      assert.equal(ok.isError, undefined);
      assert.match(ok.content[0].text, /submissions\/g1/);
      const [post] = seen;
      assert.equal(post.auth, `Bearer ${TOKEN}`);
      assert.equal(post.body.agreeToContentRules, true);
      assert.deepEqual(post.body.tags, ['arcade']);
      assert.equal(post.body.thumbnail.type, 'image/png');
      const thumb = new File([Buffer.from(post.body.thumbnail.data, 'base64')], 'thumb.png', { type: 'image/png' });
      const checked = await validateThumb(thumb);
      assert.ok('thumb' in checked, JSON.stringify(checked));
    } finally {
      c.close();
    }
  });

  it('reads html and thumbnail from local files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mg-mcp-'));
    writeFileSync(join(dir, 'game.html'), '<html><canvas></canvas></html>');
    writeFileSync(join(dir, 'bad.gif'), 'GIF89a');
    const c = rpcClient({ MESHGROUND_URL: base, MESHGROUND_TOKEN: TOKEN });
    try {
      seen.length = 0;
      const ok = await c.call('update_game', { game: 'g1', html_path: join(dir, 'game.html') });
      assert.equal(ok.isError, undefined);
      assert.equal(seen[0].body.html, '<html><canvas></canvas></html>');
      assert.equal(seen[0].body.thumbnail, undefined);
      const badThumb = await c.call('update_game', { game: 'g1', html: '<canvas>', thumbnail_path: join(dir, 'bad.gif') });
      assert.equal(badThumb.isError, true);
      const badThumbOnly = await c.call('update_game', { game: 'g1', thumbnail_path: join(dir, 'bad.gif') });
      assert.match(badThumbOnly.content[0].text, /PNG, JPEG or WebP/);

      writeFileSync(join(dir, 'thumb.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
      seen.length = 0;
      const thumbOnly = await c.call('update_game', { game: 'g1', thumbnail_path: join(dir, 'thumb.png') });
      assert.equal(thumbOnly.isError, undefined);
      assert.equal(seen[0].body.html, undefined);
      assert.equal(seen[0].body.thumbnail.type, 'image/png');

      const missing = await c.call('update_game', { game: 'g1' });
      assert.match(missing.content[0].text, /html_path.*thumbnail_path/);
    } finally {
      c.close();
    }
  });

  it('surfaces API errors, lists games and shows validation checks', async () => {
    const c = rpcClient({ MESHGROUND_URL: base, MESHGROUND_TOKEN: TOKEN });
    try {
      const published = await c.call('update_game', { game: 'sky-loop', html: '<canvas>' });
      assert.equal(published.isError, true);
      assert.match(published.content[0].text, /published/);
      assert.match((await c.call('list_my_games')).content[0].text, /Sky Loop \[Pending\] id=g1/);
      const detail = (await c.call('list_my_games', { game: 'g1' })).content[0].text;
      assert.match(detail, /\[fail\] Canvas: No canvas\./);
      assert.equal((await c.call('get_sdk_guide')).content[0].text, '# Meshground SDK');
    } finally {
      c.close();
    }
  });

  it('explains a missing token', async () => {
    const c = rpcClient({ MESHGROUND_URL: base });
    try {
      const res = await c.call('list_my_games');
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /MESHGROUND_TOKEN is not set.*\/me#mcp/);
      assert.equal((await c.call('get_sdk_guide')).isError, undefined);
    } finally {
      c.close();
    }
  });
});
