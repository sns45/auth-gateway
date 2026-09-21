import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createAuth } from '@/auth';
import { createSqliteD1 } from '../helpers/sqlite-d1';

const policy = 'prcpnt.com,lattiq.com';
const origin = 'https://platform.example.com';
const user = (email: string, emailVerified = true) => ({ email, emailVerified, name: 'Person' });

let db: ReturnType<typeof createSqliteD1>;
let env: any;

beforeEach(() => {
  db = createSqliteD1(readFileSync(new URL('../../migrations/0001_better_auth.sql', import.meta.url), 'utf8'));
  env = {
    AUTH_DB: db,
    AUTH_STORE: { get: async () => null, put: async () => {}, delete: async () => {} },
    NODE_ENV: 'production', OAUTH_BASE_URL: origin, ALLOWED_ORIGINS: origin,
    AUTH_ALLOWED_DOMAINS: policy,
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret',
  };
});

afterEach(() => db.close());

async function validate(email: string, emailVerified = true) {
  const hook = createAuth(env).options.user?.validateUserInfo;
  expect(hook).toBeDefined();
  return hook!({ user: user(email, emailVerified), source: { action: 'create-user', method: 'oauth', oauth: { providerId: 'google' } } }, {} as any);
}

function counts() {
  return {
    users: db.raw.prepare('SELECT COUNT(*) AS count FROM user').get().count,
    sessions: db.raw.prepare('SELECT COUNT(*) AS count FROM session').get().count,
  };
}

describe('OAuth account access gate', () => {
  test.each(['person@prcpnt.com', 'person@lattiq.com'])('allows %s before persistence', async email => {
    expect(await validate(email)).toBeUndefined();
    expect(counts()).toEqual({ users: 0, sessions: 0 });
  });

  test('refuses a disallowed domain with a client safe access error and writes no rows', async () => {
    expect(await validate('person@elsewhere.com')).toEqual({
      error: 'access_denied',
      errorDescription: 'This account does not have access to this platform',
    });
    expect(counts()).toEqual({ users: 0, sessions: 0 });
  });

  test.each([undefined, '', 'prcpnt.com,', '*.prcpnt.com', 'prcpnt.com,https://lattiq.com'])('empty or malformed policy denies everyone: %s', async allowedDomains => {
    env.AUTH_ALLOWED_DOMAINS = allowedDomains;
    expect(await validate('person@prcpnt.com')).toMatchObject({ error: 'access_denied' });
    expect(counts()).toEqual({ users: 0, sessions: 0 });
  });

  test('unverified provider identity is denied by the same policy', async () => {
    expect(await validate('person@prcpnt.com', false)).toMatchObject({ error: 'access_denied' });
    expect(counts()).toEqual({ users: 0, sessions: 0 });
  });
});
