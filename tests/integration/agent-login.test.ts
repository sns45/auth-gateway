import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { splitSetCookieHeader } from 'better-auth/cookies';
import { betterAuth } from 'better-auth';
import app from '@/index';
import { createAuth } from '@/auth';
import { AGENT_SESSION_MARKER } from '@/agent-login';
import { createSqliteD1 } from '../helpers/sqlite-d1';

const ORIGIN = 'https://platform.example.com';
const TOKEN = 'agent-token-that-is-at-least-32-characters';
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
    AUTH_ALLOWED_DOMAINS: 'prcpnt.com',
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    LOG_LEVEL: 'error',
    AGENT_LOGIN_ENABLED: 'true',
    AGENT_LOGIN_EMAIL: 'agent@prcpnt.com',
    AGENT_LOGIN_TOKEN: TOKEN,
  };
});

afterEach(() => db.close());

function signIn(token: string | null = TOKEN, body: unknown = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.request(`${ORIGIN}/api/auth/agent/sign-in`, { method: 'POST', headers, body: JSON.stringify(body) }, env);
}

const cookieFrom = (response: Response) =>
  splitSetCookieHeader(response.headers.get('set-cookie') ?? '').map(cookie => cookie.split(';')[0]).join('; ');

/** An ordinary signed in person, minted the way the other integration tests do. */
async function personCookie(email: string) {
  const auth = betterAuth({ ...createAuth(env).options, database: db.raw, emailAndPassword: { enabled: true } });
  const response = await auth.api.signUpEmail({
    body: { email, password: 'test-password-long-enough', name: 'Person' },
    asResponse: true,
  });
  db.raw.prepare('UPDATE user SET emailVerified = 1 WHERE email = ?').run(email);
  return cookieFrom(response);
}

function session(cookie: string, path = 'get-session') {
  return app.request(`${ORIGIN}/api/auth/${path}`, { headers: { cookie, origin: ORIGIN } }, env);
}

