// Runtime users for the local Auth stack. Passwords and TOTP secrets are
// generated here and never printed. The admin API key is the local stack's,
// and only a loopback URL is accepted.

import { randomBytes } from 'node:crypto';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { assertLoopbackUrl, type LocalStack } from './loopback.ts';
import { totpWindow } from './totp.ts';

export type SeededUser = {
  id: string;
  email: string;
  password: string;
};

export async function createConfirmedUser(stack: LocalStack): Promise<SeededUser> {
  assertLoopbackUrl(stack.apiUrl);
  const password = randomBytes(24).toString('base64url');
  const email = `mga-${randomBytes(6).toString('hex')}@example.test`;
  const res = await fetch(`${stack.apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: stack.secretKey,
      authorization: `Bearer ${stack.secretKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`create user failed (${res.status})`);
  const body = (await res.json()) as { id?: unknown };
  if (typeof body.id !== 'string') throw new Error('create user failed');
  return { id: body.id, email, password };
}

export async function deleteUser(stack: LocalStack, id: string): Promise<void> {
  assertLoopbackUrl(stack.apiUrl);
  await fetch(`${stack.apiUrl}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: {
      apikey: stack.secretKey,
      authorization: `Bearer ${stack.secretKey}`,
    },
  });
}

export function memoryClient(stack: LocalStack): SupabaseClient {
  assertLoopbackUrl(stack.apiUrl);
  return createClient(stack.apiUrl, stack.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signIn(client: SupabaseClient, user: SeededUser): Promise<Session> {
  const { data, error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error || !data.session) throw new Error(`sign-in failed (${error?.status ?? 'unknown'})`);
  return data.session;
}

export async function aal1Session(stack: LocalStack, user: SeededUser): Promise<Session> {
  return signIn(memoryClient(stack), user);
}

// Enroll a TOTP factor and verify it. The returned session is AAL2.
// A later password sign-in is AAL1 on a user that already has the factor.
export async function enrollVerifiedTotp(stack: LocalStack, user: SeededUser): Promise<Session> {
  const client = memoryClient(stack);
  await signIn(client, user);
  const enrolled = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'test' });
  if (enrolled.error || !enrolled.data?.totp?.secret || !enrolled.data.id) {
    throw new Error(`enroll failed (${enrolled.error?.status ?? 'unknown'})`);
  }
  const secret = enrolled.data.totp.secret;
  const factorId = enrolled.data.id;
  let lastStatus = 'unknown';
  for (const code of totpWindow(secret)) {
    const challenge = await client.auth.mfa.challenge({ factorId });
    if (challenge.error || !challenge.data) {
      lastStatus = String(challenge.error?.status ?? 'unknown');
      continue;
    }
    const verified = await client.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code,
    });
    // verify() returns the new tokens directly. It does not wrap them in `session`.
    const data = verified.data;
    if (data?.access_token && data.refresh_token && data.user) {
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
        token_type: data.token_type,
        user: data.user,
      };
    }
    lastStatus = String(verified.error?.status ?? 'unknown');
  }
  throw new Error(`totp verify failed (${lastStatus})`);
}
