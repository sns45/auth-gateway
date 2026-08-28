/**
 * The contract a client site depends on, exercised against the real app.
 *
 * These boot src/index.ts with its full middleware stack and a real SQLite
 * database, rather than asserting against a mock route defined in the test.
 *
 * Known divergence from workerd, found on a staging deploy: a POST with no
 * body and no content-type is answered 200 here and 415 there, because the
 * two runtimes disagree about whether such a request has a body to type check.
 * So this harness cannot prove a request shape is accepted in production. The
 * shipped client's request shapes are pinned in tests/unit/browser-client.ts
 * instead, and the real answers come from a deployment.
 * The suite this replaced built its own inline Hono app and fetched a
 * placeholder domain over the network, so it verified nothing in src/ and
 * failed on every machine.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { betterAuth } from 'better-auth';
import app from '@/index';
import { createSqliteD1 } from '../helpers/sqlite-d1';

const MIGRATION = fileURLToPath(new URL('../../migrations/0001_better_auth.sql', import.meta.url));
const ORIGIN = 'https://app.example.com';
const GATEWAY = 'https://auth.example.com';
const SECRET = 'integration-secret-at-least-32-characters';

/** Publishes the app makes to a user's hub, so fan out can be asserted. */
let published: { userId: string; event: any }[] = [];

function hubStub() {
  return {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: any) => ({
      fetch: async (_url: string, init: any) => {
        published.push({ userId: id.name, event: JSON.parse(init.body) });
        return Response.json({ delivered: 1 });
      },
    }),
  };
}

/**
 * Mint a real session against the same database and secret the app uses, so
 * the cookie validates through the app's own Better Auth instance. Sign up is
 * only enabled on this side instance; the gateway itself stays OAuth only.
 */
async function createSessionCookie(db: any): Promise<string> {
  const sideDoor = betterAuth({
    database: db,
    baseURL: GATEWAY,
    secret: SECRET,
    emailAndPassword: { enabled: true },
  });
  const response = await sideDoor.api.signUpEmail({
    body: { email: 'someone@example.com', password: 'correct-horse-battery-staple', name: 'Someone' },
    asResponse: true,
  });
  const setCookie = response.headers.get('set-cookie') ?? '';
  return setCookie
    .split(/,(?=[^;]+=[^;]+)/)
    .map((c) => c.split(';')[0].trim())
    .join('; ');
}

let db: any;
let env: any;

const kvStub = () => {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
};

beforeEach(() => {
  db = createSqliteD1(readFileSync(MIGRATION, 'utf8'));
  env = {
    AUTH_DB: db,
    AUTH_STORE: kvStub(),
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: SECRET,
    SESSION_HUB: hubStub(),
    ALLOWED_ORIGINS: ORIGIN,
    OAUTH_BASE_URL: GATEWAY,
    FRONTEND_URL: ORIGIN,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    LOG_LEVEL: 'error',
  };
});

afterEach(() => {
  db.close();
  published = [];
});

describe('health', () => {
  test('reports healthy when the database is reachable', async () => {
    const res = await app.request(`${GATEWAY}/health`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.json() as any).status).toBe('healthy');
  });

  test('reports not ready when the database is broken', async () => {
    // There is no fallback session store, so a broken D1 must surface here
    // rather than being reported healthy while every sign in fails.
    env.AUTH_DB = {
      prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 down'); } }),
                        first: async () => { throw new Error('D1 down'); } }),
    };
    const res = await app.request(`${GATEWAY}/health/ready`, {}, env);
    expect(res.status).toBe(503);
    expect((await res.json() as any).status).toBe('not_ready');
  });

  test('liveness does not depend on the database', async () => {
    env.AUTH_DB = null;
    const res = await app.request(`${GATEWAY}/health/live`, {}, env);
    expect(res.status).toBe(200);
  });
});

