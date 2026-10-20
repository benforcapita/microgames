import { sql } from './db';

export type Role = 'user' | 'admin';

export interface Profile {
  id: string;
  handle: string;
  role: Role;
}

export const HANDLE_RE = /^[A-Za-z0-9_-]{2,32}$/;

export const isAdmin = (profile: Pick<Profile, 'role'> | null | undefined): boolean => profile?.role === 'admin';

export async function getProfile(userId: string): Promise<Profile | null> {
  const [row] = await sql<Profile[]>`select id, handle, role from profiles where id = ${userId}`;
  return row ?? null;
}

export async function createProfile(userId: string, handle: string): Promise<{ profile?: Profile; error?: string }> {
  if (!HANDLE_RE.test(handle)) return { error: 'Handles are 2–32 letters, numbers, - or _.' };
  const [taken] = await sql`
    select 1 from profiles where lower(handle) = lower(${handle})
    union all select 1 from games where lower(creator) = lower(${handle}) and owner_id is distinct from ${userId}
    limit 1`;
  if (taken) return { error: `@${handle} is already taken.` };
  try {
    const [profile] = await sql<Profile[]>`
      insert into profiles (id, handle) values (${userId}, ${handle}) returning id, handle, role`;
    return { profile };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return { error: 'You already have a handle, or that one is taken.' };
    throw err;
  }
}
