import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCookies } from 'better-auth/cookies';
import { resolveAuthConfig } from 'hono-auth-gateway/auth-config';

const labels = ['development', 'staging', 'production'];
const origins = [
  'https://platform.local.prcpnt.com:18787',
  'https://platform.prcpnt.com',
  'http://localhost:8787',
];

function recursiveShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(recursiveShape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, recursiveShape(entry)]));
  }
  return typeof value;
}

describe('auth configuration parity', () => {
  test.each(origins)('environment labels cannot change cookie or origin policy for %s', baseURL => {
    for (const domain of [undefined, '', new URL(baseURL).hostname]) {
      const configurations = labels.map(NODE_ENV => {
        const input = { NODE_ENV, OAUTH_BASE_URL: baseURL, ALLOWED_ORIGINS: ` ${baseURL}/, ${baseURL}`, COOKIE_DOMAIN: domain };
        return resolveAuthConfig(input);
      });
      expect(configurations[0]).toEqual(configurations[1]);
      expect(configurations[1]).toEqual(configurations[2]);
      for (const configuration of configurations) {
        expect(configuration.advanced.useSecureCookies).toBe(baseURL.startsWith('https:'));
        expect(configuration.advanced.cookiePrefix).toBe('better-auth');
        expect(configuration.trustedOrigins).toEqual([baseURL]);
        expect(configuration.advanced.crossSubDomainCookies).toEqual(domain ? { enabled: true, domain } : { enabled: false });
      }
    }
  });

  test.each([true, false])('local and remote HTTPS share recursive configuration shape with an explicit domain: %s', explicitDomain => {
    const configurations = origins.slice(0, 2).map(OAUTH_BASE_URL => resolveAuthConfig({
      OAUTH_BASE_URL,
      ALLOWED_ORIGINS: OAUTH_BASE_URL,
      COOKIE_DOMAIN: explicitDomain ? new URL(OAUTH_BASE_URL).hostname : undefined,
    }));
    expect(recursiveShape(configurations[0])).toEqual(recursiveShape(configurations[1]));
    const cookies = configurations.map(configuration => getCookies(configuration).sessionToken);
    expect(recursiveShape(cookies[0])).toEqual(recursiveShape(cookies[1]));
    for (const [index, cookie] of cookies.entries()) {
      expect(cookie.name).toBe('__Secure-better-auth.session_token');
      expect(cookie.attributes).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
      if (explicitDomain) {
        expect(cookie.attributes.domain).toBe(new URL(origins[index]).hostname);
      } else {
        expect(cookie.attributes).not.toHaveProperty('domain');
      }
    }
  });

  test('the public resolver compiles without the gateway repository aliases or bindings', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = spawnSync(process.execPath, [
      `${root}node_modules/typescript/bin/tsc`,
      '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
      '--module', 'ESNext', '--moduleResolution', 'bundler',
      `${root}src/config/auth.ts`,
    ], { cwd: root, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
