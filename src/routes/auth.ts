import { Hono } from 'hono';
import { isAPIError } from 'better-auth/api';
import { splitSetCookieHeader } from 'better-auth/cookies';
import { CloudflareEnv } from '@/types/auth';
import { Variables } from '@/types/context';
import { createAuth, type Auth } from '@/auth';
import { authorizeAdministratorEmail } from '@/policy/administrator';

/**
 * Reads the session, renewing it when it is due.
 *
 * The renewal is a D1 write. When writes fail, for example once the account's
 * daily D1 write limit is spent, Better Auth reports the whole read as an
 * internal error and every signed in user is locked out until the limit resets.
 * The fallback reads the same row without renewing it. Expiry, revocation and
 * the email policy are still checked against the database, so it serves no
 * session the renewing read would have refused; the session simply stops
 * sliding forward until writes work again.
 */
async function readSession(auth: Auth, headers: Headers) {
  try {
    return await auth.api.getSession({ headers, returnHeaders: true });
  } catch (error) {
    if (!isAPIError(error) || error.status !== 'INTERNAL_SERVER_ERROR') throw error;
    console.warn('[SESSION] renewal failed, serving the session without renewing it');
    return auth.api.getSession({ headers, query: { disableRefresh: true }, returnHeaders: true });
  }
}

/**
 * Better Auth handles generic authentication. Platform clients explicitly use
 * administrator-session to apply their configured product access policy.
 */
export const authRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

authRoutes.get('/administrator-session', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const auth = createAuth(c.env, c.get('authConfig'));
  const { response: session, headers } = await readSession(auth, c.req.raw.headers);
  for (const cookie of splitSetCookieHeader(headers.get('set-cookie') ?? '')) {
    c.header('Set-Cookie', cookie, { append: true });
  }
  if (!session) {
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }
  if (!authorizeAdministratorEmail(session.user, c.env.AUTH_ALLOWED_DOMAINS)) {
    return c.json({ success: false, error: { code: 'FORBIDDEN', message: 'Administrator access required' } }, 403);
  }
  return c.json(session);
});

authRoutes.all('*', (c) => createAuth(c.env, c.get('authConfig')).handler(c.req.raw));
