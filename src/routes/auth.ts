import { Hono } from 'hono';
import { splitSetCookieHeader } from 'better-auth/cookies';
import { CloudflareEnv } from '@/types/auth';
import { Variables } from '@/types/context';
import { createAuth } from '@/auth';
import { authorizeAdministratorEmail } from '@/policy/administrator';

/**
 * Better Auth handles generic authentication. Platform clients explicitly use
 * administrator-session to apply their configured product access policy.
 */
export const authRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

authRoutes.get('/administrator-session', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const auth = createAuth(c.env, c.get('authConfig'));
  const { response: session, headers } = await auth.api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
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
