import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import app from '@/index';
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

function expectNothingCreated(response: Response) {
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(db.raw.prepare('SELECT count(*) AS n FROM user').get()).toEqual({ n: 0 });
  expect(db.raw.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 0 });
}

describe('agent request media type', () => {
  test.each(['text/plain', 'multipart/form-data; boundary=review', null])(
    'refuses body content type %s before reading with a correct token', async contentType => {
      const request = new Request(`${ORIGIN}/api/auth/agent/sign-in`, {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}` },
        body: '{"agent":"build.1"}',
      });
      if (contentType) request.headers.set('content-type', contentType);
      else request.headers.delete('content-type');
      const read = vi.spyOn(request, 'text');
      const response = await app.request(request, undefined, env);
      expect(response.status).toBe(415);
      expect(read).not.toHaveBeenCalled();
      expect(request.bodyUsed).toBe(false);
      expectNothingCreated(response);
    },
  );

  test('signs in the base account with an empty request and no content type', async () => {
    const response = await app.request(`${ORIGIN}/api/auth/agent/sign-in`, {
      method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}` },
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: 'agent@prcpnt.com' });
    expect(response.headers.get('set-cookie')).toContain('better-auth.session_token=');
    expect(db.raw.prepare('SELECT email FROM user').all()).toEqual([{ email: 'agent@prcpnt.com' }]);
    expect(db.raw.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 1 });
  });

  test('accepts JSON with a charset parameter', async () => {
    const response = await app.request(`${ORIGIN}/api/auth/agent/sign-in`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}`, 'content-type': 'Application/JSON; charset=utf-8' },
      body: '{"agent":"build.1"}',
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: 'agent+build.1@prcpnt.com' });
    expect(response.headers.get('set-cookie')).toContain('better-auth.session_token=');
    expect(db.raw.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 1 });
  });
});
