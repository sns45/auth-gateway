import { Hono } from 'hono';
import { CloudflareEnv } from '@/types/auth';
import { Variables } from '@/types/context';
import { HealthCheckResponse } from '@/types/api';
import { ConvexService } from '@/services/convex';
import { SessionService } from '@/services/session';
import { Logger } from '@/middleware/logging';

/**
 * Health Check Routes
 */
export const healthRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * GET /health - Basic health check
 */
healthRoutes.get('/', async (c) => {
  const startTime = Date.now();
  const logger = c.get('logger') as Logger;
  
  try {
    // Basic health indicators
    const timestamp = new Date().toISOString();
    const uptime = Date.now() - (globalThis.startTime || Date.now());
    
    // Check dependencies
    const convexService = new ConvexService(c.env, logger);
    const sessionService = new SessionService(c.env, logger);
    
    // Parallel health checks
    const [convexHealth, sessionHealth, memoryStats] = await Promise.allSettled([
      checkConvexHealth(convexService),
      checkSessionStoreHealth(sessionService),
      getMemoryStats(),
    ]);

    const checks: {
      convex: 'healthy' | 'unhealthy';
      session_store: 'healthy' | 'unhealthy';
      database: 'healthy' | 'unhealthy';
    } = {
      convex: convexHealth.status === 'fulfilled' ? 
        (convexHealth.value ? 'healthy' : 'unhealthy') : 'unhealthy',
      session_store: sessionHealth.status === 'fulfilled' ? 
        (sessionHealth.value ? 'healthy' : 'unhealthy') : 'unhealthy',
      database: 'healthy', // Placeholder - would check database if separate
    };

    // Determine overall status
    const hasUnhealthy = Object.values(checks).includes('unhealthy');
    const status = hasUnhealthy ? 'unhealthy' : 'healthy';

    // Get performance metrics
    const responseTime = Date.now() - startTime;
    const memory = memoryStats.status === 'fulfilled' ? memoryStats.value : { usage: 0, limit: 0 };
    
    const response: HealthCheckResponse = {
      status,
      timestamp,
      version: '1.0.0',
      uptime,
      checks,
      metrics: {
        memory_usage: memory.usage,
        cpu_usage: 0, // Not available in Workers environment
        active_sessions: 0, // Would need separate tracking
        requests_per_minute: 0, // Would need metrics collection
      },
    };

    const statusCode = status === 'healthy' ? 200 : 503;
    
    logger.debug(`Health check completed`, {
      status,
      responseTime,
      checks,
    });

    return c.json(response, statusCode);

  } catch (_error) {
    logger.error(`Health check error`, _error);
    
    const response: HealthCheckResponse = {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      uptime: 0,
      checks: {
        convex: 'unhealthy',
        session_store: 'unhealthy', 
        database: 'unhealthy',
      },
      metrics: {
        memory_usage: 0,
        cpu_usage: 0,
        active_sessions: 0,
        requests_per_minute: 0,
      },
    };

    return c.json(response, 500);
  }
});

/**
 * GET /health/detailed - Detailed health check with more metrics
 */
