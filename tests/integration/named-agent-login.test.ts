import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { splitSetCookieHeader } from 'better-auth/cookies';
import { betterAuth } from 'better-auth';
import app from '@/index';
import { createAuth } from '@/auth';
import { AGENT_SESSION_MARKER, agentLogin, agentLoginConfig } from '@/agent-login';
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
    AGENT_LOGIN_NAMES: 'build.1,agent2',
  };
});

afterEach(() => db.close());

function request(body?: string, token: string | null = TOKEN) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.request(`${ORIGIN}/api/auth/agent/sign-in`, { method: 'POST', headers, body }, env);
}

function signIn(body: unknown = { agent: 'build.1' }, token: string | null = TOKEN) {
  return request(JSON.stringify(body), token);
}

const cookieFrom = (response: Response) =>
  splitSetCookieHeader(response.headers.get('set-cookie') ?? '').map(cookie => cookie.split(';')[0]).join('; ');

function expectNothingCreated(response: Response) {
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(db.raw.prepare('SELECT count(*) AS n FROM user').get()).toEqual({ n: 0 });
  expect(db.raw.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 0 });
}

describe('named agent sign in request validation', () => {
  test.each([
    'unknown', 'BUILD.1', 'two words', ' build.1', 'build.1 ', 'build.1\n',
    'a'.repeat(33), '../build.1', 'build/1', '', '.build', 'build.', 'build..1',
    'build_1', 'build-1', null, 12, true, ['build.1'], { name: 'build.1' },
  ])('refuses invalid or unlisted name %j without creating anything', async agent => {
    const response = await signIn({ agent });
    expect(response.status).toBe(400);
    expectNothingCreated(response);
  });

  test.each([undefined, '', 'build.1,UPPER', 'build.1,', 'build.1,two..dots'])('disables named sign in only for names setting %s', async names => {
    env.AGENT_LOGIN_NAMES = names;
    const response = await signIn();
    expect(response.status).toBe(400);
    expectNothingCreated(response);
    const base = await signIn({});
    expect(base.status).toBe(200);
    expect(await base.json()).toMatchObject({ email: 'agent@prcpnt.com' });
    expect(db.raw.prepare('SELECT email, name FROM user').get()).toEqual({ email: 'agent@prcpnt.com', name: 'AI agent' });
  });

  test.each([undefined, '{}', '{"email":"person@prcpnt.com"}'])('keeps the base account for body %s', async body => {
    const response = await request(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: 'agent@prcpnt.com' });
    expect(cookieFrom(response)).toContain('better-auth.session_token=');
    expect(db.raw.prepare('SELECT email, name FROM user').get()).toEqual({ email: 'agent@prcpnt.com', name: 'AI agent' });
  });

  test.each(['null', '[]', '"build.1"', '12'])('keeps the base account for JSON without an agent key %s', async body => {
    const response = await request(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: 'agent@prcpnt.com' });
    expect(cookieFrom(response)).toContain('better-auth.session_token=');
    expect(db.raw.prepare('SELECT email, name FROM user').get()).toEqual({ email: 'agent@prcpnt.com', name: 'AI agent' });
  });

  test('refuses malformed JSON', async () => {
    const response = await request('{"agent":');
    expect(response.status).toBe(400);
    expectNothingCreated(response);
  });

  test.each([
    '{"agent":"build.1"}', '{"agent":"unknown"}', '{"agent":null}', '{"agent":',
  ])('checks the token before body %s', async body => {
    const response = await request(body, 'wrong-token-that-is-at-least-32-characters');
    expect(response.status).toBe(401);
    expectNothingCreated(response);
  });
});

