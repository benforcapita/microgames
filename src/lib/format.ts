const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export const compact = (n: number) => compactFmt.format(n);
/** "1 play", "0 plays", "1.2K plays". */
export const count = (n: number, one: string, many = `${one}s`) => `${compact(n)} ${n === 1 ? one : many}`;
export const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);
export const stars = (n: number | null) => (n === null ? '—' : n.toFixed(1));
export const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

export function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  const units: [number, string][] = [[86400 * 30, 'mo'], [86400 * 7, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [size, label] of units) if (s >= size) return `${Math.floor(s / size)}${label} ago`;
  return 'just now';
}

export function formatCheck(value: number | null, format: 'count' | 'pct' | 'sec' | 'stars') {
  if (value === null) return '—';
  if (format === 'pct') return pct(value);
  if (format === 'sec') return `${Math.round(value)}s`;
  if (format === 'stars') return `${value.toFixed(1)}★`;
  return compact(value);
}
