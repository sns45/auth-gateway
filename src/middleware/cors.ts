import { Next } from 'hono';
import { cors } from 'hono/cors';
import { CloudflareEnv } from '@/types/auth';
import { APIErrorCodes } from '@/types/api';
import { AppContext } from '@/types/context';
import { resolveAuthConfig, normalizeTrustedOrigins, type AuthConfig } from '@/config/auth';

/**
 * Dynamic CORS middleware with multi-domain support
 */
export function createCORSMiddleware() {
  return async (c: AppContext, next: Next) => {
    const env = c.env;
    const origin = c.req.header('origin');
    const allowedOrigins = (c.get('authConfig') ?? resolveAuthConfig(env)).trustedOrigins;

    // Validate origin
    let allowOrigin = false;
    let responseOrigin = '';

    if (origin && allowedOrigins.includes(origin)) {
      allowOrigin = true;
      responseOrigin = origin;
    }

    // Handle preflight requests
    if (c.req.method === 'OPTIONS') {
      if (!allowOrigin) {
        return c.json({
          success: false,
          error: {
            message: 'CORS preflight failed',
            code: APIErrorCodes.CORS_ERROR,
            details: `Origin ${origin} not allowed`,
          }
        }, 403);
      }

      // Return preflight response
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': responseOrigin,
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Client-Version',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin',
        },
      });
    }

    // For actual requests, continue with CORS headers
    await next();

    // Add CORS headers to response
    if (allowOrigin) {
      c.header('Access-Control-Allow-Origin', responseOrigin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
    }
  };
}

/**
 * Simple CORS middleware using Hono's built-in cors
 * Alternative approach for simpler setups
 */
export function createSimpleCORSMiddleware(origins: string[]) {
  const allowedOrigins = normalizeTrustedOrigins(origins.join(','));
  return cors({
    origin: (origin) => {
      if (!origin) return null;
      return allowedOrigins.includes(origin) ? origin : null;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Client-Version'],
    maxAge: 86400,
  });
}

/**
 * CORS configuration for different environments
 */
export function getCORSConfig(env: CloudflareEnv, policy: AuthConfig = resolveAuthConfig(env)) {
  const allowedOrigins = policy.trustedOrigins;

  return {
    allowedOrigins,
    allowCredentials: true,
    allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-Client-Version',
      'Accept',
      'Origin',
      'Cache-Control',
      'X-CSRF-Token',
    ],
    exposedHeaders: [
      'X-Request-ID',
      'X-Response-Time',
      'X-Rate-Limit-Limit',
      'X-Rate-Limit-Remaining',
      'X-Rate-Limit-Reset',
    ],
    maxAge: 86400, // 24 hours
  };
}

/**
 * Enhanced CORS middleware with comprehensive logging and monitoring
 */
export function createEnhancedCORSMiddleware() {
  return async (c: AppContext, next: Next) => {
    const env = c.env;
    const origin = c.req.header('origin');
    const method = c.req.method;
    const requestId = c.get('requestId') || 'unknown';
    
    const config = getCORSConfig(env, c.get('authConfig'));
    
    // Log CORS request for monitoring
    if (env.LOG_LEVEL === 'debug') {
      console.log(`[CORS] ${requestId}: ${method} ${origin || 'no-origin'}`);
    }

    // Validate origin
    let isAllowed = false;
    if (origin) {
      isAllowed = config.allowedOrigins.includes(origin);
    }

    // Handle preflight
    if (method === 'OPTIONS') {
      if (origin && !isAllowed) {
        console.warn(`[CORS] ${requestId}: Rejected preflight from ${origin}`);
        return c.json({
          success: false,
          error: {
            message: 'CORS policy violation',
            code: APIErrorCodes.INVALID_ORIGIN,
            details: 'Origin not allowed by CORS policy',
          }
        }, 403);
      }

      // Successful preflight
      const headers: Record<string, string> = {
        'Access-Control-Allow-Methods': config.allowedMethods.join(', '),
        'Access-Control-Allow-Headers': config.allowedHeaders.join(', '),
        'Access-Control-Max-Age': config.maxAge.toString(),
        'Vary': 'Origin',
      };

      if (origin && isAllowed) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Credentials'] = 'true';
      }

      return new Response(null, { status: 204, headers });
    }

    // Process actual request
    await next();

    // Add CORS headers to response
    if (origin && isAllowed) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Expose-Headers', config.exposedHeaders.join(', '));
      c.header('Vary', 'Origin');
    }

    // Log successful CORS
    if (env.LOG_LEVEL === 'debug' && origin && isAllowed) {
      console.log(`[CORS] ${requestId}: Allowed ${method} from ${origin}`);
    }
  };
}