describe('named agent address policy', () => {
  test.each([
    ['build.1', 'agent+build.1@prcpnt.com'],
    ['agent2', 'agent+agent2@prcpnt.com'],
  ])('signs in listed name %s as %s', async (agent, email) => {
    const response = await signIn({ agent });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email });
    const cookie = cookieFrom(response);
    expect(cookie).toContain('better-auth.session_token=');
    const session = await app.request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie, origin: ORIGIN } }, env);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email, emailVerified: true } });
    expect(db.raw.prepare('SELECT email FROM user').all()).toEqual([{ email }]);
  });

  test('accepts a listed name of 32 characters with surrounding allowlist whitespace', async () => {
    const agent = 'a'.repeat(32);
    env.AGENT_LOGIN_NAMES = ` ${agent} , build.1 `;
    const response = await signIn({ agent });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: `agent+${agent}@prcpnt.com` });
  });

  test('refuses an existing plus tag while keeping the base account available', async () => {
    env.AGENT_LOGIN_EMAIL = 'agent+existing@prcpnt.com';
    const response = await signIn();
    expect(response.status).toBe(400);
    expectNothingCreated(response);
    const base = await signIn({});
    expect(base.status).toBe(200);
    expect(await base.json()).toMatchObject({ email: 'agent+existing@prcpnt.com' });
  });

  test('refuses a derived address outside the allowed domains', async () => {
    const config = agentLoginConfig(env)!;
    const auth = betterAuth({
      ...createAuth(env).options,
      plugins: [agentLogin({ ...config, allowedDomains: 'elsewhere.com' })],
    });
    const response = await auth.handler(new Request(`${ORIGIN}/api/auth/agent/sign-in`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{"agent":"build.1"}',
    }));
    expect(response.status).toBe(403);
    expectNothingCreated(response);
  });

  test('rechecks the administrator policy when a plus address exceeds its length limit', async () => {
    env.AGENT_LOGIN_EMAIL = `${'a'.repeat(240)}@prcpnt.com`;
    const response = await signIn();
    expect(response.status).toBe(403);
    expectNothingCreated(response);
    expect((await signIn({})).status).toBe(200);
  });
});

describe('named agent user accounts', () => {
  test.each([
    ['build.1', 'AI agent (build.1)'],
    ['agent2', 'AI agent (agent2)'],
  ])('creates the display name for %s', async (agent, name) => {
    expect((await signIn({ agent })).status).toBe(200);
    expect(db.raw.prepare('SELECT name FROM user').get()).toEqual({ name });
  });

  test('refuses a derived address that already has a provider account', async () => {
    const auth = betterAuth({ ...createAuth(env).options, database: db.raw, emailAndPassword: { enabled: true } });
    await auth.api.signUpEmail({
      body: { email: 'agent+build.1@prcpnt.com', password: 'test-password-long-enough', name: 'Person' },
    });
    db.raw.prepare("INSERT INTO account (id, issuer, accountId, providerId, userId, createdAt, updatedAt) SELECT 'a1', 'https://accounts.google.com', 'g1', 'google', id, createdAt, updatedAt FROM user").run();
    db.raw.prepare('DELETE FROM session').run();
    const response = await signIn();
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(db.raw.prepare('SELECT email, name FROM user').all()).toEqual([{ email: 'agent+build.1@prcpnt.com', name: 'Person' }]);
    expect(db.raw.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 0 });
  });

  test('reuses named users and keeps the base account separate', async () => {
    for (const body of [{ agent: 'build.1' }, { agent: 'build.1' }, { agent: 'agent2' }, {}]) {
      expect((await signIn(body)).status).toBe(200);
    }
    expect(db.raw.prepare('SELECT email FROM user ORDER BY email').all()).toEqual([
      { email: 'agent+agent2@prcpnt.com' },
      { email: 'agent+build.1@prcpnt.com' },
      { email: 'agent@prcpnt.com' },
    ]);
    expect(db.raw.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 4 });
  });
});

