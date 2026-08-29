/**
 * Which requests get the authenticated rate limit budget.
 *
 * This is only a bucket choice, never authentication, but getting the cookie
 * name wrong is silent: signed in users simply get the anonymous budget of 10
 * requests per window instead of 100, keyed by IP rather than by user, and
 * nothing logs that it happened. It stayed wrong through the Better Auth
 * migration because the check still named the previous gateway's cookie.
 */
import { describe, test, expect } from 'vitest';
import { presentsSessionCredentials } from '@/middleware/rate-limit';

const h = (init: Record<string, string>) => new Headers(init);

describe('session credential detection', () => {
  test('recognises the Better Auth cookie', () => {
    expect(presentsSessionCredentials(h({ cookie: 'better-auth.session_token=abc' }))).toBe(true);
  });

  test('recognises the secure prefixed cookie used in production', () => {
    expect(
      presentsSessionCredentials(h({ cookie: '__Secure-better-auth.session_token=abc' }))
    ).toBe(true);
  });

  test('recognises it alongside other cookies', () => {
    expect(
      presentsSessionCredentials(h({ cookie: 'ph_x=1; __Secure-better-auth.session_token=abc; y=2' }))
    ).toBe(true);
  });

  test('recognises a bearer token', () => {
    expect(presentsSessionCredentials(h({ authorization: 'Bearer abc' }))).toBe(true);
  });

  test('does not recognise the previous gateway cookie name', () => {
    // The regression: this name no longer exists anywhere in the system.
    expect(presentsSessionCredentials(h({ cookie: 'auth_session=abc' }))).toBe(false);
  });

  test('treats a request with no credentials as anonymous', () => {
    expect(presentsSessionCredentials(h({}))).toBe(false);
    expect(presentsSessionCredentials(h({ cookie: 'theme=dark' }))).toBe(false);
  });
});
