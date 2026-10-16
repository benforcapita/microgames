// E2E-PNG: e2e screenshots must land in a gitignored directory, never over the committed docs/pr-assets/ PNGs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SHOT_DIR, shotPath } from '../../e2e/shots.mjs';

describe('e2e screenshots stay out of git', () => {
  it('no e2e spec writes into docs/', () => {
    for (const f of fs.readdirSync('e2e').filter((x) => x.endsWith('.mjs'))) {
      const src = fs.readFileSync(path.join('e2e', f), 'utf8');
      assert.doesNotMatch(src, /path:\s*['"`]docs\//, f);
    }
  });
  it('every screenshot call uses shotPath()', () => {
    for (const f of fs.readdirSync('e2e').filter((x) => x.endsWith('.spec.mjs'))) {
      const src = fs.readFileSync(path.join('e2e', f), 'utf8');
      for (const m of src.matchAll(/screenshot\(\{\s*path:\s*([^,}]+)/g)) assert.match(m[1], /^shotPath\(/, `${f}: ${m[1]}`);
    }
  });
  it('the output directory is under the repo and git-ignored', () => {
    const root = path.resolve('.');
    assert.ok(path.resolve(SHOT_DIR).startsWith(root + path.sep), SHOT_DIR);
    const rel = path.relative(root, shotPath('x.png'));
    // exits 0 (and prints the path) only when the path is ignored
    assert.equal(execFileSync('git', ['check-ignore', rel], { encoding: 'utf8' }).trim(), rel);
  });
});
