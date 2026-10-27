import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createAuth } from '@/auth';
import { clientFamily, describeStatement, instrumentD1, newDiagnostics, pseudonym } from '@/observability/diagnostics';
import { redact, redactText } from '@/observability/redact';
import { createSqliteD1 } from '../helpers/sqlite-d1';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
let lines: string[];

beforeEach(() => {
  lines = [];
  for (const method of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
});
afterEach(() => vi.restoreAllMocks());

const events = (evt: string) => lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(line => line?.evt === evt);

describe('redaction', () => {
  test('free text loses emails, IP addresses and token shaped strings, and keeps the rest', () => {
    const text = redactText('user mitch@prcpnt.com from 203.0.113.9 and 2001:db8:85a3::8a2e:370:7334 sent eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl then D1_ERROR: too many writes');
    expect(text).not.toMatch(/mitch|203\.0\.113\.9|2001:db8|eyJ/);
    expect(text).toContain('<email>');
    expect(text).toContain('<ip>');
    expect(text).toContain('<redacted>');
    expect(text).toContain('D1_ERROR: too many writes');
  });

  test('structured values drop sensitive fields at any depth', () => {
    const out = JSON.stringify(redact({
      path: '/api/auth/callback/google',
      ip_address: '203.0.113.9',
      headers: { cookie: 'a=b' },
      nested: { email: 'person@prcpnt.com', sessionToken: 'abc', code: 'xyz', state: 'st', status: 302 },
    }));
    expect(out).not.toMatch(/203\.0\.113\.9|a=b|person@|"abc"|"xyz"|"st"/);
    expect(out).toContain('/api/auth/callback/google');
    expect(out).toContain('302');
  });

  test('a statement is described by operation and table only', () => {
    expect(describeStatement('insert into "session" ("id", "token") values (?, ?)')).toEqual({ op: 'INSERT', table: 'session' });
    expect(describeStatement('select * from "user" where "email" = ? limit ?')).toEqual({ op: 'SELECT', table: 'user' });
    expect(describeStatement('update "session" set "expiresAt" = ?')).toEqual({ op: 'UPDATE', table: 'session' });
  });
});

describe('pseudonyms', () => {
  test('are stable, case blind, keyed by the secret and never contain the address', async () => {
    const one = await pseudonym(SECRET, 'Mitch@prcpnt.com');
    expect(one).toMatch(/^[0-9a-f]{16}$/);
    expect(await pseudonym(SECRET, ' mitch@prcpnt.com ')).toBe(one);
    expect(await pseudonym(`${SECRET}-other`, 'mitch@prcpnt.com')).not.toBe(one);
    expect(await pseudonym(SECRET, 'hardik@prcpnt.com')).not.toBe(one);
  });

  test('the client is named by browser and system family only', () => {
    expect(clientFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toBe('Edge 141 / Windows');
    expect(clientFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0')).toBe('Firefox 157 / macOS');
    expect(clientFamily(undefined)).toBe('none');
  });
});

describe('session database timing', () => {
  let db: ReturnType<typeof createSqliteD1>;
  beforeEach(() => { db = createSqliteD1(readFileSync(new URL('../../migrations/0001_better_auth.sql', import.meta.url), 'utf8')); });
  afterEach(() => db.close());

  test('counts statements and times them without touching results', async () => {
    const diag = newDiagnostics('ray-1');
    const wrapped = instrumentD1(db as unknown as D1Database, diag);
    const result = await wrapped.prepare('SELECT COUNT(*) AS n FROM user WHERE email = ?').bind('person@prcpnt.com').first<{ n: number }>();
    expect(result).toEqual({ n: 0 });
    expect(diag.d1).toMatchObject({ statements: 1, failures: 0 });
  });

  test('a transient D1 reset is retried and the statement succeeds', async () => {
    const diag = newDiagnostics('ray-r');
    let calls = 0;
    const flaky = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            calls++;
            if (calls < 3) throw new Error('D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = abc');
            return { success: true };
          },
        }),
      }),
    } as unknown as D1Database;
    await expect(instrumentD1(flaky, diag).prepare('insert into "user" ("id") values (?)').bind('u1').run()).resolves.toEqual({ success: true });
    expect(calls).toBe(3);
    expect(diag.d1.failures).toBe(0);
    expect(events('gw.d1_retry')).toHaveLength(2);
    expect(events('gw.d1_retry')[0]).toMatchObject({ ray: 'ray-r', op: 'INSERT', table: 'user', attempt: 1 });
  });

  test('a transient reset that persists fails after three attempts, and other errors are never retried', async () => {
    const diag = newDiagnostics('ray-p');
    let resets = 0, limits = 0;
    const db = (message: string, count: () => void) => ({
      prepare: () => ({ bind: () => ({ all: async () => { count(); throw new Error(message); } }) }),
    }) as unknown as D1Database;
    await expect(instrumentD1(db('D1_ERROR: Network connection lost.', () => resets++), diag).prepare('select 1 from session').bind().all()).rejects.toThrow('Network connection lost');
    expect(resets).toBe(3);
    await expect(instrumentD1(db('D1_ERROR: Exceeded daily write limit', () => limits++), diag).prepare('update session set x=?').bind(1).all()).rejects.toThrow('daily write limit');
    expect(limits).toBe(1);
  });

  test('a failed statement logs its operation, table and scrubbed message, never its values', async () => {
    const diag = newDiagnostics('ray-2');
    const failing = {
      prepare: (sql: string) => ({
        bind: () => ({ all: async () => { throw new Error(`D1_ERROR: Exceeded maximum DB size, row for mitch@prcpnt.com ${sql.length}`); } }),
      }),
    } as unknown as D1Database;
    await expect(instrumentD1(failing, diag).prepare('insert into "user" ("email") values (?)').bind('mitch@prcpnt.com').all()).rejects.toThrow('D1_ERROR');
    expect(diag.d1.failures).toBe(1);
    const [line] = events('gw.d1_error');
    expect(line).toMatchObject({ ray: 'ray-2', op: 'INSERT', table: 'user', level: 'error' });
    expect(line.error.message).toContain('D1_ERROR: Exceeded maximum DB size');
    expect(lines.join('\n')).not.toContain('mitch@');
  });
});

