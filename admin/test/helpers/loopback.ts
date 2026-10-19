// Local-stack coordinates for tests. Refuses anything that is not loopback,
// the same rule as scripts/lib/local-supabase.mjs. Never prints credentials.

import { execFileSync } from 'node:child_process';

const CLI = ['-y', 'supabase@2.120.0'];

export type LocalStack = {
  apiUrl: string;
  anonKey: string;
  secretKey: string;
  dbUrl: string;
};

export function assertLoopbackUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Refusing non-loopback Supabase URL');
  }
  const host = url.hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('Refusing non-loopback Supabase URL');
  }
}

export function localStack(): LocalStack {
  const root = new URL('../../../', import.meta.url);
  const out = execFileSync('npx', [...CLI, 'status', '-o', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    cwd: root,
    timeout: 30_000,
  });
  const parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as Record<string, unknown>;
  const apiUrl = stringField(parsed, 'API_URL');
  const dbUrl = stringField(parsed, 'DB_URL');
  const anonKey = stringField(parsed, 'PUBLISHABLE_KEY') ?? stringField(parsed, 'ANON_KEY');
  const secretKey = stringField(parsed, 'SECRET_KEY') ?? stringField(parsed, 'SERVICE_ROLE_KEY');
  if (!apiUrl || !dbUrl || !anonKey || !secretKey) {
    throw new Error('Local Supabase status is incomplete');
  }
  assertLoopbackUrl(apiUrl);
  assertLoopbackUrl(dbUrl);
  return { apiUrl, anonKey, secretKey, dbUrl };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}
