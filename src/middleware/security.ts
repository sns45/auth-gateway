import { Next } from 'hono';
// import { CloudflareEnv } from '@/types/auth';
import { SECURITY_HEADERS } from '@/types/api';
import { AppContext } from '@/types/context';

/**
 * Security Headers Middleware
 * Adds comprehensive security headers to all responses
 */
export function createSecurityMiddleware() {
  return async (c: AppContext, next: Next) => {
    // Check if this is a docs route BEFORE processing
    const isDocsRoute = c.req.path.startsWith('/docs');
    
    await next();

    const env = c.env;

    // Core security headers
    Object.entries(SECURITY_HEADERS).forEach(([header, value]) => {
      c.header(header, value);
    });

    // Content Security Policy
    // Allow unpkg.com for Swagger UI on docs routes
    const csp = env.CONTENT_SECURITY_POLICY || (
      isDocsRoute 
        ? "default-src 'self' 'unsafe-inline' https://unpkg.com; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https:; font-src 'self' data: https://unpkg.com; connect-src 'self' https://unpkg.com"
        : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'"
    );
    c.header('Content-Security-Policy', csp);

    // Additional security headers
    c.header('Cross-Origin-Embedder-Policy', 'require-corp');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'cross-origin');
    
    // Remove server information
    c.header('Server', '');
  };
}

/**
 * CSRF Protection Middleware
 */
export function createCSRFMiddleware() {
  return async (c: AppContext, next: Next) => {
    const env = c.env;
    const method = c.req.method;

    // Skip CSRF protection for safe methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      await next();
      return;
    }

    // Skip if CSRF protection is disabled
    if (env.ENABLE_CSRF_PROTECTION === 'false') {
      await next();
      return;
    }

    const origin = c.req.header('origin');
    const _referer = c.req.header('referer');
    const _csrfToken = c.req.header('x-csrf-token');

    // Check if request is from allowed origin
    if (origin) {
      const allowedOrigins = env.ALLOWED_ORIGINS?.split(',') || [];
      const isAllowedOrigin = allowedOrigins.some(allowed => 
        origin === allowed.trim()
      );

      if (!isAllowedOrigin) {
        return c.json({
          success: false,
          error: {
            message: 'CSRF protection: Invalid origin',
            code: 'CSRF_ERROR',
          }
        }, 403);
      }
    }

    // For session-based requests, check SameSite cookie policy
    // The browser's SameSite=Strict policy provides CSRF protection

    await next();
  };
}

/**
 * Request Size Limiting Middleware
 */
export function createRequestSizeLimitMiddleware(maxSize: number = 1024 * 1024) { // 1MB default
  return async (c: AppContext, next: Next) => {
    const contentLength = c.req.header('content-length');
    
    if (contentLength && parseInt(contentLength) > maxSize) {
      return c.json({
        success: false,
        error: {
          message: 'Request entity too large',
          code: 'REQUEST_TOO_LARGE',
          details: `Maximum request size is ${maxSize} bytes`,
        }
      }, 413);
    }

    await next();
  };
}

/**
 * IP Filtering Middleware
 */
export function createIPFilterMiddleware(options: {
  allowlist?: string[];
  blocklist?: string[];
} = {}) {
  const { allowlist = [], blocklist = [] } = options;

  return async (c: AppContext, next: Next) => {
    const ip = getClientIP(c);

    // Check blocklist first
    if (blocklist.length > 0 && isIPInList(ip, blocklist)) {
      return c.json({
        success: false,
        error: {
          message: 'Access denied',
          code: 'IP_BLOCKED',
        }
      }, 403);
    }

    // Check allowlist if configured
    if (allowlist.length > 0 && !isIPInList(ip, allowlist)) {
      return c.json({
        success: false,
        error: {
          message: 'Access denied',
          code: 'IP_NOT_ALLOWED',
        }
      }, 403);
    }

    await next();
  };
}

/**
 * User Agent Filtering Middleware
 */
export function createUserAgentFilterMiddleware(options: {
  blockedPatterns?: RegExp[];
  requiredPatterns?: RegExp[];
} = {}) {
  const { blockedPatterns = [], requiredPatterns = [] } = options;

  return async (c: AppContext, next: Next) => {
    const userAgent = c.req.header('user-agent') || '';

    // Check blocked patterns
    for (const pattern of blockedPatterns) {
      if (pattern.test(userAgent)) {
        return c.json({
          success: false,
          error: {
            message: 'Access denied',
            code: 'USER_AGENT_BLOCKED',
          }
        }, 403);
      }
    }

    // Check required patterns
    for (const pattern of requiredPatterns) {
      if (!pattern.test(userAgent)) {
        return c.json({
          success: false,
          error: {
            message: 'Access denied',
            code: 'USER_AGENT_REQUIRED',
          }
        }, 403);
      }
    }

    await next();
  };
}

/**
 * Request ID Middleware
 * Adds unique request ID for tracing
 */
export function createRequestIdMiddleware() {
  return async (c: AppContext, next: Next) => {
    const existingId = c.req.header('x-request-id');
    const requestId = existingId || generateRequestId();
    
    c.set('requestId', requestId);
    c.header('X-Request-ID', requestId);

    await next();
  };
}

/**
 * Performance Monitoring Middleware
 */
export function createPerformanceMiddleware() {
  return async (c: AppContext, next: Next) => {
    const start = Date.now();
    const requestId = c.get('requestId') || 'unknown';

    await next();

    const duration = Date.now() - start;
    c.header('X-Response-Time', `${duration}ms`);

    // Log performance metrics
    if (c.env.ENABLE_PERFORMANCE_MONITORING === 'true') {
      const method = c.req.method;
      const path = c.req.path;
      const status = c.res.status;
      
      console.log(`[PERF] ${requestId}: ${method} ${path} ${status} ${duration}ms`);
      
      // You could send this data to a monitoring service here
    }
  };
}

/**
 * Helper Functions
 */

function getClientIP(c: AppContext): string {
  const headers = [
    'cf-connecting-ip',
    'x-forwarded-for',
    'x-real-ip',
    'x-client-ip',
  ];

  for (const header of headers) {
    const value = c.req.header(header);
    if (value) {
      return value.split(',')[0].trim();
    }
  }

  return c.req.header('remote-addr') || 'unknown';
}

function isIPInList(ip: string, list: string[]): boolean {
  return list.some(item => {
    // Support CIDR notation and exact matches
    if (item.includes('/')) {
      // For CIDR matching, you'd need a proper CIDR library
      // This is a simplified check
      return ip.startsWith(item.split('/')[0].slice(0, -1));
    }
    return ip === item;
  });
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Combined security middleware stack
 */
export function createSecurityStack() {
  return [
    createRequestIdMiddleware(),
    createSecurityMiddleware(),
    createCSRFMiddleware(),
    createRequestSizeLimitMiddleware(),
    createPerformanceMiddleware(),
  ];
}

/**
 * Development security middleware (more relaxed)
 */
export function createDevelopmentSecurityMiddleware() {
  return async (c: AppContext, next: Next) => {
    await next();

    // Basic security headers for development
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    c.header('X-Request-ID', c.get('requestId') || generateRequestId());
  };
}