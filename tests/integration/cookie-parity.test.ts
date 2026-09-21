import { afterEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { betterAuth } from 'better-auth';
import { splitSetCookieHeader } from 'better-auth/cookies';
import app from '@/index';
import { createAuth } from '@/auth';
import { createSqliteD1 } from '../helpers/sqlite-d1';

const databases: ReturnType<typeof createSqliteD1>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function fixture(baseURL: string, nodeEnv: string, domain?: string) {
  const db = createSqliteD1(readFileSync(new URL('../../migrations/0001_better_auth.sql', import.meta.url), 'utf8'));
  databases.push(db);
  const env: any = {
    AUTH_DB: db,
    AUTH_STORE: { get: async () => null, put: async () => {} },
    NODE_ENV: nodeEnv,
    OAUTH_BASE_URL: baseURL,
    ALLOWED_ORIGINS: ` ${baseURL}/ , ${baseURL} `,
    COOKIE_DOMAIN: domain,
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    LOG_LEVEL: 'error',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
  };
  return { db, env };
}

function sessionCookie(response: Response) {
  const cookie = splitSetCookieHeader(response.headers.get('set-cookie') ?? '').find(value => value.split('=')[0].endsWith('better-auth.session_token'));
  expect(cookie).toBeDefined();
  const [pair, ...attributes] = cookie!.split(';').map(value => value.trim());
  return { pair, name: pair.split('=')[0], attributes: attributes.filter(value => !/^(Max-Age|Expires)=/i.test(value)).sort() };
}

describe('cookie policy parity', () => {
  test.each([
    ['https://platform.localhost:18787', 'development', undefined],
    ['https://platform.localhost:18787', 'development', 'platform.localhost'],
    ['https://app.example.com', 'production', undefined],
    ['https://app.example.com', 'production', '.example.com'],
  ])('sets and clears the same secure cookie on %s (%s, %s)', async (baseURL, nodeEnv, domain) => {
    const { env, db } = fixture(baseURL!, nodeEnv!, domain);
    const gateway = createAuth(env);
    const signIn = betterAuth({ ...gateway.options, database: db.raw, emailAndPassword: { enabled: true } });
    const response = await signIn.api.signUpEmail({
      body: { email: 'person@example.com', password: 'test-password-long-enough', name: 'Person' },
      asResponse: true,
    });
    const set = sessionCookie(response);
    expect(set.name).toBe('__Secure-better-auth.session_token');
    expect(set.attributes).toContain('Secure');
    expect(set.attributes).toContain('HttpOnly');
    expect(set.attributes).toContain('SameSite=Lax');
    expect(set.attributes).toContain('Path=/');
    expect(set.attributes.filter(value => value.startsWith('Domain='))).toEqual(domain ? [`Domain=${domain}`] : []);
    expect(gateway.options.advanced?.cookiePrefix).toBe('better-auth');
    expect(gateway.options).not.toHaveProperty('secondaryStorage');
    expect(gateway.options.session).not.toHaveProperty('cookieCache');
    const headers = { cookie: set.pair, origin: baseURL!, 'content-type': 'application/json' };
    const before = await app.request(`${baseURL}/api/auth/get-session`, { headers }, env);
    expect((await before.json() as any)?.user.email).toBe('person@example.com');
    const out = await app.request(`${baseURL}/api/auth/sign-out`, { method: 'POST', headers, body: '{}' }, env);
    expect(out.status).toBe(200);
    const cleared = sessionCookie(out);
    expect(cleared.name).toBe(set.name);
    expect(cleared.attributes).toEqual(set.attributes);
    expect(splitSetCookieHeader(out.headers.get('set-cookie') ?? '').find(value => value.startsWith(`${set.name}=`))).toContain('Max-Age=0');
    const after = await app.request(`${baseURL}/api/auth/get-session`, { headers }, env);
    expect(await after.json()).toBeNull();
  });

  test('normalizes one exact origin list including the base origin', () => {
    const { env } = fixture('https://app.example.com', 'development');
    env.ALLOWED_ORIGINS = ' https://OTHER.example.com:443/ ,https://other.example.com';
    expect(createAuth(env).options.trustedOrigins).toEqual(['https://app.example.com', 'https://other.example.com']);
  });

  test.each(['evil.example', 'ample.com', 'https://example.com', 'example.com:443'])('rejects incompatible cookie domain %s', domain => {
    const { env } = fixture('https://app.example.com', 'development', domain);
    expect(() => createAuth(env)).toThrow(/COOKIE_DOMAIN/);
  });

  test.each(['http://localhost:*', '*', 'https://app.example.com/path'])('rejects a non origin allow entry %s', origin => {
    const { env } = fixture('https://app.example.com', 'development');
    env.ALLOWED_ORIGINS = origin;
    expect(() => createAuth(env)).toThrow(/ALLOWED_ORIGINS/);
  });

  test('explicit HTTP keeps an insecure cookie even with the production label', () => {
    const { env } = fixture('http://localhost:8787', 'production');
    expect(createAuth(env).options.advanced?.useSecureCookies).toBe(false);
  });

  test.each([undefined, '', 'file:///tmp/auth', 'https://user:password@app.example.com'])('rejects a missing or invalid base URL', baseURL => {
    const { env } = fixture('https://app.example.com', 'development');
    env.OAUTH_BASE_URL = baseURL;
    expect(() => createAuth(env)).toThrow(/OAUTH_BASE_URL/);
  });

  test('an empty cookie domain disables cross subdomain cookies', () => {
    const { env } = fixture('https://app.example.com', 'production', '  ');
    expect(createAuth(env).options.advanced?.crossSubDomainCookies).toEqual({ enabled: false });
  });

  test.each(['http://localhost:8787', 'https://auth-staging.example.com'])('does not infer an environment label from %s', requestOrigin => {
    const { env } = fixture('https://app.example.com', 'production');
    delete env.NODE_ENV;
    return app.request(`${requestOrigin}/test`, {}, env).then(async response => {
      expect(response.status).toBe(200);
      expect((await response.json() as any).environment.nodeEnv).toBe('production');
    });
  });
});

describe.each(['development', 'staging', 'production'])('same security stack in %s', nodeEnv => {
  test('rejects unconfigured localhost origins in CORS and CSRF', async () => {
    const { env } = fixture('https://platform.localhost:18787', nodeEnv);
    const headers = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
    const preflight = await app.request(`${env.OAUTH_BASE_URL}/api/auth/get-session`, { method: 'OPTIONS', headers }, env);
    expect(preflight.status).toBe(403);
    const post = await app.request(`${env.OAUTH_BASE_URL}/api/auth/sign-out`, { method: 'POST', headers, body: '{}' }, env);
    expect(post.status).toBe(403);
    expect((await post.json() as any).error.code).toBe('CSRF_ERROR');
  });

  test('enforces request size and serves security headers', async () => {
    const { env } = fixture('https://platform.localhost:18787', nodeEnv);
    const response = await app.request(`${env.OAUTH_BASE_URL}/api/auth/sign-out`, {
      method: 'POST',
      headers: { origin: env.OAUTH_BASE_URL, 'content-type': 'application/json', 'content-length': '5242880' },
      body: '{}',
    }, env);
    expect(response.status).toBe(413);
    expect(response.headers.get('content-security-policy')).toBeTruthy();
    expect(response.headers.get('strict-transport-security')).toBeTruthy();
  });

  test('normalizes the same configured origins for CORS and CSRF', async () => {
    const { env } = fixture('https://platform.localhost:18787', nodeEnv);
    env.ALLOWED_ORIGINS = ' https://OTHER.example.com:443/ , https://other.example.com';
    const headers = { origin: 'https://other.example.com', 'content-type': 'application/json' };
    const preflight = await app.request(`${env.OAUTH_BASE_URL}/api/auth/get-session`, { method: 'OPTIONS', headers }, env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(headers.origin);
    const post = await app.request(`${env.OAUTH_BASE_URL}/api/auth/sign-out`, { method: 'POST', headers, body: '{}' }, env);
    expect(post.status).toBe(200);
    expect(post.headers.get('access-control-allow-origin')).toBe(headers.origin);
  });
});