describe('OAuth policy line', () => {
  test('names the person by pseudonym and domain only', async () => {
    const db = createSqliteD1(readFileSync(new URL('../../migrations/0001_better_auth.sql', import.meta.url), 'utf8'));
    const env = { AUTH_DB: db, AUTH_STORE: {}, NODE_ENV: 'production', OAUTH_BASE_URL: 'https://platform.example.com', ALLOWED_ORIGINS: 'https://platform.example.com', AUTH_ALLOWED_DOMAINS: 'prcpnt.com', BETTER_AUTH_SECRET: SECRET, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' } as any;
    const diag = newDiagnostics('ray-3');
    const hook = createAuth(env, undefined, diag).options.user!.validateUserInfo!;
    const source = { action: 'create-user', method: 'oauth', oauth: { providerId: 'google' } } as any;
    expect(await hook({ user: { email: 'mitch@prcpnt.com', emailVerified: true, name: 'M' }, source } as any, {} as any)).toBeUndefined();
    expect(await hook({ user: { email: 'someone@elsewhere.com', emailVerified: true, name: 'S' }, source } as any, {} as any)).toMatchObject({ error: 'access_denied' });
    const [allowed, refused] = events('gw.oauth_user');
    expect(allowed).toMatchObject({ ray: 'ray-3', who: await pseudonym(SECRET, 'mitch@prcpnt.com'), domain: 'prcpnt.com', emailVerified: true, allowed: true, level: 'info' });
    expect(refused).toMatchObject({ domain: 'elsewhere.com', allowed: false, level: 'warn' });
    expect(lines.join('\n')).not.toMatch(/mitch@|someone@/);
    db.close();
  });
});
