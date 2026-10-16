import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_ASSETS_PER_GAME, scanAssetSource, type AssetScan } from './asset-scan.ts';

function paths(scan: AssetScan): string[] {
  return scan.assets.map((asset) => `${asset.expectedType}:${asset.path}`);
}

describe('asset limit constants', () => {
  test('the manifest keeps at most 200 files', () => {
    assert.equal(MAX_ASSETS_PER_GAME, 200);
  });
});

describe('scanAssetSource', () => {
  test('reads src/href, CSS url() and @font-face, fetch, new Image, new Audio, and .src assignments', () => {
    const html = `<!doctype html>
      <img src="./sprites/hero.png?v=2#frame" alt="">
      <a href="./notes/readme.txt">notes</a>
      <audio src="./sfx/hit.wav"></audio>
      <style>
        @font-face {
          font-family: Game;
          src: url("./fonts/game.woff2") format("woff2"), url('./fonts/game.otf');
        }
        body { background: url("./gfx/bg.webp"); }
      </style>
      <script>
        fetch("./data/levels.json");
        const sprite = new Image("./gfx/coin.png");
        const jump = new Audio('./sfx/jump.mp3');
        sprite.src = "./gfx/player.webp";
        sprite["src"] = "./gfx/computed.gif";
      </script>
      <img onerror="this.src = './gfx/fallback.jpg'">
    `;
    const scan = scanAssetSource(html);
    assert.equal(scan.truncated, false);
    assert.deepEqual(scan.rejected, []);
    assert.deepEqual(paths(scan), [
      'image:sprites/hero.png',
      'text:notes/readme.txt',
      'audio:sfx/hit.wav',
      'font:fonts/game.woff2',
      'font:fonts/game.otf',
      'image:gfx/bg.webp',
      'json:data/levels.json',
      'image:gfx/coin.png',
      'audio:sfx/jump.mp3',
      'image:gfx/player.webp',
      'image:gfx/computed.gif',
      'image:gfx/fallback.jpg',
    ]);
  });

  test('normalizes ./, query, hash, and percent-encoding, and keeps one row per path', () => {
    const html = `
      <img src="././sprites%2Fhero.png?x=1#y">
      <img src="sprites/hero.png">
      <script>fetch(\`./data/levels.json\`);</script>
    `;
    const scan = scanAssetSource(html);
    assert.deepEqual(paths(scan), ['image:sprites/hero.png', 'json:data/levels.json']);
  });

  test('skips external, data, and blob URLs, and html/js/css bundle files', () => {
    const html = `
      <img src="https://cdn.example/a.png">
      <img src="//cdn.example/b.png">
      <img src="data:image/png;base64,aaaa">
      <img src="blob:https://cdn.example/id">
      <a href="mailto:hi@example.com">mail</a>
      <a href="#top">top</a>
      <script src="./game.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/three/build/three.min.js"></script>
      <link rel="stylesheet" href="./style.css">
      <a href="./index.html">self</a>
      <script>fetch("https://api.example/scores.json");</script>
    `;
    const scan = scanAssetSource(html);
    assert.deepEqual(scan.assets, []);
    assert.deepEqual(scan.rejected, []);
  });

  test('rejects absolute paths, dotdot, backslash, and paths over 512 characters', () => {
    const long = `${'a'.repeat(509)}.png`;
    const html = `
      <img src="/abs.png">
      <img src="../secret.png">
      <img src="sprites/../hero.png">
      <img src="sprites\\hero.png">
      <img src="./${long}">
      <script>
        fetch("%2e%2e/hidden.png");
        sprite.src = "%2Fsecret.png";
        fetch("sprites%5Chero.png");
      </script>
    `;
    const scan = scanAssetSource(html);
    assert.deepEqual(scan.assets, []);
    assert.deepEqual(
      scan.rejected.map((item) => item.reason),
      ['absolute', 'dotdot', 'dotdot', 'backslash', 'too_long', 'dotdot', 'absolute', 'backslash'],
    );
  });

  test('accepts a 512-character path and ignores comments, dynamic strings, and unknown extensions', () => {
    const ok = `${'b'.repeat(508)}.png`;
    assert.equal(ok.length, 512);
    const html = `
      <img src="./${ok}">
      <img src="./mesh.wasm">
      <style>/* url("./commented.png") */ .x { background: url("./kept.png"); }</style>
      <script>
        // fetch("./commented.json")
        /* new Audio("./commented.mp3") */
        const file = "./dynamic.png";
        img.src = file;
        img.srcset = "./srcset.png";
        fetch("./" + "built.json");
        fetch(\`./sfx/\${name}.mp3\`);
      </script>
    `;
    const scan = scanAssetSource(html);
    assert.deepEqual(paths(scan), [`image:${ok}`, 'image:kept.png']);
    assert.deepEqual(scan.rejected, []);
  });

  test('stops the manifest at 200 files', () => {
    const tags = Array.from({ length: 201 }, (_, i) => `<img src="./img/${i}.png">`).join('');
    const scan = scanAssetSource(`<body>${tags}</body>`);
    assert.equal(scan.assets.length, MAX_ASSETS_PER_GAME);
    assert.equal(scan.truncated, true);
    assert.equal(scan.assets[0].path, 'img/0.png');
    assert.equal(scan.assets[199].path, 'img/199.png');
    assert.equal(scan.assets[199].expectedType, 'image');
  });

  test('over 200 refs, CSS and JS paths are kept alongside HTML attributes', () => {
    const imgs = Array.from({ length: 201 }, (_, i) => `<img src="./img/${i}.png">`).join('');
    const css = Array.from({ length: 10 }, (_, i) => `.c${i}{background:url("./css/${i}.webp")}`).join('');
    const js = Array.from({ length: 10 }, (_, i) => `fetch("./js/${i}.json");`).join('');
    const scan = scanAssetSource(`<body>${imgs}<style>${css}</style><script>${js}</script></body>`);
    assert.equal(scan.assets.length, MAX_ASSETS_PER_GAME);
    assert.equal(scan.truncated, true);
    const got = new Set(scan.assets.map((asset) => asset.path));
    for (let i = 0; i < 10; i++) {
      assert.ok(got.has(`css/${i}.webp`), `missing css/${i}.webp`);
      assert.ok(got.has(`js/${i}.json`), `missing js/${i}.json`);
    }
    assert.equal(scan.assets.filter((asset) => asset.path.startsWith('img/')).length, 180);
    assert.deepEqual(
      scan.assets.slice(0, 3).map((asset) => asset.path),
      ['img/0.png', 'css/0.webp', 'js/0.json'],
    );
  });

  test('scans a stylesheet or script on its own', () => {
    const css = scanAssetSource('@font-face { src: url("./fonts/game.woff"); }', 'css');
    assert.deepEqual(paths(css), ['font:fonts/game.woff']);
    const js = scanAssetSource('new Audio("./sfx/hit.ogg"); fetch("./copy.txt");', 'js');
    assert.deepEqual(paths(js), ['audio:sfx/hit.ogg', 'text:copy.txt']);
  });
});
