import { Hono } from 'hono';
import { CloudflareEnv } from '@/types/auth';
import { Variables } from '@/types/context';
import { validateOrigin, parseAllowedOrigins } from '@/utils/validation';
import { createAuth } from '@/auth';

/**
 * Live session channel.
 *
 *   GET /api/auth/session-stream   websocket upgrade, requires a session
 *
 * Three gates, in this order, and the order is deliberate.
 */
export const sessionStreamRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

sessionStreamRoutes.get('/', async (c) => {
  // 1. Origin. A websocket handshake is not subject to the same origin policy
  //    and carries cookies, so without this any page on the internet could open
  //    a channel to a signed in visitor's hub, which is cross site websocket
  //    hijacking. Today SameSite=Lax happens to block that, because the gateway
  //    and its sites share a registrable domain. That is a fragile thing to
  //    depend on: the first client on a different domain would need
  //    SameSite=None, and this endpoint would silently become reachable from
  //    anywhere. The check does not depend on the cookie policy.
  //
  //    Browsers always send Origin on a websocket handshake, and there is no
  //    legitimate non browser caller for this endpoint, so a missing Origin is
  //    refused too.
  //
  //    Uses the same allowlist helpers as the CORS middleware on purpose. Two
  //    separate implementations of "which origins do we trust" is how one of
  //    them ends up more permissive than the other.
  const origin = c.req.header('origin');
  const allowedOrigins = parseAllowedOrigins(c.env.ALLOWED_ORIGINS || '');
  if (!origin || !validateOrigin(origin, allowedOrigins)) {
    return c.json({ error: 'Origin not allowed' }, 403);
  }

  // 2. Authentication, before the upgrade rather than after, so an
  //    unauthenticated caller gets the same 401 whether or not it managed a
  //    valid handshake. It also avoids depending on the Upgrade header
  //    surviving: workerd drops it on a non conforming handshake.
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  // 3. Protocol.
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'This endpoint requires a websocket upgrade' }, 426, {
      upgrade: 'websocket',
    });
  }

  const stub = c.env.SESSION_HUB.get(c.env.SESSION_HUB.idFromName(session.user.id));
  return stub.fetch('https://session-hub.internal/subscribe', {
    headers: { upgrade: 'websocket' },
  });
});
