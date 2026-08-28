import { Hono } from 'hono';
import { CloudflareEnv } from '@/types/auth';
import { Variables } from '@/types/context';
import { createAuth } from '@/auth';

/**
 * Live session channel.
 *
 *   GET /api/auth/session-stream   websocket upgrade, requires a session
 *
 * Authenticated before the upgrade for two reasons: the hub is addressed by
 * user id, which only a valid session yields, and an unauthenticated caller
 * should not be able to hold connections open against a Durable Object.
 */
export const sessionStreamRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

sessionStreamRoutes.get('/', async (c) => {
  // Authentication is checked before the upgrade, deliberately. An
  // unauthenticated caller should get the same 401 whether or not it managed a
  // valid handshake, rather than being told about the protocol first. It also
  // avoids depending on the Upgrade header surviving: workerd drops it on a
  // request that is not a conforming websocket handshake.
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: 'Authentication required' }, 401);
  }

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