describe('direct agent sign in API', () => {
  test.each([
    [{}, 'agent@prcpnt.com'],
    [{ agent: 'build.1' }, 'agent+build.1@prcpnt.com'],
  ])('preserves a parsed body with a consumed request %j', async (body, email) => {
    const request = new Request(`${ORIGIN}/api/auth/agent/sign-in`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    const parsed = await request.json();
    const response = await createAuth(env).api.agentSignIn({
      headers: request.headers, request, body: parsed, asResponse: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email });
    expect(cookieFrom(response)).toContain('better-auth.session_token=');
    expect(db.raw.prepare('SELECT email FROM user').all()).toEqual([{ email }]);
  });

  test.each([
    ['build.1', 200], ['unknown', 400], [null, 400],
  ])('validates a supplied agent %s without a request', async (agent, status) => {
    const response = await createAuth(env).api.agentSignIn({
      headers: new Headers({ origin: ORIGIN, authorization: `Bearer ${TOKEN}` }),
      body: { agent }, asResponse: true,
    });
    expect(response.status).toBe(status);
    if (status === 400) expectNothingCreated(response);
    else {
      expect(await response.json()).toMatchObject({ email: 'agent+build.1@prcpnt.com' });
      expect(cookieFrom(response)).toContain('better-auth.session_token=');
    }
  });
});

describe('named agent session safeguards', () => {
  function session(cookie: string, path = 'get-session', method = 'GET') {
    const headers: Record<string, string> = { cookie, origin: ORIGIN };
    if (method === 'POST') headers['content-type'] = 'application/json';
    return app.request(`${ORIGIN}/api/auth/${path}`, {
      method, headers, ...(method === 'POST' ? { body: '{}' } : {}),
    }, env);
  }

  test('uses the existing session marker and one hour limit', async () => {
    const response = await signIn();
    expect(response.status).toBe(200);
    const row = db.raw.prepare('SELECT userAgent, expiresAt FROM session').get() as { userAgent: string; expiresAt: string | number };
    expect(row.userAgent).toBe(AGENT_SESSION_MARKER);
    const remaining = new Date(row.expiresAt).getTime() - Date.now();
    expect(remaining).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(remaining).toBeGreaterThan(55 * 60 * 1000);
  });

  test.each(['get-session', 'administrator-session'])('does not slide the session on %s with only the token cookie', async path => {
    const cookie = cookieFrom(await signIn()).split('; ').filter(c => c.includes('session_token')).join('; ');
    db.raw.prepare('UPDATE session SET updatedAt = ?').run(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const before = db.raw.prepare('SELECT expiresAt FROM session').get();
    const response = await session(cookie, path);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(db.raw.prepare('SELECT expiresAt FROM session').get()).toEqual(before);
  });

  test.each([
    ['list-sessions', 'GET'],
    ['list-accounts', 'GET'],
    ['update-user', 'POST'],
    ['update-session', 'POST'],
    ['revoke-other-sessions', 'POST'],
  ])('refuses %s for named agent sessions', async (path, method) => {
    const cookie = cookieFrom(await signIn());
    const before = db.raw.prepare('SELECT expiresAt FROM session').get();
    const response = await session(cookie, path, method);
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(db.raw.prepare('SELECT expiresAt FROM session').get()).toEqual(before);
  });

  test('allows a named agent to sign out', async () => {
    const cookie = cookieFrom(await signIn());
    expect((await session(cookie, 'sign-out', 'POST')).status).toBe(200);
    expect(db.raw.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 0 });
    expect(await (await session(cookie)).json()).toBeNull();
  });

  test.each([
    { AGENT_LOGIN_ENABLED: 'false' },
    { AGENT_LOGIN_ENABLED: 'false', AGENT_LOGIN_EMAIL: 'other@prcpnt.com' },
    { AGENT_LOGIN_ENABLED: undefined, AGENT_LOGIN_EMAIL: undefined, AGENT_LOGIN_TOKEN: undefined, AGENT_LOGIN_NAMES: undefined },
  ])('deletes a named session when agent sign in is off %j', async override => {
    const cookie = cookieFrom(await signIn());
    Object.assign(env, override);
    expect((await session(cookie, 'administrator-session')).status).toBe(401);
    expect(await (await session(cookie)).json()).toBeNull();
    expect(db.raw.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 0 });
  });

  test('deletes a named session older than an hour on any auth path', async () => {
    const cookie = cookieFrom(await signIn());
    db.raw.prepare('UPDATE session SET createdAt = ?, expiresAt = ?').run(
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
    );
    expect((await session(cookie, 'list-sessions')).status).toBe(401);
    expect(db.raw.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 0 });
    expect(await (await session(cookie)).json()).toBeNull();
  });
});
