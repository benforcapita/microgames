import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ADMIN = new URL('..', import.meta.url).pathname;
const ROOTS = ['src', 'scripts'].map((dir) => join(ADMIN, dir));
const FORBIDDEN = [
  'signUp',
  '/signup',
  'service_role',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'sb_secret_',
];

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}

test('admin/src and admin/scripts do not sign up or carry a secret key', () => {
  const files = ROOTS.flatMap(filesIn);
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const term of FORBIDDEN) {
      assert.equal(text.includes(term), false, `${file} contains ${term}`);
    }
  }
});
