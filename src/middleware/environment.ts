import { Next } from 'hono';
import { AppContext } from '@/types/context';

/**
 * Environment Detection Middleware
 * 
 * Detects the environment based on the request hostname
 * and sets appropriate environment variables
 */
export async function environmentDetectionMiddleware(
  c: AppContext,
  next: Next
) {
  const hostname = new URL(c.req.url).hostname;

  // The configured NODE_ENV (wrangler vars / .dev.vars) is authoritative:
  // hostnames are deployment-specific and must not be hardcoded here. Only
  // when nothing is configured do we infer: localhost means development,
  // an auth-staging.* hostname means staging, anything else deployed means
  // production. Overriding a configured value from a hostname list is what
  // once sent production sessions to the dev prefix and dropped the cookie
  // Domain attribute.
  let nodeEnv = c.env.NODE_ENV as 'production' | 'staging' | 'development' | undefined;
  if (!nodeEnv) {
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      nodeEnv = 'development';
    } else if (hostname.startsWith('auth-staging.')) {
      nodeEnv = 'staging';
    } else {
      nodeEnv = 'production';
    }
  }
  const logLevel =
    (c.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ??
    (nodeEnv === 'development' ? 'debug' : 'info');

  c.env.NODE_ENV = nodeEnv;
  c.env.LOG_LEVEL = logLevel;
  
  // Log the detected environment
  if (logLevel === 'debug') {
    console.log(`[ENV] Detected environment: ${nodeEnv} (${hostname})`);
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

/**
 * Get environment-specific configuration
 */
export function getEnvironmentConfig(hostname: string) {
  const isProduction = hostname === 'auth.example.com';
  const isStaging = hostname === 'auth-staging.example.com';
  
  return {
    environment: isProduction ? 'production' : isStaging ? 'staging' : 'development',
    corsOrigins: isProduction 
      ? ['https://example.com', 'https://app.example.com']
      : isStaging
      ? ['https://staging.example.com', 'https://app-staging.example.com', 'https://auth-staging.example.com']
      : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173', 'http://localhost:8787'],
    securityHeaders: {
      strictTransportSecurity: isProduction || isStaging,
      contentSecurityPolicy: isProduction,
    },
    rateLimits: {
      anonymous: isProduction ? 10 : 50,
      authenticated: isProduction ? 100 : 500,
      premium: isProduction ? 500 : 1000,
    },
  };
}