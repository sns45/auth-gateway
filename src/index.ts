import { Hono } from 'hono';
import { z } from 'zod';
import { CloudflareEnv } from '@/types/auth';
import { Variables } from '@/types/context';
import { EnvironmentSchema } from '@/utils/validation';
import { APIErrorCodes } from '@/types/api';

// Middleware
import { createEnhancedCORSMiddleware } from '@/middleware/cors';
import { createRateLimitMiddleware } from '@/middleware/rate-limit';
import { createSecurityStack, createDevelopmentSecurityMiddleware } from '@/middleware/security';
import { createLoggingStack } from '@/middleware/logging';
import { environmentDetectionMiddleware } from '@/middleware/environment';

// Routes
import { authRoutes } from '@/routes/auth';
import { healthRoutes } from '@/routes/health';
import { sessionStreamRoutes } from '@/routes/session-stream';
import { BROWSER_CLIENT_JS } from '@/client/browser-client';
import { DEMO_PAGE_HTML } from '@/client/demo-page';

/**
 * Hono Authentication Gateway Application
 */
const app = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * Environment detection middleware (must run first)
 */
app.use('*', environmentDetectionMiddleware);

/**
 * Environment validation middleware
 */
app.use('*', async (c, next) => {
  try {
    // Only log on first request or if there are issues
    if (!globalThis.envLogged) {
      console.log('Environment check: All required variables present');
      globalThis.envLogged = true;
    }
    
    // Validate environment variables and add the runtime bindings
    const validatedEnv = {
      ...EnvironmentSchema.parse(c.env),
      AUTH_STORE: c.env.AUTH_STORE,  // KV namespace from the Cloudflare runtime
      AUTH_DB: c.env.AUTH_DB,        // D1 session database from the Cloudflare runtime
      SESSION_HUB: c.env.SESSION_HUB // Per user fan out for live session changes
    };
    
    // Store validated environment for use in other middleware
    c.set('validatedEnv', validatedEnv);
    
    await next();
  } catch (error) {
    console.error('Environment validation failed:', error);
    if (error instanceof z.ZodError) {
      console.error('Validation errors:', error.errors);
    }
    return c.json({
      success: false,
      error: {
        message: 'Server configuration error',
        code: APIErrorCodes.INTERNAL_ERROR,
        details: 'Invalid environment configuration',
      }
    }, 500);
  }
});

/**
 * Apply security middleware stack based on detected environment
 */
app.use('*', async (c, next) => {
  const env = c.get('environment');
  if (env.isProduction) {
    // Production security middleware
    const stack = createSecurityStack();
    // Apply security middleware in sequence
    let currentNext = next;
    for (let i = stack.length - 1; i >= 0; i--) {
      const middleware = stack[i];
      const previousNext = currentNext;
      currentNext = async () => {
        await middleware(c, previousNext);
      };
    }
    await currentNext();
  } else {
    // Development security middleware (more relaxed)
    await createDevelopmentSecurityMiddleware()(c, next);
  }
});

/**
 * Apply logging middleware
 */
// Apply each logging middleware separately to ensure proper context handling
const loggingStack = createLoggingStack();
loggingStack.forEach(middleware => {
  app.use('*', middleware);
});

/**
 * Apply CORS middleware
 */
app.use('*', createEnhancedCORSMiddleware());

/**
 * Apply rate limiting (except for health checks)
 */
// Scoped to the routed surfaces ('/api/*' also covers '/api/auth/*') rather
// than every path. Each rate limit check costs a KV write, so mounting this on
// '*' meant unrouted paths paid for a write before the router could 404 them.
// In practice those are almost entirely vulnerability scans (/.env, /@fs/...,
// /.git/config), which is enough on its own to exhaust the daily KV write quota
// and, once exhausted, to take real logins down with it.
const rateLimit = createRateLimitMiddleware({
  // Session probes are read-only, fired on every page view by frontends,
  // and each rate limit check costs KV reads/writes; exempt them.
  skipPaths: ['/health', '/metrics', '/api/auth/get-session', '/auth/get-session'],
});
app.use('/api/*', rateLimit);

/**
 * Mount route handlers
 */

