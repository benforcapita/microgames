// Runs the portal and the separate-origin game CDN together.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const procs = [
  spawn(process.execPath, ['scripts/game-cdn.mjs'], { stdio: 'inherit' }),
  mode === 'dev'
    ? spawn('npx', ['astro', 'dev'], { stdio: 'inherit' })
    : spawn(process.execPath, ['dist/server/entry.mjs'], { stdio: 'inherit', env: { PORT: '4321', ...process.env } }),
];

const stop = () => procs.forEach((p) => p.kill());
procs.forEach((p) => p.on('exit', (code) => { stop(); process.exitCode = code ?? 0; }));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
