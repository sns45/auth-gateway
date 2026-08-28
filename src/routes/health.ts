import { Hono } from 'hono';
import { CloudflareEnv } from '@/types/auth';
import { Variables } from '@/types/context';

/**
 * Health routes.
 *
 * The only dependency that can take auth down is D1: sessions live there and
 * there is no fallback store by design, so the probe queries it for real. A
 * probe that cannot fail is worse than no probe, which is what the previous
 * version was after its session store call swallowed every error.
 */
export const healthRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

interface ProbeResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

async function probeDatabase(env: CloudflareEnv): Promise<ProbeResult> {
  const started = Date.now();
  try {
    // Touches the session table specifically, so a missing migration shows up
    // as unhealthy rather than as a puzzling 500 on first sign in.
    await env.AUTH_DB.prepare('SELECT COUNT(*) AS count FROM "session"').first<{ count: number }>();
    return { ok: true, latency_ms: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latency_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Liveness: the worker is running. Never touches a dependency. */
healthRoutes.get('/live', (c) => c.json({ status: 'alive', timestamp: new Date().toISOString() }));

/** Readiness: the worker can actually serve auth. */
healthRoutes.get('/ready', async (c) => {
  const database = await probeDatabase(c.env);
  return c.json(
    {
      status: database.ok ? 'ready' : 'not_ready',
      database,
      timestamp: new Date().toISOString(),
    },
    database.ok ? 200 : 503
  );
});

healthRoutes.get('/', async (c) => {
  const database = await probeDatabase(c.env);
  return c.json(
    {
      status: database.ok ? 'healthy' : 'unhealthy',
      version: '2.0.0',
      environment: c.env.NODE_ENV,
      checks: { database },
      timestamp: new Date().toISOString(),
    },
    database.ok ? 200 : 503
  );
});

healthRoutes.get('/detailed', async (c) => {
  const database = await probeDatabase(c.env);
  let activeSessions: number | null = null;
  if (database.ok) {
    const row = await c.env.AUTH_DB.prepare(
      'SELECT COUNT(*) AS count FROM "session" WHERE "expiresAt" > ?'
    )
      .bind(new Date().toISOString())
      .first<{ count: number }>();
    activeSessions = row?.count ?? 0;
  }

  return c.json(
    {
      status: database.ok ? 'healthy' : 'unhealthy',
      version: '2.0.0',
      environment: c.env.NODE_ENV,
      checks: { database },
      metrics: { active_sessions: activeSessions },
      uptime_ms: globalThis.startTime ? Date.now() - globalThis.startTime : null,
      timestamp: new Date().toISOString(),
    },
    database.ok ? 200 : 503
  );
});
