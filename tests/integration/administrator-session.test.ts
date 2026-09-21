import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { betterAuth } from 'better-auth';
import { splitSetCookieHeader } from 'better-auth/cookies';
import app from '@/index';
import { createAuth } from '@/auth';
import { createSqliteD1 } from '../helpers/sqlite-d1';

const ORIGIN = 'https://platform.example.com';
let db: ReturnType<typeof createSqliteD1>;
let env: any;

beforeEach(() => {
  db = createSqliteD1(readFileSync(new URL('../../migrations/0001_better_auth.sql', import.meta.url), 'utf8'));
  env = {
    AUTH_DB: db,
    AUTH_STORE: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    NODE_ENV: 'production',
    OAUTH_BASE_URL: ORIGIN,
    ALLOWED_ORIGINS: ORIGIN,
    AUTH_ALLOWED_DOMAINS: 'prcpnt.com,lattiq.com',
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    LOG_LEVEL: 'error',
  };
});

afterEach(() => db.close());

async function sessionCookie(email: string, verified = true) {
  const auth = betterAuth({ ...createAuth(env).options, database: db.raw, emailAndPassword: { enabled: true } });
  const response = await auth.api.signUpEmail({
    body: { email, password: 'test-password-long-enough', name: 'Person' },
    asResponse: true,
  });
  if (verified) db.raw.prepare('UPDATE user SET emailVerified = 1 WHERE email = ?').run(email);
  return splitSetCookieHeader(response.headers.get('set-cookie') ?? '').map(cookie => cookie.split(';')[0]).join('; ');
}

function readSession(cookie = '', path = 'administrator-session') {
  return app.request(`${ORIGIN}/api/auth/${path}`, { headers: { cookie, origin: ORIGIN } }, env);
}

describe('administrator session', () => {
  test.each(['person@prcpnt.com', 'person@lattiq.com'])('permits the verified administrator %s with the ordinary session shape', async email => {
    const cookie = await sessionCookie(email);
    const ordinary = await readSession(cookie, 'get-session');
    const administrator = await readSession(cookie);
    expect(administrator.status).toBe(200);
    expect(administrator.headers.get('cache-control')).toBe('private, no-store');
    expect(await administrator.json()).toEqual(await ordinary.json());
    expect(env.AUTH_STORE.get).not.toHaveBeenCalled();
    expect(env.AUTH_STORE.put).not.toHaveBeenCalled();
  });

  test.each(['person@prcpnt.com', 'person@lattiq.com'])('denies an unverified email %s without blocking generic authentication', async email => {
    const cookie = await sessionCookie(email, false);
    const denied = await readSession(cookie);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('cache-control')).toBe('private, no-store');
    const ordinary = await readSession(cookie, 'get-session');
    expect(ordinary.status).toBe(200);
    expect((await ordinary.json() as any).user.email).toBe(email);
  });

  test.each(['person@elsewhere.com', 'person@sub.prcpnt.com', 'person@evilprcpnt.com'])('denies outside address %s without changing generic sessions', async email => {
    const cookie = await sessionCookie(email);
    expect((await readSession(cookie)).status).toBe(403);
    const ordinary = await readSession(cookie, 'get-session');
    expect(ordinary.status).toBe(200);
    expect((await ordinary.json() as any).user.email).toBe(email);
  });

  test.each([undefined, '', 'prcpnt.com,', '*.prcpnt.com', 'prcpnt.com,https://lattiq.com'])('denies missing or malformed policy %s without changing generic sessions', async policy => {
    const cookie = await sessionCookie('person@prcpnt.com');
    env.AUTH_ALLOWED_DOMAINS = policy;
    expect((await readSession(cookie)).status).toBe(403);
    const ordinary = await readSession(cookie, 'get-session');
    expect(ordinary.status).toBe(200);
    expect((await ordinary.json() as any).user.email).toBe('person@prcpnt.com');
  });

  test.each(['', '__Secure-better-auth.session_token=forged'])('rejects an absent or invalid session', async cookie => {
    const response = await readSession(cookie);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  test('rejects database revocation on the next request', async () => {
    const cookie = await sessionCookie('person@prcpnt.com');
    expect((await readSession(cookie)).status).toBe(200);
    db.raw.prepare('DELETE FROM session').run();
    const response = await readSession(cookie);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  test('reads changes to verification on the next request', async () => {
    const cookie = await sessionCookie('person@lattiq.com');
    expect((await readSession(cookie)).status).toBe(200);
    db.raw.prepare('UPDATE user SET emailVerified = 0').run();
    expect((await readSession(cookie)).status).toBe(403);
  });

  test.each([
    ['person@prcpnt.com', 200],
    ['person@elsewhere.com', 403],
  ])('forwards an aged session renewal cookie for %s', async (email, status) => {
    env.COOKIE_DOMAIN = 'platform.example.com';
    const cookie = await sessionCookie(email as string);
    const oldExpiry = Date.now() + 60 * 60 * 1000;
    db.raw.prepare('UPDATE session SET expiresAt = ?, updatedAt = ?').run(
      new Date(oldExpiry).toISOString(),
      new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
    );
    const response = await readSession(cookie);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const renewal = splitSetCookieHeader(response.headers.get('set-cookie') ?? '')
      .find(value => value.startsWith('__Secure-better-auth.session_token='));
    expect(renewal).toBeDefined();
    expect(renewal).toContain('Max-Age=86400');
    expect(renewal).toContain('Domain=platform.example.com');
    expect(renewal).toContain('Path=/');
    expect(renewal).toContain('Secure');
    expect(renewal).toContain('HttpOnly');
    const row = db.raw.prepare('SELECT expiresAt FROM session').get();
    expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(oldExpiry);
  });

  test('forwards every clearing cookie for an expired session', async () => {
    env.COOKIE_DOMAIN = 'platform.example.com';
    const cookie = await sessionCookie('person@lattiq.com');
    db.raw.prepare('UPDATE session SET expiresAt = ?').run(new Date(Date.now() - 1000).toISOString());
    const response = await readSession(cookie);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const clearing = splitSetCookieHeader(response.headers.get('set-cookie') ?? '');
    for (const name of ['session_token', 'session_data', 'dont_remember']) {
      const cleared = clearing.find(value => value.startsWith(`__Secure-better-auth.${name}=`));
      expect(cleared).toBeDefined();
      expect(cleared).toContain('Max-Age=0');
      expect(cleared).toContain('Domain=platform.example.com');
      expect(cleared).toContain('Path=/');
      expect(cleared).toContain('Secure');
      expect(cleared).toContain('HttpOnly');
    }
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM session').get().count).toBe(0);
  });
});
