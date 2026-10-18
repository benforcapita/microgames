const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * `MG_MANUAL_REVIEW` defaults on. A passed validation stays `pending` until a person
 * sets the stage. Only `0`, `false`, `off`, or `no` turns that off.
 */
export function manualReviewEnabled(raw: string | undefined = process.env.MG_MANUAL_REVIEW): boolean {
  if (raw == null || raw.trim() === '') return true;
  return !OFF.has(raw.trim().toLowerCase());
}
