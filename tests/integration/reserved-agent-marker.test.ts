import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { betterAuth } from 'better-auth';
import { splitSetCookieHeader } from 'better-auth/cookies';
import app from '@/index';
import { createAuth } from '@/auth';
import { AGENT_SESSION_MARKER } from '@/agent-session-marker';
import { createSqliteD1 } from '../helpers/sqlite-d1';

const ORIGIN = 'https://platform.example.com';
const TOKEN = 'agent-token-that-is-at-least-32-characters';
const PROVIDER_TOKEN = 'fixture-google-token';
const MARKER_VARIANTS = [
  AGENT_SESSION_MARKER,
  'AUTH-GATEWAY AGENT-LOGIN',
  '  auth-gateway agent-login  ',
  'auth-gateway   agent-login',
  'auth-gateway\tagent-login',
  '\tAuth-Gateway \t Agent-Login\t',
];
let db: ReturnType<typeof createSqliteD1>;
let env: any;

beforeEach(() => {
  db = createSqliteD1(readFileSync(new URL('../../migrations/0001_better_auth.sql', import.meta.url), 'utf8'));
  env = {
    AUTH_DB: db,
    AUTH_STORE: { get: async () => null, put: async () => {} },
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
    AGENT_LOGIN_NAMES: 'build.1',
  };
});

afterEach(() => db.close());

const cookieFrom = (response: Response) =>
  splitSetCookieHeader(response.headers.get('set-cookie') ?? '').map(cookie => cookie.split(';')[0]).join('; ');

async function providerSession(userAgent: string) {
  const options = createAuth(env).options;
  const profile = {
    sub: 'provider-person',
    name: 'Person',
    email: 'person@prcpnt.com',
    email_verified: true,
    picture: 'https://platform.example.com/avatar.png',
  };
  const auth = betterAuth({
    ...options,
    socialProviders: {
      google: {
        ...options.socialProviders.google,
        verifyIdToken: async token => token === PROVIDER_TOKEN,
        getUserInfo: async tokens => tokens.idToken === PROVIDER_TOKEN ? {
          user: { name: profile.name, email: profile.email, emailVerified: true, image: profile.picture },
          data: profile,
        } : null,
      },
    },
  });
  const response = await auth.api.signInSocial({
    body: { provider: 'google', idToken: { token: PROVIDER_TOKEN } },
    headers: new Headers({ origin: ORIGIN, 'user-agent': userAgent }),
    asResponse: true,
  });
  expect(response.status).toBe(200);
  expect(db.raw.prepare('SELECT providerId, issuer FROM account').get()).toEqual({
    providerId: 'google', issuer: 'https://accounts.google.com',
  });
  const cookie = cookieFrom(response);
  expect(cookie).toContain('better-auth.session_token=');
  return { auth, cookie };
}

function call(cookie: string, path: string) {
  return app.request(`${ORIGIN}/api/auth/${path}`, { headers: { cookie, origin: ORIGIN } }, env);
}

function storedSession() {
  return db.raw.prepare('SELECT token, userAgent, expiresAt, updatedAt FROM session').get() as {
    token: string;
    userAgent: string | null;
    expiresAt: string | number;
    updatedAt: string | number;
  };
}

