import crypto from 'node:crypto';

export const PREVIEW_MAX_TTL_S = 600; // tokens may never claim more than 10 minutes of validity

const mac = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');
const sign = (secret, gameId, exp) => mac(secret, `mg-preview-v1:${gameId}:${exp}`);
const signPinned = (secret, gameId, version, exp) => mac(secret, `mg-preview-v1:${gameId}:${version}:${exp}`);

const same = (a, b) => {
  const want = Buffer.from(a);
  const got = Buffer.from(b);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
};

const fresh = (exp, nowS) => exp > nowS && exp - nowS <= PREVIEW_MAX_TTL_S;

/**
 * @param {string} secret
 * @param {string} gameId
 * @param {{ ttlS?: number, nowS?: number, version?: number | null }} [opts]
 * @returns {string | null}
 */
export function mintPreviewToken(secret, gameId, { ttlS = PREVIEW_MAX_TTL_S, nowS = Math.floor(Date.now() / 1000), version = null } = {}) {
  if (!secret || !gameId) return null;
  const exp = nowS + Math.max(1, Math.min(ttlS, PREVIEW_MAX_TTL_S));
  if (version != null) {
    if (!Number.isSafeInteger(version) || version < 1) return null;
    return `${exp}.${version}.${signPinned(secret, gameId, version, exp)}`;
  }
  return `${exp}.${sign(secret, gameId, exp)}`;
}

export function verifyPreviewToken(secret, gameId, token, nowS = Math.floor(Date.now() / 1000)) {
  if (!secret || !gameId || typeof token !== 'string' || token.length > 200) return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!fresh(exp, nowS)) return false;
  return same(sign(secret, gameId, exp), m[2]);
}

export function readPreviewGrant(secret, gameId, token, nowS = Math.floor(Date.now() / 1000)) {
  if (!secret || !gameId || typeof token !== 'string' || token.length > 200) return null;
  const pinned = /^(\d{1,12})\.([1-9]\d*)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (pinned) {
    const exp = Number(pinned[1]);
    const version = Number(pinned[2]);
    if (!fresh(exp, nowS) || !Number.isSafeInteger(version)) return null;
    if (!same(signPinned(secret, gameId, version, exp), pinned[3])) return null;
    return { kind: 'pinned', version };
  }
  return verifyPreviewToken(secret, gameId, token, nowS) ? { kind: 'current' } : null;
}
