// Boot validation, fails closed (LLD §2). Missing or invalid values are a
// plain 503 on every request; the log names the key only
// (`invalid_config:<KEY>`). MGA-2 checks the first five keys. MGA-2b adds
// ADMIN_USER_ID (stored lowercase), ADMIN_SUPABASE_URL (https only) and
// ADMIN_SUPABASE_ANON_KEY (non-empty, no whitespace — a space or newline is
// rejected rather than trimmed). PREVIEW_SIGNING_SECRET is a later ticket.

export type AdminConfig = {
  pathSecret: string;
  user: string;
  passwordHash: string;
  databaseUrl: string;
  /** Exact https origin the admin is served from; checked on every POST. */
  origin: string;
  /** Auth user id of the single admin account. */
  adminUserId: string;
  /** https URL of the Supabase project. http is rejected. */
  supabaseUrl: string;
  /** Anon key sent to Auth. Not a secret key. */
  supabaseAnonKey: string;
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
  const origin = env.ADMIN_ORIGIN;
  if (!origin || !isValidOrigin(origin)) {
    return { ok: false, key: 'ADMIN_ORIGIN' };
  }
  const adminUserId = env.ADMIN_USER_ID;
  if (!adminUserId || !isUuid(adminUserId)) {
    return { ok: false, key: 'ADMIN_USER_ID' };
  }
  const supabaseUrl = env.ADMIN_SUPABASE_URL;
  if (!supabaseUrl || !isHttpsUrl(supabaseUrl)) {
    return { ok: false, key: 'ADMIN_SUPABASE_URL' };
  }
  const supabaseAnonKey = env.ADMIN_SUPABASE_ANON_KEY;
  // Whitespace is rejected, not trimmed: a key with a space or newline is not
  // the key, and sending it would fail every Auth call.
  if (!supabaseAnonKey || /\s/.test(supabaseAnonKey)) {
    return { ok: false, key: 'ADMIN_SUPABASE_ANON_KEY' };
  }
  return {
    ok: true,
    config: {
      pathSecret: secret,
      user,
      passwordHash,
      databaseUrl,
      origin,
      adminUserId: adminUserId.toLowerCase(),
      supabaseUrl,
      supabaseAnonKey,
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(raw: string): boolean {
  return UUID_RE.test(raw);
}

function isHttpsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname !== '';
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

function isValidOrigin(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // Exact origin: url.origin === raw rejects a path, trailing slash,
  // query/fragment and userinfo in one comparison. https only.
  if (url.protocol !== 'https:' || url.origin !== raw) return false;
  const host = url.hostname;
  // The admin must never share an origin with the public site.
  return (
    host !== 'meshground.app' &&
    !host.endsWith('.meshground.app') &&
    host !== 'meshgrounds.vercel.app'
  );
}
