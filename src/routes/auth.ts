import { Hono } from 'hono';
import { CloudflareEnv } from '@/types/auth';
import { Variables } from '@/types/context';
import { createAuth } from '@/auth';
import { publishSessionEvent } from '@/services/session-events';

/**
 * Better Auth owns every route under this mount.
 *
 * Deliberately a passthrough rather than a set of bespoke wrappers: a client
 * site can point any Better Auth client at this origin and work with no
 * gateway specific code, which is the whole point of the gateway existing.
 * See /api/auth/reference for the generated spec.
 *
 * The one thing layered on top is live session sync. Requests that start or
 * end a session publish an invalidation to the user's hub, so their other tabs
 * find out without polling and without a reload.
 */
export const authRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/** Paths that end a session. Matched by suffix, since the mount adds a prefix. */
const REVOCATION_PATHS = [
  '/sign-out',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/delete-user',
];

/** Read the session cookies a response is setting, as a Cookie header. */
function cookieHeaderFrom(response: Response): string | null {
  // getSetCookie is present in workerd and in Node 18.14+, but is not in the
  // @cloudflare/workers-types Headers surface yet.
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies: string[] =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : ([response.headers.get('set-cookie')].filter(Boolean) as string[]);

  const pairs = setCookies
    .map((cookie: string) => cookie.split(';')[0].trim())
    .filter((pair: string) => pair.includes('=') && !pair.endsWith('='));

  return pairs.length ? pairs.join('; ') : null;
}

authRoutes.all('*', async (c) => {
  const auth = createAuth(c.env);
  const path = new URL(c.req.url).pathname;
  const isRevocation = REVOCATION_PATHS.some((suffix) => path.endsWith(suffix));

  // Resolved before the handler runs, because afterwards the session is gone
  // and there is no user left to address the hub with.
  const revokedUserId = isRevocation
    ? (await auth.api.getSession({ headers: c.req.raw.headers }))?.user.id
    : undefined;

  const response = await auth.handler(c.req.raw);
  if (!response.ok) return response;

  const announce = async () => {
    if (revokedUserId) {
      await publishSessionEvent(c.env, revokedUserId, {
        type: 'session.changed',
        reason: isRevocation && path.endsWith('/sign-out') ? 'signed-out' : 'revoked',
        at: Date.now(),
      });
      return;
    }

    // A response that sets cookies may be a fresh sign in. Ask who it belongs
    // to using the cookies it just issued.
    const cookie = cookieHeaderFrom(response);
    if (!cookie) return;

    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session) return;

    await publishSessionEvent(c.env, session.user.id, {
      type: 'session.changed',
      reason: 'signed-in',
      at: Date.now(),
    });
  };

  // Never delay the user's response on fan out. In a test harness there is no
  // execution context, so fall back to awaiting.
  const ctx = (() => {
    try {
      return c.executionCtx;
    } catch {
      return undefined;
    }
  })();

  if (ctx) ctx.waitUntil(announce());
  else await announce();

  return response;
});
