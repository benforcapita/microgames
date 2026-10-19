// Boot validation, fails closed (LLD §2). AD-2 validates only these four keys;
// later tickets add ADMIN_USER_ID / ADMIN_SUPABASE_* / PREVIEW_SIGNING_SECRET.

export type AdminConfig = {
  pathSecret: string;
  user: string;
  passwordHash: string;
  databaseUrl: string;
  /** Not boot-validated in MGA-2a; POSTs fail closed (403) while absent. */
  origin?: string;
};

export type ConfigResult = { ok: true; config: AdminConfig } | { ok: false; key: string };

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): ConfigResult {
  const secret = env.ADMIN_PATH_SECRET;
  if (!secret || secret.length < 32 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    return { ok: false, key: 'ADMIN_PATH_SECRET' };
  }
  const user = env.ADMIN_USER;
  if (!user) return { ok: false, key: 'ADMIN_USER' };
  const passwordHash = env.ADMIN_PASSWORD_HASH;
  if (!passwordHash || !(passwordHash.startsWith('$argon2id$') || passwordHash.startsWith('$2b$'))) {
    return { ok: false, key: 'ADMIN_PASSWORD_HASH' };
  }
  const databaseUrl = env.ADMIN_DATABASE_URL;
  if (!databaseUrl || !isValidDatabaseUrl(databaseUrl)) {
    return { ok: false, key: 'ADMIN_DATABASE_URL' };
  }
  return {
    ok: true,
    config: { pathSecret: secret, user, passwordHash, databaseUrl, origin: env.ADMIN_ORIGIN },
  };
}

function isValidDatabaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // User: exactly `meshgrounds_admin`, or the pooler form
  // `meshgrounds_admin.<project-ref>` where ref is ^[a-z0-9]{20}$.
  return (
    (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
    /^meshgrounds_admin(\.[a-z0-9]{20})?$/.test(url.username)
  );
}