describe('reserved agent marker on session creation', () => {
  test.each(MARKER_VARIANTS)('reserves provider header %j before persistence', async userAgent => {
    await providerSession(userAgent);
    expect(storedSession().userAgent).toBe('reserved');
  });

  test('a provider session with the marker stays unrestricted, refreshes and survives the flag turning off', async () => {
    const { cookie } = await providerSession(AGENT_SESSION_MARKER);
    expect((await call(cookie, 'list-sessions')).status).toBe(200);
    expect((await call(cookie, 'list-accounts')).status).toBe(200);

    const oldExpiry = new Date(Date.now() + 20 * 60 * 60 * 1000);
    const oldUpdatedAt = new Date(Date.now() - 10 * 60 * 1000);
    db.raw.prepare('UPDATE session SET expiresAt = ?, updatedAt = ?').run(
      oldExpiry.toISOString(), oldUpdatedAt.toISOString(),
    );
    const refreshed = await call(cookie, 'get-session');
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ user: { email: 'person@prcpnt.com' } });
    expect(refreshed.headers.get('set-cookie')).toContain('better-auth.session_token=');
    expect(new Date(storedSession().expiresAt).getTime()).toBeGreaterThan(oldExpiry.getTime());
    expect(new Date(storedSession().expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(new Date(storedSession().updatedAt).getTime()).toBeGreaterThan(oldUpdatedAt.getTime());

    env.AGENT_LOGIN_ENABLED = 'false';
    expect((await call(cookie, 'administrator-session')).status).toBe(200);
    expect((await call(cookie, 'list-sessions')).status).toBe(200);
    expect(await (await call(cookie, 'get-session')).json()).toMatchObject({ user: { email: 'person@prcpnt.com' } });
    expect(storedSession().userAgent).toBe('reserved');
    expect(db.raw.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 1 });
  });

  test.each([...MARKER_VARIANTS, '\nauth-gateway\nagent-login\n'])('reserves adapter creation without endpoint context for %j', async userAgent => {
    const { auth } = await providerSession('browser/1.0');
    const { internalAdapter } = await auth.$context;
    const found = await internalAdapter.findUserByEmail('person@prcpnt.com');
    const session = await internalAdapter.createSession(found!.user.id, false, { userAgent });
    expect(session.userAgent).toBe('reserved');
    expect(db.raw.prepare('SELECT userAgent FROM session WHERE token = ?').get(session.token)).toEqual({ userAgent: 'reserved' });
  });

  test.each(['browser/1.0', '', `${AGENT_SESSION_MARKER}/1.0`])('preserves ordinary provider header %j', async userAgent => {
    await providerSession(userAgent);
    expect(storedSession().userAgent).toBe(userAgent);
  });

  test.each([{}, { agent: 'build.1' }])('the agent endpoint keeps its server marker for body %j', async body => {
    const response = await app.request(`${ORIGIN}/api/auth/agent/sign-in`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'user-agent': 'browser/1.0' },
      body: JSON.stringify(body),
    }, env);
    expect(response.status).toBe(200);
    expect(storedSession().userAgent).toBe(AGENT_SESSION_MARKER);
    expect((await call(cookieFrom(response), 'list-sessions')).status).toBe(403);
  });
});

describe('reserved agent marker on session updates', () => {
  test.each([...MARKER_VARIANTS, '\nauth-gateway\nagent-login\n'])('cannot introduce the marker through update %j', async userAgent => {
    const { auth, cookie } = await providerSession('browser/1.0');
    const { internalAdapter } = await auth.$context;
    const expiresAt = new Date(Date.now() + 20 * 60 * 60 * 1000);
    const updated = await internalAdapter.updateSession(storedSession().token, { userAgent, expiresAt });
    expect(updated?.userAgent).toBe('reserved');
    expect(storedSession().userAgent).toBe('reserved');
    expect(new Date(storedSession().expiresAt).getTime()).toBe(expiresAt.getTime());
    expect((await call(cookie, 'list-accounts')).status).toBe(200);
    env.AGENT_LOGIN_ENABLED = 'false';
    expect((await call(cookie, 'administrator-session')).status).toBe(200);
    expect(db.raw.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 1 });
  });

  test.each([null, '', 'browser/2.0', `${AGENT_SESSION_MARKER}/1.0`])('preserves an ordinary update value %j', async userAgent => {
    const { auth } = await providerSession('browser/1.0');
    const { internalAdapter } = await auth.$context;
    const updated = await internalAdapter.updateSession(storedSession().token, { userAgent });
    expect(updated?.userAgent).toBe(userAgent);
    expect(storedSession().userAgent).toBe(userAgent);
  });

  test('an update without a user agent preserves the issued agent marker and restrictions', async () => {
    const response = await app.request(`${ORIGIN}/api/auth/agent/sign-in`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}` },
    }, env);
    expect(response.status).toBe(200);
    const { internalAdapter } = await createAuth(env).$context;
    const updated = await internalAdapter.updateSession(storedSession().token, { updatedAt: new Date() });
    expect(updated?.userAgent).toBe(AGENT_SESSION_MARKER);
    expect(storedSession().userAgent).toBe(AGENT_SESSION_MARKER);
    expect((await call(cookieFrom(response), 'list-sessions')).status).toBe(403);
  });
});
