import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { betterAuth } from 'better-auth';
import { splitSetCookieHeader } from 'better-auth/cookies';
import app from '@/index';
import { createAuth } from '@/auth';
import { createSqliteD1 } from '../helpers/sqlite-d1';

const ORIGIN = 'https://platform.example.com';
const IP = '203.0.113.77';
let db: ReturnType<typeof createSqliteD1>;
let env: any;
let lines: string[];

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
    LOG_LEVEL: 'info',
  };
  lines = [];
  for (const method of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const events = (evt: string) => lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(line => line?.evt === evt);

async function sessionCookie(email: string) {
  const auth = betterAuth({ ...createAuth(env).options, database: db.raw, emailAndPassword: { enabled: true } });
  const response = await auth.api.signUpEmail({ body: { email, password: 'test-password-long-enough', name: 'Person' }, asResponse: true });
  db.raw.prepare('UPDATE user SET emailVerified = 1 WHERE email = ?').run(email);
  return splitSetCookieHeader(response.headers.get('set-cookie') ?? '').map(cookie => cookie.split(';')[0]).join('; ');
}

const headers = (cookie = '') => ({ cookie, origin: ORIGIN, 'cf-ray': 'ray-test-1', 'cf-connecting-ip': IP, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36' });

describe('request diagnostics', () => {
  test('a session read logs one line with cookie names, timing and the user id, and no values', async () => {
    const cookie = await sessionCookie('person@prcpnt.com');
    lines = [];
    const response = await app.request(`${ORIGIN}/api/auth/administrator-session?probe=secret-query-value`, { headers: headers(cookie) }, env);
    expect(response.status).toBe(200);
    const requests = events('gw.request');
    expect(requests).toHaveLength(1);
    const userId = db.raw.prepare('SELECT id FROM user').get().id;
    expect(requests[0]).toMatchObject({
      ray: 'ray-test-1', method: 'GET', path: '/api/auth/administrator-session', status: 200, level: 'info',
      client: 'Chrome 141 / Windows', origin: 'platform.example.com', query: ['probe'], uid: userId,
    });
    expect(requests[0].cookies).toEqual(['__Secure-better-auth.session_token']);
    expect(requests[0].d1.statements).toBeGreaterThan(0);
    const output = lines.join('\n');
    expect(output).not.toContain(cookie.split('=')[1]!.slice(0, 20));
    expect(output).not.toContain('secret-query-value');
    expect(output).not.toContain(IP);
    expect(output).not.toContain('person@prcpnt.com');
  });

  test('the Better Auth error page is logged as an error with its code', async () => {
    await app.request(`${ORIGIN}/api/auth/error?error=internal_server_error`, { headers: headers() }, env);
    expect(events('gw.request')[0]).toMatchObject({ level: 'error', path: '/api/auth/error', error: 'internal_server_error' });
  });

  test('a refused session database write is logged per statement and on the request', async () => {
    const cookie = await sessionCookie('person@prcpnt.com');
    env.AUTH_DB = {
      prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1_ERROR: Exceeded daily write limit'); } }) }),
      batch: async () => { throw new Error('D1_ERROR: Exceeded daily write limit'); },
      exec: async () => { throw new Error('D1_ERROR: Exceeded daily write limit'); },
      dump: async () => new ArrayBuffer(0),
    };
    lines = [];
    const response = await app.request(`${ORIGIN}/api/auth/administrator-session`, { headers: headers(cookie) }, env);
    expect(response.status).toBeGreaterThanOrEqual(500);
    const failures = events('gw.d1_error');
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatchObject({ ray: 'ray-test-1', op: 'SELECT', level: 'error' });
    expect(failures[0].error.message).toContain('Exceeded daily write limit');
    const [request] = events('gw.request');
    expect(request.level).toBe('error');
    expect(request.d1.failures).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(cookie.split('=')[1]!.slice(0, 20));
  });

  test('audit lines for a sign out no longer carry the client IP', async () => {
    const cookie = await sessionCookie('person@prcpnt.com');
    lines = [];
    await app.request(`${ORIGIN}/api/auth/sign-out`, { method: 'POST', headers: { ...headers(cookie), 'content-type': 'application/json' }, body: '{}' }, env);
    expect(lines.some(line => line.includes('Audit log'))).toBe(true);
    expect(lines.join('\n')).not.toContain(IP);
    expect(events('gw.request')[0].setCookies.some((name: string) => name.includes('(cleared)'))).toBe(true);
  });
});