describe('session endpoint', () => {
  test('returns null for a caller with no cookie', async () => {
    const res = await app.request(`${GATEWAY}/api/auth/get-session`, {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test('returns null for a forged session token', async () => {
    const res = await app.request(
      `${GATEWAY}/api/auth/get-session`,
      { headers: { cookie: 'better-auth.session_token=forged' } },
      env
    );
    expect(await res.json()).toBeNull();
  });
});

describe('oauth entry point', () => {
  test('hands back a Google authorization url', async () => {
    const res = await app.request(
      `${GATEWAY}/api/auth/sign-in/social`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ provider: 'google', callbackURL: `${ORIGIN}/` }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.url).toContain('accounts.google.com');
    expect(body.url).toContain('client_id=test-client-id');
    expect(body.url).toContain('state=');
  });

  test('asks Google to redirect to the path already registered for this client', async () => {
    // The redirect_uri has to match an Authorized redirect URI in the Google
    // console exactly. The hand rolled gateway this replaced used
    // {OAUTH_BASE_URL}/api/auth/callback/google; if Better Auth ever computes
    // a different path, every sign in fails with redirect_uri_mismatch and
    // the fix is in a console this repo cannot see. Pin it here.
    const res = await app.request(
      `${GATEWAY}/api/auth/sign-in/social`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ provider: 'google', callbackURL: `${ORIGIN}/` }),
      },
      env
    );

    const redirectUri = new URL((await res.json() as any).url).searchParams.get('redirect_uri');
    expect(redirectUri).toBe(`${GATEWAY}/api/auth/callback/google`);
  });
});

describe('cors', () => {
  test('allows a configured origin', async () => {
    const res = await app.request(
      `${GATEWAY}/api/auth/get-session`,
      { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'GET' } },
      env
    );
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  test('does not echo an unconfigured origin', async () => {
    const res = await app.request(
      `${GATEWAY}/api/auth/get-session`,
      { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } },
      env
    );
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });
});

describe('drop in client', () => {
  test('is served as javascript any origin can load', async () => {
    const res = await app.request(`${GATEWAY}/client.js`, {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.text()).toContain('window.authGateway');
  });

  test('the demo page loads the client and is not indexable', async () => {
    const res = await app.request(`${GATEWAY}/demo`, {}, env);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(html).toContain('src="/client.js"');
  });

  test('parses as valid javascript', async () => {
    // It ships as a string inside a TypeScript module, so nothing else would
    // catch a syntax error before a browser did.
    const source = await (await app.request(`${GATEWAY}/client.js`, {}, env)).text();
    expect(() => new Function(source)).not.toThrow();
  });
});

describe('live session channel', () => {
  test('refuses a caller with no session, upgrade header or not', async () => {
    // Checked before the upgrade so the answer does not depend on the Upgrade
    // header surviving: workerd drops it on a non conforming handshake, which
    // turned this into a 426 on the first staging deploy.
    for (const headers of [{ upgrade: 'websocket' }, {}]) {
      const res = await app.request(`${GATEWAY}/api/auth/session-stream`, { headers }, env);
      expect(res.status).toBe(401);
    }
  });

  test('refuses a plain GET rather than upgrading', async () => {
    const cookie = await createSessionCookie(db.raw);
    const res = await app.request(`${GATEWAY}/api/auth/session-stream`, { headers: { cookie } }, env);
    expect(res.status).toBe(426);
  });
});

describe('fan out', () => {
  test('signing out publishes an invalidation to the user hub', async () => {
    const cookie = await createSessionCookie(db.raw);

    const res = await app.request(
      `${GATEWAY}/api/auth/sign-out`,
      {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      },
      env
    );

    expect(res.status).toBe(200);
    expect(published).toHaveLength(1);
    expect(published[0].event).toMatchObject({ type: 'session.changed', reason: 'signed-out' });
  });

  test('the invalidation carries no session identifier', async () => {
    // The hub is per user, so a push reaches other devices whose sessions are
    // still valid. Clients must re-verify rather than act on pushed state.
    const cookie = await createSessionCookie(db.raw);
    await app.request(
      `${GATEWAY}/api/auth/sign-out`,
      {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      },
      env
    );

    const serialised = JSON.stringify(published[0].event);
    expect(serialised).not.toContain('token');
    expect(Object.keys(published[0].event).sort()).toEqual(['at', 'reason', 'type']);
  });

  test('an unauthenticated sign out publishes nothing', async () => {
    await app.request(`${GATEWAY}/api/auth/sign-out`, { method: 'POST' }, env);
    expect(published).toHaveLength(0);
  });
});

describe('cookie scope', () => {
  test('session cookies are scoped to the parent domain, not the gateway host', async () => {
    // Better Auth falls back to the baseURL host when crossSubDomainCookies has
    // no explicit domain. That scopes the cookie to auth.<zone> alone, so the
    // app on <zone> never receives it on its own requests and every server side
    // session check there fails while the browser still looks signed in.
    env.COOKIE_DOMAIN = '.example.com';
    const res = await app.request(
      `${GATEWAY}/api/auth/sign-in/social`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ provider: 'google', callbackURL: `${ORIGIN}/` }),
      },
      env
    );

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('Domain=.example.com');
    expect(setCookie).not.toContain('Domain=auth.example.com');
  });
});
