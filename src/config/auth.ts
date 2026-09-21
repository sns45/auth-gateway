import type { CloudflareEnv } from '@/types/auth';

function configuredURL(value: string | undefined, setting: string): URL {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error(`${setting} must be an explicit HTTP or HTTPS URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.hostname.includes('*')) {
    throw new Error(`${setting} must be an explicit HTTP or HTTPS URL`);
  }
  return url;
}

export function normalizeTrustedOrigins(value: string): string[] {
  return [...new Set(value.split(',').map(origin => origin.trim()).filter(Boolean).map(origin => {
    const url = configuredURL(origin, 'ALLOWED_ORIGINS');
    if (url.pathname !== '/') throw new Error('ALLOWED_ORIGINS entries must be exact origins without paths');
    return url.origin;
  }))];
}

/** The browser policy depends only on explicit URLs and cookie configuration. */
export function resolveAuthConfig(env: Pick<CloudflareEnv, 'OAUTH_BASE_URL' | 'ALLOWED_ORIGINS' | 'COOKIE_DOMAIN'>) {
  const base = configuredURL(env.OAUTH_BASE_URL, 'OAUTH_BASE_URL');
  const domain = env.COOKIE_DOMAIN?.trim().toLowerCase() || undefined;
  if (domain) {
    const hostname = domain.replace(/^\./, '');
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) || hostname.includes('..') ||
        (base.hostname !== hostname && !base.hostname.endsWith(`.${hostname}`))) {
      throw new Error('COOKIE_DOMAIN must match the base URL hostname or a parent domain');
    }
  }
  return {
    baseURL: base.href.replace(/\/$/, ''),
    trustedOrigins: [...new Set([base.origin, ...normalizeTrustedOrigins(env.ALLOWED_ORIGINS ?? '')])],
    advanced: {
      cookiePrefix: 'better-auth',
      useSecureCookies: base.protocol === 'https:',
      crossSubDomainCookies: domain ? { enabled: true, domain } : { enabled: false },
    },
  };
}

export type AuthConfig = ReturnType<typeof resolveAuthConfig>;
