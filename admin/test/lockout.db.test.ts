import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { connect, createLockoutStore } from '../src/lib/db.ts';
import type { LockoutStore, PasswordVerifier } from '../src/lib/auth-basic.ts';
import { runRequest, testEnv, basicAuth, TEST_SECRET, TEST_PASSWORD } from './helpers.ts';

const DB_URL = process.env.DATABASE_URL;
const GOOD = { authorization: basicAuth('boss', TEST_PASSWORD) };
const BAD = { authorization: basicAuth('boss', 'wrong-password') };

// CTO answer 5, choice (a): for LOCAL tests only, the suite enables LOGIN on
// meshgrounds_admin with a password generated at runtime (never printed or
// committed) so the app's db.ts connects through the real grants. Teardown
// restores NOLOGIN + password null, exactly MGA-1's state.
describe('basic-auth lockout via admin_auth_failures (local DB)', { skip: !DB_URL && 'DATABASE_URL not set' }, () => {
  let superuser: postgres.Sql;
  let adminUrl = '';
  let sqlA: postgres.Sql;
  let sqlB: postgres.Sql;
  let storeA: LockoutStore;
  let storeB: LockoutStore;

  before(async () => {
    superuser = postgres(DB_URL as string, { max: 1 });
    const rolePassword = randomBytes(24).toString('hex');
    await superuser.unsafe(`alter role meshgrounds_admin login password '${rolePassword}'`);
    const url = new URL(DB_URL as string);
    url.username = 'meshgrounds_admin';
    url.password = rolePassword;
    adminUrl = url.toString();
    // Two independent "function instances": each gets its own postgres.js
    // client created through src/lib/db.ts, sharing only the database.
    sqlA = connect(adminUrl);
    sqlB = connect(adminUrl);
    storeA = createLockoutStore(sqlA);
    storeB = createLockoutStore(sqlB);
    await superuser`delete from public.admin_auth_failures`;
  });

  after(async () => {
    await superuser`delete from public.admin_auth_failures`;
    await superuser.unsafe('alter role meshgrounds_admin nologin password null');
    await Promise.allSettled([sqlA?.end({ timeout: 2 }), sqlB?.end({ timeout: 2 }), superuser?.end()]);
  });

  beforeEach(async () => {
    await superuser`delete from public.admin_auth_failures`;
  });

  const env = () => testEnv({ ADMIN_DATABASE_URL: adminUrl });
  const hit = (store: LockoutStore, request: Request, verify?: PasswordVerifier) =>
    runRequest(request, env(), { store, verify });
  const failureCount = async () =>
    Number((await superuser`select count(*) as n from public.admin_auth_failures`)[0].n);
  const remainingFromDb = async () =>
    Number(
      (
        await superuser`select extract(epoch from (
          (select created_at from public.admin_auth_failures
           where created_at > now() - interval '15 minutes'
           order by created_at desc offset 4 limit 1) + interval '15 minutes' - now()
        )) as remaining`
      )[0].remaining,
    );

  it('five failures through instance A lock out instance B', async () => {
    for (let i = 0; i < 5; i++) {
      const { response } = await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }));
      assert.equal(response.status, 401, `failure ${i + 1}`);
    }
    assert.equal(await failureCount(), 5);

    const { response } = await hit(storeB, new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.equal(response.headers.get('www-authenticate'), null);
    const retryAfter = Number(response.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 900, `retry-after=${retryAfter}`);
    // Instance A sees the same lock; a lock blocks requests with no creds too.
    const again = await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`));
    assert.equal(again.response.status, 429);
  });

  it('during a lock the hash is not run and no failure row is added', async () => {
    for (let i = 0; i < 5; i++) {
      await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }));
    }
    const before5 = await failureCount();
    let verifyCalls = 0;
    const counting: PasswordVerifier = async () => (verifyCalls++, false);
    // The correct password still gets 429 through the other instance.
    const { response } = await hit(storeB, new Request(`http://localhost/${TEST_SECRET}`, { headers: GOOD }), counting);
    assert.equal(response.status, 429);
    assert.equal(verifyCalls, 0, 'password verify must not run during a lock');
    assert.equal(await failureCount(), before5, 'a locked request must not add a row');
  });

  it('the lock lifts when the failures age past 15 minutes', async () => {
    for (let i = 0; i < 5; i++) {
      await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }));
    }
    await superuser`update public.admin_auth_failures set created_at = now() - interval '16 minutes'`;
    const { response } = await hit(storeB, new Request(`http://localhost/${TEST_SECRET}`, { headers: GOOD }));
    assert.equal(response.status, 200);
    assert.equal(await failureCount(), 0, 'the successful login cleared the rows');
  });

  it('a correct login outside a lock deletes all failure rows', async () => {
    await superuser`insert into public.admin_auth_failures (created_at)
      select now() - interval '1 minute' from generate_series(1, 3)`;
    const { response } = await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`, { headers: GOOD }));
    assert.equal(response.status, 200);
    assert.equal(await failureCount(), 0);
  });

  it('each recorded failure also deletes rows older than one hour', async () => {
    await superuser`insert into public.admin_auth_failures (created_at)
      values (now() - interval '61 minutes'), (now() - interval '2 hours')`;
    const { response } = await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }));
    assert.equal(response.status, 401);
    const rows = await superuser`select created_at from public.admin_auth_failures`;
    assert.equal(rows.length, 1, 'only the fresh row remains');
    assert.ok(Date.now() - (rows[0].created_at as Date).getTime() < 60_000, 'the surviving row is the new one');
  });

  it('failure rows carry only id and created_at — no username, IP or agent', async () => {
    const { response } = await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }));
    assert.equal(response.status, 401);
    const rows = await superuser`select * from public.admin_auth_failures`;
    assert.deepEqual(Object.keys(rows[0]).sort(), ['created_at', 'id']);
    assert.ok(rows[0].created_at instanceof Date);
  });

  it('Retry-After is the ceil of the lock seconds left on the DB clock', async () => {
    // Five rows 14 minutes old: the lock has ~60 seconds left.
    await superuser`insert into public.admin_auth_failures (created_at)
      select now() - interval '14 minutes' from generate_series(1, 5)`;
    const expected = await remainingFromDb();
    const { response } = await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }));
    assert.equal(response.status, 429);
    const retryAfter = Number(response.headers.get('retry-after'));
    assert.ok(Math.abs(retryAfter - Math.ceil(expected)) <= 1, `retry-after=${retryAfter} vs remaining=${expected}`);
  });

  it('the fifth failure inside the window starts the lock', async () => {
    // Four in-window rows: not yet locked.
    await superuser`insert into public.admin_auth_failures (created_at)
      select now() - interval '1 minute' from generate_series(1, 4)`;
    const bad = await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }));
    assert.equal(bad.response.status, 401);
    const { response } = await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }));
    assert.equal(response.status, 429);
  });

  it('out-of-window rows do not count toward the lock', async () => {
    // Four stale rows + one fresh: below the threshold inside the window.
    await superuser`insert into public.admin_auth_failures (created_at)
      select now() - interval '16 minutes' from generate_series(1, 4)`;
    await superuser`insert into public.admin_auth_failures (created_at) values (now() - interval '1 minute')`;
    const { response } = await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }));
    assert.equal(response.status, 401, 'one fresh failure is not a lock');
    // That failure brings the in-window count to 2 — still not locked.
    const again = await hit(storeA, new Request(`http://localhost/${TEST_SECRET}`, { headers: GOOD }));
    assert.equal(again.response.status, 200);
  });

  describe('role behaviour as meshgrounds_admin', () => {
    // Connect as the superuser and borrow the role inside a rolled-back
    // transaction, per the ticket: begin; set local role; assert; rollback.
    const asRole = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
      superuser.begin(async (tx) => {
        await tx`set local role meshgrounds_admin`;
        return fn(tx);
      });
    const denied = async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) => {
      const err = await asRole(fn).then(
        () => null,
        (e) => e as { code?: string },
      );
      assert.equal(err?.code, '42501', `expected insufficient_privilege, got ${JSON.stringify(err)}`);
    };

    it('can select, insert and delete admin_auth_failures', async () => {
      await asRole(async (tx) => {
        const [r] = await tx`insert into public.admin_auth_failures default values returning id`;
        assert.ok(r.id);
        const [c] = await tx`select count(*) as n from public.admin_auth_failures`;
        assert.ok(Number(c.n) >= 1);
        await tx`delete from public.admin_auth_failures`;
      });
      assert.equal(await failureCount(), 0, 'the transaction left the table as found');
    });

    it('can select public.games (the admin read grant)', async () => {
      const rows = await asRole((tx) => tx`select id from public.games limit 1`);
      assert.ok(Array.isArray(rows));
    });

    it('cannot select from auth.users', () => denied((tx) => tx`select count(*) from auth.users`));
    it('cannot select public.saves', () => denied((tx) => tx`select count(*) from public.saves`));
    it('cannot insert into public.games', () =>
      denied((tx) => tx`insert into public.games (slug, title) values ('x', 'x')`));
    it('cannot delete from public.sessions', () => denied((tx) => tx`delete from public.sessions`));
    it('cannot update profiles', () => denied((tx) => tx`update public.profiles set id = id`));
  });
});
