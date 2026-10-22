/** Share-link rules. No database or environment access, so the creator panel script can import them too. */

export const PREVIEW_LINK_TTLS = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
] as const;
export const DEFAULT_PREVIEW_LINK_TTL_HOURS = 24;

export function parsePreviewLinkTtl(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return DEFAULT_PREVIEW_LINK_TTL_HOURS;
  const hours = typeof value === 'string' ? Number(value) : value;
  return PREVIEW_LINK_TTLS.some((t) => t.hours === hours) ? (hours as number) : null;
}

export interface ShareableValidation {
  id: string;
  version: number;
  status: string;
}

export type ShareTarget =
  | { kind: 'ok'; versionId: string; version: number }
  | { kind: 'blocked'; status: number; message: string };

const blocked = (message: string): ShareTarget => ({ kind: 'blocked', status: 409, message });

/**
 * Which upload a new share link pins. Only a game waiting for approval is shared this way. The
 * link takes the newest version that passed its checks, else the newest one still being checked
 * (it opens once that passes). A version that failed or errored never opens, so it is not offered.
 * `validations` must be newest first.
 */
export function shareTarget(stage: string, validations: readonly ShareableValidation[]): ShareTarget {
  if (!validations.length) return { kind: 'blocked', status: 404, message: 'Not found' };
  if (stage === 'rejected') return blocked('This game was rejected. Upload a fixed version to share it.');
  if (stage !== 'pending') return blocked('This game is already public. Share its page instead.');
  const pick = validations.find((v) => v.status === 'passed')
    ?? validations.find((v) => v.status === 'queued' || v.status === 'running');
  return pick
    ? { kind: 'ok', versionId: pick.id, version: pick.version }
    : blocked('This version failed its checks. Upload a fixed version to share it.');
}

export function expiresIn(expiresAt: string | number | Date, now = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (!(ms > 0)) return 'Expired';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `Expires in ${minutes} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `Expires in ${Math.round(ms / 86_400_000)} days`;
}
