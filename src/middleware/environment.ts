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
  
  // Determine environment based on hostname
  let nodeEnv: 'production' | 'staging' | 'development' = 'development';
  let logLevel: 'debug' | 'info' | 'warn' | 'error' = 'debug';
  
  if (hostname === 'auth.example.com') {
    nodeEnv = 'production';
    logLevel = 'warn';
  } else if (hostname === 'auth-staging.example.com') {
    nodeEnv = 'staging';
    logLevel = 'info';
  } else {
    // Default to development for localhost and other domains
    nodeEnv = 'development';
    logLevel = 'debug';
  }
  
  // Override the environment variables
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