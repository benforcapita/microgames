// Structured logger: JSON lines to stdout, allowlisted fields only (LLD §10).
// Never logged: raw URL/path, headers, cookies, Authorization, tokens,
// emails, form bodies, connection strings, IPs.

const ALLOWED = [
  'time',
  'level',
  'route',
  'status',
  'duration_ms',
  'action',
  'game_id',
  'lock',
  'error',
] as const;

export type LogFields = {
  level?: 'info' | 'error';
  route?: string;
  status?: number;
  duration_ms?: number;
  action?: string;
  game_id?: string;
  lock?: 1 | 2 | 3;
  error?: string;
};

export type LogEmit = (fields: LogFields) => void;

export function log(
  fields: LogFields,
  lineSink: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): void {
  const out: Record<string, unknown> = { time: new Date().toISOString() };
  for (const key of ALLOWED) {
    if (key === 'time') continue;
    const value = fields[key as keyof LogFields];
    if (value !== undefined) out[key] = value;
  }
  out.level ??= 'info';
  lineSink(JSON.stringify(out));
}
