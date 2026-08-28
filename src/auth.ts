import { betterAuth } from 'better-auth';
import { openAPI } from 'better-auth/plugins';
import type { CloudflareEnv } from '@/types/auth';

/**
 * Better Auth instance for the gateway.
 *
 * Built per request because Workers only hand out bindings (D1, secrets) on
 * the request's `env`, not at module scope.
 *
 * Two settings here are load bearing for immediate revocation. Changing either
 * one reopens the window that moving off KV closed:
 *
 *   - No `secondaryStorage`. Better Auth's `findSession` checks secondary
 *     storage first and short circuits the database on a hit. Backing that
 *     with KV would mean a revoked session is served from a stale colo for up
 *     to 60 seconds, which is the exact defect this gateway just moved off KV
 *     to fix.
 *   - No `session.cookieCache`. It stores the session in a signed cookie, and
 *     the server cannot delete a cookie held on someone else's device, so a
 *     revoked session stays live until the cookie expires.
 */
export function createAuth(env: CloudflareEnv) {
  const trustedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return betterAuth({
    // D1 binding passed straight through; Better Auth detects it and uses its
    // own Kysely D1 dialect. Every query goes to the primary instance, so a
    // delete is visible to the very next read.
    database: env.AUTH_DB,

    baseURL: env.OAUTH_BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins,

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
      },
    },

    session: {
      expiresIn: 60 * 60 * 24, // 24 hours, matching the previous store
      updateAge: 60 * 5,       // refresh the row at most every 5 minutes
    },

    // Generated from the live config, so the reference a new client site reads
    // can never drift from what the gateway actually serves. Replaces the hand
    // maintained openapi.yaml.
    plugins: [openAPI()],

    advanced: {
      // The gateway is on auth.in8.sh and the app is on in8.sh, so the session
      // cookie has to be scoped to the shared parent.
      crossSubDomainCookies: {
        enabled: true,
        domain: env.COOKIE_DOMAIN,
      },
      useSecureCookies: env.NODE_ENV !== 'development',
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
