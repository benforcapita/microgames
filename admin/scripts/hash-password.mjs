#!/usr/bin/env node
// Reads a password from stdin — no echo on a TTY, piped stdin also works —
// and prints an argon2id PHC string (m=19456, t=2, p=1) for ADMIN_PASSWORD_HASH.
// The password itself is never printed.

import argon2 from '@node-rs/argon2';

function readTty() {
  return new Promise((resolve, reject) => {
    const bytes = [];
    const stdin = process.stdin;
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
    };
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('aborted'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          process.stderr.write('\n');
          resolve(Buffer.concat(bytes.map((b) => Buffer.from([b]))).toString('utf8'));
          return;
        }
        if (byte === 127 || byte === 8) {
          bytes.pop();
          continue;
        }
        bytes.push(byte);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    process.stderr.write('Password: ');
    stdin.on('data', onData);
  });
}

async function readPiped() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
}

const password = process.stdin.isTTY ? await readTty() : await readPiped();
if (!password) {
  process.stderr.write('empty password\n');
  process.exit(1);
}

const hash = await argon2.hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
process.stdout.write(hash + '\n');
