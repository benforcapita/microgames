// SP-6: short-lived preview tokens that let a game's OWNER load their own pending/rejected bundle from the
// cookieless CDN. Minted by the portal (only for the owner's /play of their own game) and verified by the
// CDN; both read the shared secret CDN_PREVIEW_SECRET. Token = `<exp>.<sig>`, where exp is unix seconds
// and sig = base64url(HMAC-SHA256(secret, "mg-preview-v1:<gameId>:<exp>")). No secret -> nothing mints or verifies.
import crypto from 'node:crypto';

export const PREVIEW_MAX_TTL_S = 600; // tokens may never claim more than 10 minutes of validity

const sign = (secret, gameId, exp) => crypto.createHmac('sha256', secret).update(`mg-preview-v1:${gameId}:${exp}`).digest('base64url');

/** @returns {string | null} */
export function mintPreviewToken(secret, gameId, { ttlS = PREVIEW_MAX_TTL_S, nowS = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret || !gameId) return null;
  const exp = nowS + Math.max(1, Math.min(ttlS, PREVIEW_MAX_TTL_S));
  return `${exp}.${sign(secret, gameId, exp)}`;
}

/** True only for a token minted for this exact game id with the shared secret, unexpired, exp <= now + 10 min. */
export function verifyPreviewToken(secret, gameId, token, nowS = Math.floor(Date.now() / 1000)) {
  if (!secret || !gameId || typeof token !== 'string' || token.length > 200) return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > nowS) || exp - nowS > PREVIEW_MAX_TTL_S) return false;
  const want = Buffer.from(sign(secret, gameId, exp));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