describe('agent sign in', () => {
  test('mints a verified agent session that the ordinary session routes accept', async () => {
    const response = await signIn();
    expect(response.status).toBe(200);
    const cookie = cookieFrom(response);
    expect(cookie).toContain('better-auth.session_token=');

    const ordinary = await session(cookie);
    expect(ordinary.status).toBe(200);
    const body = await ordinary.json() as any;
    expect(body.user.email).toBe('agent@prcpnt.com');
    expect(body.user.emailVerified).toBe(true);
    expect((await session(cookie, 'administrator-session')).status).toBe(200);
  });

  test('caps the agent session at one hour', async () => {
    await signIn();
    const row = db.raw.prepare('SELECT expiresAt FROM session').get() as { expiresAt: string | number };
    const remaining = new Date(row.expiresAt).getTime() - Date.now();
    expect(remaining).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(remaining).toBeGreaterThan(55 * 60 * 1000);
  });

  test('stays capped after the ordinary session routes are read, instead of sliding to a day', async () => {
    const cookie = cookieFrom(await signIn());
    // Pretend the session is older than updateAge, which makes Better Auth
    // refresh an ordinary session to a full day on the next read.
    db.raw.prepare('UPDATE session SET updatedAt = ?').run(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    for (const path of ['get-session', 'administrator-session']) expect((await session(cookie, path)).status).toBe(200);
    const row = db.raw.prepare('SELECT expiresAt FROM session').get() as { expiresAt: string | number };
    expect(new Date(row.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  test('stays capped when the client drops the dont remember cookie', async () => {
    const onlyToken = cookieFrom(await signIn()).split('; ').filter(c => c.includes('session_token')).join('; ');
    db.raw.prepare('UPDATE session SET updatedAt = ?').run(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    for (const path of ['get-session', 'administrator-session']) {
      const response = await session(onlyToken, path);
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    const row = db.raw.prepare('SELECT expiresAt FROM session').get() as { expiresAt: string | number };
    expect(new Date(row.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  test('marks agent sessions so they can be found without the email', async () => {
    await signIn();
    expect(db.raw.prepare('SELECT userAgent FROM session').get()).toEqual({ userAgent: AGENT_SESSION_MARKER });
  });

  test('ends an agent session older than an hour even if its expiry was moved', async () => {
    const cookie = cookieFrom(await signIn());
    db.raw.prepare('UPDATE session SET createdAt = ?, expiresAt = ?').run(
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
    );
    expect((await session(cookie, 'administrator-session')).status).toBe(401);
    expect(await (await session(cookie)).json()).toBeNull();
    expect((db.raw.prepare('SELECT count(*) AS n FROM session').get() as any).n).toBe(0);
  });

  test.each([
    ['the flag turns off', { AGENT_LOGIN_ENABLED: 'false' }],
    ['the flag turns off and the email changes', { AGENT_LOGIN_ENABLED: 'false', AGENT_LOGIN_EMAIL: 'other@prcpnt.com' }],
    ['the whole configuration is removed', { AGENT_LOGIN_ENABLED: undefined, AGENT_LOGIN_EMAIL: undefined, AGENT_LOGIN_TOKEN: undefined }],
  ])('refuses and deletes an issued agent session once %s, with no delete step', async (_, override) => {
    const cookie = cookieFrom(await signIn());
    Object.assign(env, override);
    expect((await session(cookie, 'administrator-session')).status).toBe(401);
    expect(await (await session(cookie)).json()).toBeNull();
    expect((db.raw.prepare('SELECT count(*) AS n FROM session').get() as any).n).toBe(0);
  });

  test('leaves ordinary sessions alone, including their refresh', async () => {
    const person = await personCookie('person@prcpnt.com');
    db.raw.prepare('UPDATE session SET updatedAt = ?').run(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    env.AGENT_LOGIN_ENABLED = 'false';
    const response = await session(person, 'administrator-session');
    expect(response.status).toBe(200);
    const row = db.raw.prepare('SELECT expiresAt FROM session').get() as { expiresAt: string | number };
    expect(new Date(row.expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  test('refuses when the configured email belongs to someone who signs in with a provider', async () => {
    await personCookie('agent@prcpnt.com');
    db.raw.prepare("INSERT INTO account (id, issuer, accountId, providerId, userId, createdAt, updatedAt) SELECT 'a1', 'https://accounts.google.com', 'g1', 'google', id, createdAt, updatedAt FROM user").run();
    db.raw.prepare('DELETE FROM session').run();
    const response = await signIn();
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((db.raw.prepare('SELECT count(*) AS n FROM session').get() as any).n).toBe(0);
  });

  test('reuses the same agent user on later sign ins', async () => {
    await signIn();
    await signIn();
    expect((db.raw.prepare('SELECT count(*) AS n FROM user').get() as any).n).toBe(1);
    expect((db.raw.prepare('SELECT count(*) AS n FROM session').get() as any).n).toBe(2);
  });

  test.each([[null], ['wrong-token-that-is-at-least-32-characters'], ['']])('rejects token %s without creating anything', async token => {
    const response = await signIn(token);
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((db.raw.prepare('SELECT count(*) AS n FROM user').get() as any).n).toBe(0);
  });

  test('ignores an email in the body, so it can never sign in as a person', async () => {
    const response = await signIn(TOKEN, { email: 'person@prcpnt.com' });
    const body = await (await session(cookieFrom(response))).json() as any;
    expect(body.user.email).toBe('agent@prcpnt.com');
    expect(db.raw.prepare("SELECT count(*) AS n FROM user WHERE email = 'person@prcpnt.com'").get()).toEqual({ n: 0 });
  });

  test.each([
    ['the flag is off', { AGENT_LOGIN_ENABLED: 'false' }],
    ['the flag is missing', { AGENT_LOGIN_ENABLED: undefined }],
    ['the token is short', { AGENT_LOGIN_TOKEN: 'short' }],
    ['the token is missing', { AGENT_LOGIN_TOKEN: undefined }],
    ['the email is missing', { AGENT_LOGIN_EMAIL: undefined }],
  ])('does not exist when %s', async (_, override) => {
    Object.assign(env, override);
    const response = await signIn(env.AGENT_LOGIN_TOKEN ?? TOKEN);
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test('refuses to start when the agent email is outside the allowed domains', async () => {
    env.AGENT_LOGIN_EMAIL = 'agent@elsewhere.com';
    const response = await signIn();
    expect(response.status).toBe(404);
  });

  test('a session minted while enabled stops working once its rows are deleted', async () => {
    const cookie = cookieFrom(await signIn());
    db.raw.prepare("DELETE FROM session WHERE userId IN (SELECT id FROM user WHERE email = 'agent@prcpnt.com')").run();
    const body = await (await session(cookie)).json();
    expect(body).toBeNull();
  });
});
