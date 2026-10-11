import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { authorizeAdministratorEmail } from '@/policy/administrator';
import { AGENT_SESSION_MARKER } from '@/agent-session-marker';

/** One hour, so a leaked agent cookie is short lived. */
export const AGENT_SESSION_SECONDS = 60 * 60;

export { AGENT_SESSION_MARKER };

export interface AgentLoginEnv {
  AGENT_LOGIN_ENABLED?: string;
  AGENT_LOGIN_EMAIL?: string;
  AGENT_LOGIN_TOKEN?: string;
  AGENT_LOGIN_NAMES?: string;
  AUTH_ALLOWED_DOMAINS?: string;
}

export interface AgentLoginConfig {
  email: string;
  token: string;
  names: string[];
  allowedDomains: string | undefined;
}

/**
 * The agent account, or null when agent sign in is off.
 *
 * Off unless the flag is exactly 'true', the token is long enough to resist
 * guessing, and the email would pass the same administrator policy a Google
 * account must pass. Anything else leaves the route unregistered, so it 404s.
 */
export function agentLoginConfig(env: AgentLoginEnv): AgentLoginConfig | null {
  if (env.AGENT_LOGIN_ENABLED !== 'true') return null;
  const token = env.AGENT_LOGIN_TOKEN ?? '';
  if (token.length < 32) return null;
  const email = authorizeAdministratorEmail(
    { email: env.AGENT_LOGIN_EMAIL, emailVerified: true },
    env.AUTH_ALLOWED_DOMAINS,
  );
  if (!email) return null;
  const names = env.AGENT_LOGIN_NAMES?.split(',').map((name) => name.trim()) ?? [];
  const validNames = names.every((name) => name.length <= 32 && /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(name));
  return { email, token, names: validNames ? names : [], allowedDomains: env.AUTH_ALLOWED_DOMAINS };
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Compares fixed length digests, so timing reveals nothing about the token. */
async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/**
 * Lets a coding agent sign in without a browser, for testing and debugging.
 *
 * With a config, `POST /api/auth/agent/sign-in` and `Authorization: Bearer
 * <token>` set the same session cookie Google sign in sets, for the base
 * account or a listed name at a derived plus address. An address that already
 * signs in through a provider is refused, so the endpoint never mints a
 * person's session.
 *
 * The session guard is registered whatever the config, because it is what
 * enforces the limits: on every auth request an agent session is deleted when
 * agent sign in is off or the session is over an hour old, is never slid
 * forward, and may only read the session or sign out. The cookie alone cannot
 * promise any of this, since a client can drop it.
 */
export function agentLogin(config: AgentLoginConfig | null): BetterAuthPlugin {
  return {
    id: 'agent-login',
    hooks: {
      before: [
        {
          // Every path, not only get-session: endpoints behind Better Auth's
          // session middleware read the session without running hooks, and
          // would otherwise refresh or use an agent session unchecked.
          matcher: (ctx) => ctx.path !== '/agent/sign-in',
          handler: createAuthMiddleware(async (ctx) => {
            const token = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            );
            if (!token) return;
            const found = await ctx.context.internalAdapter.findSession(token);
            if (found?.session.userAgent !== AGENT_SESSION_MARKER) return;
            const age = Date.now() - new Date(found.session.createdAt).getTime();
            if (!config || age >= AGENT_SESSION_SECONDS * 1000) {
              await ctx.context.internalAdapter.deleteSession(token);
              return;
            }
            // An agent reads its session and signs out; nothing else. The
            // account endpoints would let a leaked cookie change the account
            // or extend the session.
            if (ctx.path === '/get-session')
              return { context: { query: { ...ctx.query, disableRefresh: true } } };
            if (ctx.path !== '/sign-out')
              throw new APIError('FORBIDDEN', { message: 'Agent sessions may only read the session or sign out' });
          }),
        },
      ],
    },
    ...(config
      ? {
          endpoints: {
            agentSignIn: createAuthEndpoint('/agent/sign-in', { method: 'POST', disableBody: true }, async (ctx) => {
              const header = ctx.headers?.get('authorization') ?? '';
              const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
              if (!presented || !(await tokenMatches(presented, config.token))) {
                throw new APIError('UNAUTHORIZED', { message: 'Invalid agent token' });
              }

              if (ctx.request?.body) {
                const mediaType = ctx.request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
                if (mediaType !== 'application/json') {
                  throw new APIError('UNSUPPORTED_MEDIA_TYPE', { message: 'The agent request body must be JSON' });
                }
              }

              // Parse here so even invalid JSON cannot bypass the token check.
              let body: unknown = ctx.body;
              if (body === undefined && ctx.request?.body) {
                const text = await ctx.request.text();
                if (text) {
                  try {
                    body = JSON.parse(text);
                  } catch {
                    throw new APIError('BAD_REQUEST', { message: 'Invalid agent request body' });
                  }
                }
              }
              let email = config.email;
              let displayName = 'AI agent';
              if (body && typeof body === 'object' && 'agent' in body) {
                const name = (body as Record<string, unknown>).agent;
                if (typeof name !== 'string' || !config.names.includes(name)) {
                  throw new APIError('BAD_REQUEST', { message: 'Invalid agent name' });
                }
                const [local, domain] = config.email.split('@');
                if (local.includes('+')) {
                  throw new APIError('BAD_REQUEST', { message: 'The base agent address already has a plus tag' });
                }
                const authorized = authorizeAdministratorEmail(
                  { email: `${local}+${name}@${domain}`, emailVerified: true },
                  config.allowedDomains,
                );
                if (!authorized) {
                  throw new APIError('FORBIDDEN', { message: 'The agent address is not authorized' });
                }
                email = authorized;
                displayName = `AI agent (${name})`;
              }

              const adapter = ctx.context.internalAdapter;
              const found = await adapter.findUserByEmail(email);
              if (found && (await adapter.findAccounts(found.user.id)).length > 0) {
                throw new APIError('FORBIDDEN', { message: 'The agent address belongs to a person' });
              }
              const user =
                found?.user ??
                (await adapter.createUser(
                  { email, emailVerified: true, name: displayName },
                  { method: 'agent' },
                ));

              // Also minted as a "don't remember me" session, so a client that
              // keeps both cookies never triggers a refresh write at all.
              const expiresAt = new Date(Date.now() + AGENT_SESSION_SECONDS * 1000);
              const session = await adapter.createSession(
                user.id,
                true,
                { expiresAt, userAgent: AGENT_SESSION_MARKER },
                true,
              );
              await setSessionCookie(ctx, { session, user }, true, { maxAge: AGENT_SESSION_SECONDS });
              return ctx.json({ email: user.email, expiresAt: session.expiresAt });
            }),
          },
          rateLimit: [{ pathMatcher: (path: string) => path === '/agent/sign-in', window: 60, max: 5 }],
        }
      : {}),
  };
}
