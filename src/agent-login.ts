import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { authorizeAdministratorEmail } from '@/policy/administrator';

/** One hour, so a leaked agent cookie is short lived. */
export const AGENT_SESSION_SECONDS = 60 * 60;

export interface AgentLoginEnv {
  AGENT_LOGIN_ENABLED?: string;
  AGENT_LOGIN_EMAIL?: string;
  AGENT_LOGIN_TOKEN?: string;
  AUTH_ALLOWED_DOMAINS?: string;
}

/**
 * The agent account, or null when agent sign in is off.
 *
 * Off unless the flag is exactly 'true', the token is long enough to resist
 * guessing, and the email would pass the same administrator policy a Google
 * account must pass. Anything else leaves the route unregistered, so it 404s.
 */
export function agentLoginConfig(env: AgentLoginEnv): { email: string; token: string } | null {
  if (env.AGENT_LOGIN_ENABLED !== 'true') return null;
  const token = env.AGENT_LOGIN_TOKEN ?? '';
  if (token.length < 32) return null;
  const email = authorizeAdministratorEmail(
    { email: env.AGENT_LOGIN_EMAIL, emailVerified: true },
    env.AUTH_ALLOWED_DOMAINS,
  );
  return email ? { email, token } : null;
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
 * `POST /api/auth/agent/sign-in` with `Authorization: Bearer <token>` sets the
 * same session cookie Google sign in sets, for one fixed account. The request
 * body is ignored, so the endpoint can never mint a session for a person.
 * Sessions live in D1 like every other, so deleting the agent's rows revokes
 * them on the next request.
 */
export function agentLogin(config: { email: string; token: string }): BetterAuthPlugin {
  return {
    id: 'agent-login',
    endpoints: {
      agentSignIn: createAuthEndpoint('/agent/sign-in', { method: 'POST' }, async (ctx) => {
        const header = ctx.headers?.get('authorization') ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!presented || !(await tokenMatches(presented, config.token))) {
          throw new APIError('UNAUTHORIZED', { message: 'Invalid agent token' });
        }

        const adapter = ctx.context.internalAdapter;
        const found = await adapter.findUserByEmail(config.email);
        const user =
          found?.user ??
          (await adapter.createUser(
            { email: config.email, emailVerified: true, name: 'AI agent' },
            { method: 'agent' },
          ));

        // Minted as a "don't remember me" session. Better Auth marks those
        // with a second signed cookie and never slides them forward on read;
        // an ordinary session would be refreshed to a full day by the first
        // get-session after updateAge. So clients must send every cookie set
        // here, which scripts/agent-login in the platform does.
        const expiresAt = new Date(Date.now() + AGENT_SESSION_SECONDS * 1000);
        const session = await adapter.createSession(user.id, true, { expiresAt }, true);
        await setSessionCookie(ctx, { session, user }, true, { maxAge: AGENT_SESSION_SECONDS });
        return ctx.json({ email: user.email, expiresAt: session.expiresAt });
      }),
    },
    rateLimit: [{ pathMatcher: (path) => path === '/agent/sign-in', window: 60, max: 5 }],
  };
}
