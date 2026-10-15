// Serves the EF-2 test fixture as validate-game for a local proof.
// The copy under supabase/functions/validate-game exists only while this process
// runs, so it does not collide with EF-1's function of the same name.
import { cp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = join(root, 'supabase/tests/fixtures/validate-game-stub');
const dest = join(root, 'supabase/functions/validate-game');

async function cleanup() {
  await rm(dest, { recursive: true, force: true });
}

await cleanup();
await mkdir(dirname(dest), { recursive: true });
await cp(fixture, dest, { recursive: true });

const child = spawn(
  'npx',
  ['-y', 'supabase@2.120.0', 'functions', 'serve', '--no-verify-jwt'],
  { cwd: root, stdio: 'inherit' },
);

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('exit', (code) => {
  cleanup().finally(() => process.exit(code ?? 0));
});
