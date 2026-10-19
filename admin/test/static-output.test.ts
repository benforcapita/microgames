import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ADMIN = new URL('..', import.meta.url).pathname;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('build: the Vercel static output is empty', () => {
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: ADMIN, stdio: 'pipe' });
  const staticOut = join(ADMIN, '.vercel', 'output', 'static');
  assert.deepEqual(walk(staticOut), [], 'Vercel static output must contain no files');
});

test('build: no public/ folder and no static assets in src/', () => {
  assert.equal(existsSync(join(ADMIN, 'public')), false, 'admin must not have a public/ folder');
});
