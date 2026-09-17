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

const EMAIL = 'someone@example.com';
const PASSWORD = 'correct-horse-battery-staple';

const sideDoor = (db: any) =>
  betterAuth({
    database: db,
    baseURL: GATEWAY,
    secret: SECRET,
    emailAndPassword: { enabled: true },
  });

const cookieFrom = (response: Response) =>
  (response.headers.get('set-cookie') ?? '')
    .split(/,(?=[^;]+=[^;]+)/)
    .map((c) => c.split(';')[0].trim())
    .join('; ');

/**
 * Mint a real session against the same database and secret the app uses, so
 * the cookie validates through the app's own Better Auth instance. Sign up is
 * only enabled on this side instance; the gateway itself stays OAuth only.
 */
async function createSessionCookie(db: any): Promise<string> {
  return cookieFrom(
    await sideDoor(db).api.signUpEmail({
      body: { email: EMAIL, password: PASSWORD, name: 'Someone' },
      asResponse: true,
    })
  );
}

/** A second session for the same user, standing in for another device. */
async function createSecondSessionCookie(db: any): Promise<string> {
  return cookieFrom(
    await sideDoor(db).api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      asResponse: true,
    })
  );
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

describe('no live session channel', () => {
  // The websocket endpoint and the per user Durable Object behind it are gone,
  // because a Durable Object requires Workers Paid. These pin that the path is
  // not quietly still served by something else, and that the app needs no
  // Durable Object binding to boot.

  test('the websocket path is no longer a route', async () => {
    const cookie = await createSessionCookie(db.raw);
    const res = await app.request(
      `${GATEWAY}/api/auth/session-stream`,
      { headers: { cookie, origin: ORIGIN, upgrade: 'websocket' } },
      env
    );
    expect(res.status).toBe(404);
  });

  test('the app serves a session with no Durable Object binding in its environment', async () => {
    // `env` above declares AUTH_DB and AUTH_STORE and nothing else. A binding
    // the code still reached for would surface here rather than on a deploy.
    expect(Object.keys(env)).not.toContain('SESSION_HUB');
    const cookie = await createSessionCookie(db.raw);
    const res = await app.request(`${GATEWAY}/api/auth/get-session`, { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any)?.user?.email).toBe(EMAIL);
  });
});

describe('one device signing out', () => {
  test('leaves the same user session on another device alive', async () => {
    // This is the property the removed fan out had to be careful not to break,
    // and it now rests on D1 alone: a sign out deletes one session row. The
    // other device keeps reading its own row and keeps being told it is valid,
    // which is why polling cannot sign anyone else out.
    const laptop = await createSessionCookie(db.raw);
    const phone = await createSecondSessionCookie(db.raw);
    expect(phone).not.toBe(laptop);

    const out = await app.request(
      `${GATEWAY}/api/auth/sign-out`,
      {
        method: 'POST',
        headers: { cookie: laptop, origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      },
      env
    );
    expect(out.status).toBe(200);

    // No sleep and no propagation window: the very next read already knows.
    const gone = await app.request(
      `${GATEWAY}/api/auth/get-session`,
      { headers: { cookie: laptop } },
      env
    );
    expect(await gone.json()).toBeNull();

    const alive = await app.request(
      `${GATEWAY}/api/auth/get-session`,
      { headers: { cookie: phone } },
      env
    );
    expect(((await alive.json()) as any)?.user?.email).toBe(EMAIL);
  });

  test('an unauthenticated sign out is harmless', async () => {
    const res = await app.request(`${GATEWAY}/api/auth/sign-out`, { method: 'POST' }, env);
    expect(res.status).toBeLessThan(500);
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

describe('security middleware rejections', () => {
  test('an untrusted origin is refused with 403, not a masked 500', async () => {
    // The production security stack is composed by hand. An earlier version
    // awaited each middleware without returning its result, so a blocking
    // middleware's Response was discarded, the context never finalised, and
    // every rejection surfaced as INTERNAL_ERROR. Requests were still blocked,
    // but a CSRF block looked exactly like a server fault.
    const res = await app.request(
      `${GATEWAY}/api/auth/sign-out`,
      {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      },
      env
    );

    expect(res.status).toBe(403);
    expect((await res.json() as any).error.code).toBe('CSRF_ERROR');
  });

  test('an oversized request is refused with 413', async () => {
    const res = await app.request(
      `${GATEWAY}/api/auth/sign-out`,
      {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          'content-length': String(5 * 1024 * 1024),
        },
        body: '{}',
      },
      env
    );

    expect(res.status).toBe(413);
  });
});