healthRoutes.get('/detailed', async (c) => {
  const startTime = Date.now();
  const logger = c.get('logger') as Logger;
  
  try {
    const convexService = new ConvexService(c.env, logger);
    const sessionService = new SessionService(c.env, logger);
    
    // Comprehensive health checks
    const [
      convexHealth,
      sessionHealth,
      convexResponseTime,
      sessionResponseTime,
      memoryStats,
      environmentCheck,
    ] = await Promise.allSettled([
      checkConvexHealth(convexService),
      checkSessionStoreHealth(sessionService),
      measureConvexResponseTime(convexService),
      measureSessionResponseTime(sessionService),
      getMemoryStats(),
      checkEnvironmentVariables(c.env),
    ]);

    const responseTime = Date.now() - startTime;
    
    const detailedResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      environment: c.env.NODE_ENV,
      uptime: Date.now() - (globalThis.startTime || Date.now()),
      response_time_ms: responseTime,
      checks: {
        convex: {
          status: convexHealth.status === 'fulfilled' && convexHealth.value ? 'healthy' : 'unhealthy',
          response_time_ms: convexResponseTime.status === 'fulfilled' ? convexResponseTime.value : null,
          last_check: new Date().toISOString(),
        },
        session_store: {
          status: sessionHealth.status === 'fulfilled' && sessionHealth.value ? 'healthy' : 'unhealthy',
          response_time_ms: sessionResponseTime.status === 'fulfilled' ? sessionResponseTime.value : null,
          last_check: new Date().toISOString(),
        },
        environment: {
          status: environmentCheck.status === 'fulfilled' && environmentCheck.value ? 'healthy' : 'degraded',
          missing_variables: environmentCheck.status === 'fulfilled' ? [] : ['Multiple variables missing'],
        },
      },
      metrics: {
        memory: memoryStats.status === 'fulfilled' ? memoryStats.value : { usage: 0, limit: 0 },
        performance: {
          total_response_time_ms: responseTime,
          convex_response_time_ms: convexResponseTime.status === 'fulfilled' ? convexResponseTime.value : null,
          session_response_time_ms: sessionResponseTime.status === 'fulfilled' ? sessionResponseTime.value : null,
        },
        feature_flags: {
          cors_enabled: true,
          rate_limiting_enabled: true,
          security_headers_enabled: true,
          logging_enabled: c.env.ENABLE_REQUEST_LOGGING === 'true',
          performance_monitoring: c.env.ENABLE_PERFORMANCE_MONITORING === 'true',
        },
      },
      dependencies: {
        cloudflare_kv: 'available',
        jwt_signing: 'available',
        oauth_providers: getOAuthProviderStatus(c.env),
      },
    };

    // Determine overall status
    const hasUnhealthy = Object.values(detailedResponse.checks).some(
      (check: any) => check.status === 'unhealthy'
    );
    
    detailedResponse.status = hasUnhealthy ? 'degraded' : 'healthy';
    const statusCode = hasUnhealthy ? 503 : 200;

    return c.json(detailedResponse, statusCode);

  } catch (_error) {
    logger.error(`Detailed health check error`, _error);
    return c.json({
      status: 'unhealthy',
      error: 'Health check failed',
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

/**
 * GET /health/ready - Readiness probe (for k8s/container orchestration)
 */
healthRoutes.get('/ready', async (c) => {
  const logger = c.get('logger') as Logger;
  try {
    const convexService = new ConvexService(c.env, logger);
    const isConvexReady = await checkConvexHealth(convexService);
    
    if (isConvexReady) {
      return c.json({ status: 'ready' });
    } else {
      return c.json({ status: 'not ready', reason: 'Convex service unavailable' }, 503);
    }
  } catch (_error) {
    return c.json({ status: 'not ready', reason: 'Health check failed' }, 503);
  }
});

/**
 * GET /health/live - Liveness probe (for k8s/container orchestration)
 */
healthRoutes.get('/live', async (c) => {
  // Simple liveness check - just verify the service is responding
  return c.json({ 
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /metrics - Prometheus-style metrics (basic implementation)
 */
healthRoutes.get('/metrics', async (c) => {
  const timestamp = Date.now();
  const uptime = timestamp - (globalThis.startTime || timestamp);
  
  // Basic Prometheus-style metrics
  const metrics = [
    `# HELP hono_gateway_uptime_seconds Total uptime in seconds`,
    `# TYPE hono_gateway_uptime_seconds counter`,
    `hono_gateway_uptime_seconds ${Math.floor(uptime / 1000)}`,
    '',
    `# HELP hono_gateway_info Application info`,
    `# TYPE hono_gateway_info gauge`,
    `hono_gateway_info{version="1.0.0",environment="${c.env.NODE_ENV}"} 1`,
    '',
    `# HELP hono_gateway_build_timestamp Build timestamp`,
    `# TYPE hono_gateway_build_timestamp gauge`, 
    `hono_gateway_build_timestamp ${Math.floor(timestamp / 1000)}`,
  ].join('\n');

  return new Response(metrics, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
});

/**
 * Helper Functions
 */

async function checkConvexHealth(convexService: ConvexService): Promise<boolean> {
  try {
    return await convexService.checkHealth();
  } catch {
    return false;
  }
}

async function checkSessionStoreHealth(sessionService: SessionService): Promise<boolean> {
  try {
    // Try to get session stats as a health check
    await sessionService.getSessionStats();
    return true;
  } catch {
    return false;
  }
}

async function measureConvexResponseTime(convexService: ConvexService): Promise<number> {
  const start = Date.now();
  try {
    await convexService.checkHealth();
    return Date.now() - start;
  } catch {
    return Date.now() - start;
  }
}

async function measureSessionResponseTime(sessionService: SessionService): Promise<number> {
  const start = Date.now();
  try {
    await sessionService.getSessionStats();
    return Date.now() - start;
  } catch {
    return Date.now() - start;
  }
}

async function getMemoryStats(): Promise<{ usage: number; limit: number }> {
  // Memory stats not directly available in Workers environment
  // This would be implementation-specific
  return {
    usage: 0,
    limit: 128 * 1024 * 1024, // 128MB typical Worker limit
  };
}

function checkEnvironmentVariables(env: CloudflareEnv): boolean {
  const required = [
    'JWT_SECRET',
    'SESSION_SECRET', 
    'CONVEX_URL',
    'CONVEX_DEPLOY_KEY',
    'ALLOWED_ORIGINS',
  ];

  return required.every(key => env[key as keyof CloudflareEnv]);
}

function getOAuthProviderStatus(env: CloudflareEnv): Record<string, string> {
  return {
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? 'configured' : 'not configured',
  };
}

// Initialize start time for uptime tracking
if (typeof globalThis.startTime === 'undefined') {
  globalThis.startTime = Date.now();
}