// Root endpoint (must be before proxy routes)
app.get('/', (c) => {
  return c.json({
    name: 'Hono Authentication Gateway',
    version: '1.0.0',
    environment: c.env.NODE_ENV,
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      auth: '/auth',
      api: '/api/*',
      websocket: '/api/ws',
      sync: '/api/1.25.4/sync',
      versioned_sync: '/api/*/sync',
      docs: '/docs',
    },
    websocket_info: {
      supported_endpoints: [
        '/api/ws',
        '/api/1.25.4/sync',
        '/api/*/sync'
      ],
      upgrade_required: 'WebSocket upgrade headers required',
      auth_required: 'Bearer token authentication required'
    },
    documentation: 'https://auth.example.com/docs',
    openapi: '/docs/openapi.yaml',
  });
});

// Test OAuth page (development only)
app.get('/test-oauth.html', async (c) => {
  const env = c.get('environment');
  if (env.isProduction) {
    return c.notFound();
  }
  
  // In a real deployment, this would be served from a CDN or static host
  // For local testing, we'll return a simple redirect message
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>OAuth Test</title>
      <meta http-equiv="refresh" content="0; url=/docs">
    </head>
    <body>
      <p>Redirecting to API documentation...</p>
      <p>For OAuth testing, please use the interactive API documentation at <a href="/docs">/docs</a></p>
    </body>
    </html>
  `);
});

// Test endpoint to verify middleware is working
app.get('/test', (c) => {
  return c.json({
    success: true,
    requestId: c.get('requestId'),
    hasLogger: !!c.get('logger'),
    environment: c.get('environment'),
  });
});

// Health check routes (no authentication required)
app.route('/health', healthRoutes);

// Better Auth owns everything under /api/auth, including its own generated
// OpenAPI reference at /api/auth/reference. Mounted only here: Better Auth
// matches on its full basePath, so a second mount at /auth would not resolve.
// Drop in browser client. Onboarding a new site is a script tag plus a
// subscribe call; the sync mechanics live in the gateway, not in each client.
app.get('/client.js', () => {
  return new Response(BROWSER_CLIENT_JS, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
});

// Live integration example. Also the only way to start an OAuth flow by hand:
// Better Auth keeps the state in a browser cookie as well as in the database,
// so a sign in URL minted outside a browser always fails state_mismatch.
app.get('/demo', () => {
  return new Response(DEMO_PAGE_HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
});

// Live session channel. Mounted ahead of the Better Auth passthrough, which
// would otherwise swallow the path as an unknown Better Auth route.
app.route('/api/auth/session-stream', sessionStreamRoutes);

app.route('/api/auth', authRoutes);

/**
 * Catch-all for undefined routes
 */
app.notFound((c) => {
  return c.json({
    success: false,
    error: {
      message: 'Endpoint not found',
      code: APIErrorCodes.RESOURCE_NOT_FOUND,
      details: `The requested endpoint ${c.req.method} ${c.req.path} does not exist`,
    }
  }, 404);
});

/**
 * Global error handler
 */
app.onError((error, c) => {
  const logger = c.get('logger');
  const requestId = c.get('requestId') || 'unknown';
  
  console.error(`[ERROR] ${requestId}:`, error);
  
  if (logger) {
    logger.error('Unhandled application error', {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      requestId,
      path: c.req.path,
      method: c.req.method,
    });
  }

  return c.json({
    success: false,
    error: {
      message: 'Internal server error',
      code: APIErrorCodes.INTERNAL_ERROR,
      request_id: requestId,
    }
  }, 500);
});

/**
 * Application startup logging
 */
declare global {
  var startTime: number | undefined;
  var envLogged: boolean | undefined;
}

if (typeof globalThis.startTime === 'undefined') {
  globalThis.startTime = Date.now();
  console.log(`[STARTUP] Hono Auth Gateway starting at ${new Date().toISOString()}`);
}

export default app;

/**
 * Export for Cloudflare Workers
 */
export { app };

/**
 * Export types for external use
 */
export type { CloudflareEnv } from '@/types/auth';
export type { ApiResponse, HealthCheckResponse } from '@/types/api';

/**
 * Export the Better Auth factory for tests and for embedding the gateway
 */
export { createAuth } from '@/auth';

/**
 * Durable Object class, referenced by the SESSION_HUB binding in wrangler.toml
 */
export { SessionHub } from '@/durable/session-hub';

/**
 * Development server support (for local development)
 */
// @ts-expect-error - module.hot is available in development environment for HMR
if (typeof module !== 'undefined' && module.hot) {
  // @ts-expect-error - module.hot types not available in production build
  module.hot.accept();
}

/**
 * Handle process signals for graceful shutdown (Node.js environments)
 */
if (typeof process !== 'undefined') {
  const gracefulShutdown = () => {
    console.log('[SHUTDOWN] Gracefully shutting down...');
    // Perform cleanup here if needed
    process.exit(0);
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}