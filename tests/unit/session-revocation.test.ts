/**
 * Revocation is immediate, asserted against Better Auth on real SQLite.
 *
 * The gateway previously stored sessions in Cloudflare KV, which is eventually
 * consistent: a logout took up to 60 seconds to reach every colo, so a revoked
 * session kept authenticating. These tests pin the property that fixes it, and
 * guard the two Better Auth settings that would quietly undo it.
 *
 * Better Auth accepts a node:sqlite database directly, the same way it accepts
 * a D1 binding, and resolves both to its sqlite dialect. So these run the real
 * library against the real migration file.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { betterAuth } from 'better-auth';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Vite bundled with Vitest 2 does not treat node:sqlite as a builtin.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => any;
};

const MIGRATION = fileURLToPath(new URL('../../migrations/0001_better_auth.sql', import.meta.url));

const credentials = {
  email: 'someone@example.com',
  password: 'correct-horse-battery-staple',
  name: 'Someone',
};

let db: any;
let auth: ReturnType<typeof betterAuth>;

function makeAuth(database: any) {
  return betterAuth({
    database,
    baseURL: 'https://auth.example.com',
    secret: 'test-secret-that-is-at-least-32-characters-long',
    emailAndPassword: { enabled: true },
    session: { expiresIn: 60 * 60 * 24 },
  });
}

/** Sign up, and return the Cookie header a browser would send back. */
async function signUpAndGetCookie(): Promise<string> {
  const response = await auth.api.signUpEmail({ body: credentials, asResponse: true });
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('sign up did not set a session cookie');
  return setCookie
    .split(/,(?=[^;]+=[^;]+)/)
    .map((c) => c.split(';')[0].trim())
    .join('; ');
}

const withCookie = (cookie: string) => new Headers({ cookie });

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(MIGRATION, 'utf8'));
  auth = makeAuth(db);
});

afterEach(() => {
  db.close();
});

describe('revocation', () => {
  test('a signed out session is rejected on the very next read', async () => {
    const cookie = await signUpAndGetCookie();
    expect(await auth.api.getSession({ headers: withCookie(cookie) })).not.toBeNull();

    await auth.api.signOut({ headers: withCookie(cookie) });

    // No sleep, no retry, no propagation window.
    expect(await auth.api.getSession({ headers: withCookie(cookie) })).toBeNull();
  });

  test('a session revoked directly in the database is rejected on the very next read', async () => {
    // Models revocation from somewhere other than this request: an admin, a
    // password change, another device.
    const cookie = await signUpAndGetCookie();
    expect(await auth.api.getSession({ headers: withCookie(cookie) })).not.toBeNull();

    db.prepare('DELETE FROM session').run();

    expect(await auth.api.getSession({ headers: withCookie(cookie) })).toBeNull();
  });

  test('revoking one session leaves the user other sessions', async () => {
    const first = await signUpAndGetCookie();
    const secondResponse = await auth.api.signInEmail({
      body: { email: credentials.email, password: credentials.password },
      asResponse: true,
    });
    const second = (secondResponse.headers.get('set-cookie') ?? '')
      .split(/,(?=[^;]+=[^;]+)/)
      .map((c) => c.split(';')[0].trim())
      .join('; ');

    await auth.api.signOut({ headers: withCookie(first) });

    expect(await auth.api.getSession({ headers: withCookie(first) })).toBeNull();
    expect(await auth.api.getSession({ headers: withCookie(second) })).not.toBeNull();
  });
});

describe('configuration that would reopen the revocation window', () => {
  test('no secondary storage is configured', () => {
    // Better Auth's findSession checks secondaryStorage first and short
    // circuits the database on a hit. Backed by KV, that serves a revoked
    // session from a stale colo for up to 60 seconds.
    expect(auth.options.secondaryStorage).toBeUndefined();
  });

  test('cookie cache is not enabled', () => {
    // Cookie cache keeps the session in a signed cookie on the client. The
    // server cannot delete a cookie held on someone else's device, so a
    // revoked session stays live until it expires.
    expect(auth.options.session?.cookieCache?.enabled).toBeFalsy();
  });
});

describe('session lifecycle', () => {
  test('a fresh session resolves to its user', async () => {
    const cookie = await signUpAndGetCookie();

    const result = await auth.api.getSession({ headers: withCookie(cookie) });

    expect(result?.user.email).toBe(credentials.email);
    expect(result?.session.token).toBeTruthy();
  });

  test('an unknown session token reads as null', async () => {
    expect(
      await auth.api.getSession({ headers: withCookie('better-auth.session_token=nope') })
    ).toBeNull();
  });
});
