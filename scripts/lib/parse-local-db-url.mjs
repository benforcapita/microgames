export function parseLocalDbUrl(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    return null;
  }
  const schemeEnd = raw.indexOf('://');
  if (schemeEnd === -1) {
    return null;
  }
  const rest = raw.slice(schemeEnd + 3);
  const delimIdx = rest.search(/[/?#]/);
  const authority = delimIdx === -1 ? rest : rest.slice(0, delimIdx);
  if (authority.includes(',')) {
    return null;
  }
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
    return null;
  }
  try {
    return {
      host: u.hostname,
      port: Number(u.port || 5432),
      database: decodeURIComponent(u.pathname.slice(1)) || 'postgres',
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } catch {
    return null;
  }
}
