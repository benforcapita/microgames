/** Only allow same-site relative redirects (prevents open redirects via ?next=). */
export { safeNext } from './safe-next';

export function withParams(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
  return q.size ? `${path}?${q}` : path;
}
