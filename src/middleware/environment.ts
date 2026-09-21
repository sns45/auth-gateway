import { Next } from 'hono';
import { AppContext } from '@/types/context';

/** Explicit deployment labels are for diagnostics and storage namespaces only. */
export async function environmentDetectionMiddleware(c: AppContext, next: Next) {
  const hostname = new URL(c.req.url).hostname;
  const nodeEnv = c.env.NODE_ENV ?? 'production';
  const logLevel = c.env.LOG_LEVEL ?? 'info';

  c.env.NODE_ENV = nodeEnv;
  c.env.LOG_LEVEL = logLevel;
  
  // Log the configured environment
  if (logLevel === 'debug') {
    console.log(`[ENV] Configured environment: ${nodeEnv} (${hostname})`);
  }
  
  // Set environment in context for other middleware
  c.set('environment', {
    nodeEnv,
    logLevel,
    hostname,
    isProduction: nodeEnv === 'production',
    isStaging: nodeEnv === 'staging',
    isDevelopment: nodeEnv === 'development',
  });
  
  await next();
}
