import { betterAuth } from 'better-auth';
import { openAPI } from 'better-auth/plugins';
import type { CloudflareEnv } from '@/types/auth';
import { resolveAuthConfig, type AuthConfig } from '@/config/auth';
import { authorizeAdministratorEmail } from '@/policy/administrator';
import { agentLogin, agentLoginConfig } from '@/agent-login';
import { AGENT_SESSION_MARKER } from '@/agent-session-marker';
import { betterAuthLogger, diagLog, instrumentD1, pseudonym, type Diagnostics } from '@/observability/diagnostics';

const ACCESS_DENIED = 'This account does not have access to this platform';

function reserveAgentSessionMarker(session: { userAgent?: string | null }) {
  const normalized = session.userAgent?.trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized === AGENT_SESSION_MARKER) return { data: { userAgent: 'reserved' } };
}

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
export function createAuth(env: CloudflareEnv, config: AuthConfig = resolveAuthConfig(env), diag?: Diagnostics) {
  const agent = agentLoginConfig(env);
  return betterAuth({
    // D1 binding passed straight through; Better Auth detects it and uses its
    // own Kysely D1 dialect. Every query goes to the primary instance, so a
    // delete is visible to the very next read.
    database: diag ? instrumentD1(env.AUTH_DB, diag) : env.AUTH_DB,
    logger: betterAuthLogger(diag),

    baseURL: config.baseURL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: config.trustedOrigins,

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
      },
    },

    // This runs before Better Auth creates a user, links an OAuth account or
    // starts a provider sign in. Keep it on the shared policy seam so the
    // gateway and edge cannot admit different accounts.
    user: {
      validateUserInfo: async ({ user, source }) => {
        if (source.method !== 'oauth' || source.oauth?.providerId !== 'google') return;
        const allowed = authorizeAdministratorEmail(user, env.AUTH_ALLOWED_DOMAINS) !== null;
        if (diag) await noteOAuthUser(env, diag, user, allowed);
        if (allowed) return;
        return { error: 'access_denied', errorDescription: ACCESS_DENIED };
      },
    },

    session: {
      expiresIn: 60 * 60 * 24, // 24 hours, matching the previous store
      updateAge: 60 * 5,       // refresh the row at most every 5 minutes
    },

    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            if (diag) {
              diag.uid = user.id;
              diag.notes.push('user created');
            }
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            // The agent endpoint verifies its token before minting the marker.
            if (ctx?.path !== '/agent/sign-in') return reserveAgentSessionMarker(session);
          },
          after: async (session) => {
            if (diag) {
              diag.uid = session.userId;
              diag.notes.push('session created');
            }
          },
        },
        update: {
          before: async (session) => reserveAgentSessionMarker(session),
        },
      },
    },

    // Generated from the live config, so the reference a new client site reads
    // can never drift from what the gateway actually serves. Replaces the hand
    // maintained openapi.yaml.
    // Agent sign in's route exists only when explicitly enabled; its session
    // guard is always on, so issued agent sessions die with the flag. See
    // src/agent-login.ts.
    plugins: [openAPI(), agentLogin(agent)],

    advanced: config.advanced,
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Logs what Google returned against the email policy, naming the person by a
 * pseudonym. This is the line that tells a refused account from a callback
 * that failed after the policy passed.
 */
async function noteOAuthUser(env: CloudflareEnv, diag: Diagnostics, user: unknown, allowed: boolean) {
  const { email, emailVerified } = (user ?? {}) as { email?: unknown; emailVerified?: unknown };
  const address = typeof email === 'string' ? email : '';
  diag.who = address ? await pseudonym(env.BETTER_AUTH_SECRET, address) : undefined;
  diagLog(allowed ? 'info' : 'warn', 'gw.oauth_user', {
    ray: diag.ray,
    who: diag.who,
    domain: address.split('@')[1]?.toLowerCase(),
    emailVerified: emailVerified === true,
    allowed,
  });
}
