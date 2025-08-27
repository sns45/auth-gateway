import { Next } from 'hono';
import { AuthContext } from '@/types/auth';
import { RequestMetrics } from '@/types/api';
import { AppContext } from '@/types/context';

/**
 * Logging levels
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Logger class for structured logging
 */
export class Logger {
  private level: LogLevel;
  private requestId: string;

  constructor(level: string = 'info', requestId: string = 'unknown') {
    this.level = this.parseLogLevel(level);
    this.requestId = requestId;
  }

  private parseLogLevel(level: string): LogLevel {
    switch (level.toLowerCase()) {
      case 'debug': return LogLevel.DEBUG;
      case 'info': return LogLevel.INFO;
      case 'warn': return LogLevel.WARN;
      case 'error': return LogLevel.ERROR;
      default: return LogLevel.INFO;
    }
  }

  private log(level: LogLevel, message: string, data?: any) {
    if (level < this.level) return;

    const timestamp = new Date().toISOString();
    const levelName = LogLevel[level];
    
    const logEntry = {
      timestamp,
      level: levelName,
      requestId: this.requestId,
      message,
      ...(data && { data }),
    };

    console.log(JSON.stringify(logEntry));
  }

  debug(message: string, data?: any) {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: any) {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: any) {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, error?: Error | any) {
    const errorData = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : error;
    
    this.log(LogLevel.ERROR, message, errorData);
  }
}

/**
 * Request Logging Middleware
 */
export function createLoggingMiddleware() {
  return async (c: AppContext, next: Next) => {
    const env = c.env;
    const start = Date.now();
    const requestId = c.get('requestId') || 'unknown';
    
    // Create logger instance
    const logger = new Logger(env.LOG_LEVEL || 'info', requestId);
    c.set('logger', logger);

    // Log request start
    const method = c.req.method;
    const path = c.req.path;
    const userAgent = c.req.header('user-agent') || 'unknown';
    const ip = getClientIP(c);

    if (env.ENABLE_REQUEST_LOGGING === 'true') {
      logger.info(`Request started`, {
        method,
        path,
        userAgent,
        ip,
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      });
    }

    let error: Error | null = null;

    try {
      await next();
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      throw error;
    } finally {
      // Log request completion
      const duration = Date.now() - start;
      const status = c.res.status;
      const authContext = c.get('auth') as AuthContext;
      
      const metrics: RequestMetrics = {
        request_id: requestId,
        method,
        path,
        status_code: status,
        duration_ms: duration,
        user_id: authContext?.user.id,
        ip_address: ip,
        user_agent: userAgent,
        timestamp: new Date().toISOString(),
      };

      if (error) {
        logger.error(`Request failed`, {
          ...metrics,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        });
      } else if (env.ENABLE_REQUEST_LOGGING === 'true') {
        const logLevel = status >= 400 ? 'warn' : 'info';
        logger[logLevel](`Request completed`, metrics);
      }

      // Store metrics for monitoring (you could send to analytics service)
      if (env.ENABLE_PERFORMANCE_MONITORING === 'true') {
        c.set('metrics', metrics);
      }
    }
  };
}

/**
 * Security Event Logging Middleware
 */
export function createSecurityLoggingMiddleware() {
  return async (c: AppContext, next: Next) => {
    const logger = c.get('logger') as Logger;
    const requestId = c.get('requestId') || 'unknown';
    const ip = getClientIP(c);
    const userAgent = c.req.header('user-agent') || 'unknown';

    // Log suspicious activities
    const suspiciousPatterns = [
      /\.\.\//,                    // Path traversal
      /<script/i,                  // XSS attempts
      /union.*select/i,            // SQL injection
      /javascript:/i,              // JavaScript injection
      /data:text\/html/i,          // Data URI attacks
    ];

    const path = c.req.path;
    const query = c.req.url.split('?')[1] || '';
    const fullUrl = c.req.url;

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(fullUrl) || pattern.test(query)) {
        logger.warn('Suspicious request detected', {
          pattern: pattern.source,
          url: fullUrl,
          ip,
          userAgent,
          requestId,
        });
        break;
      }
    }

    // Log authentication events
    const originalNext = next;
    next = async () => {
      await originalNext();
      
      const authContext = c.get('auth') as AuthContext;
      const status = c.res.status;

      // Log failed authentication
      if (status === 401 && path.startsWith('/auth/')) {
        logger.warn('Authentication failed', {
          path,
          ip,
          userAgent,
          requestId,
        });
      }

      // Log successful authentication
      if (status === 200 && path === '/auth/login' && authContext) {
        logger.info('User logged in', {
          userId: authContext.user.id,
          userRole: authContext.user.role,
          ip,
          userAgent,
          requestId,
        });
      }

      // Log logout
      if (status === 200 && path === '/auth/logout') {
        logger.info('User logged out', {
          userId: authContext?.user.id,
          ip,
          userAgent,
          requestId,
        });
      }
    };

    await next();
  };
}

/**
 * Audit Logging Middleware
 */
export function createAuditLoggingMiddleware() {
  return async (c: AppContext, next: Next) => {
    const logger = c.get('logger') as Logger;
    const method = c.req.method;
    const path = c.req.path;

    // Only audit state-changing operations
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      await next();
      return;
    }

    const authContext = c.get('auth') as AuthContext;
    const requestId = c.get('requestId') || 'unknown';
    const ip = getClientIP(c);

    // Log the action
    logger.info('Audit log', {
      action: `${method} ${path}`,
      userId: authContext?.user.id,
      userRole: authContext?.user.role,
      ip,
      requestId,
      timestamp: new Date().toISOString(),
    });

    await next();

    // Log the result
    const status = c.res.status;
    if (status >= 200 && status < 300) {
      logger.info('Audit log - success', {
        action: `${method} ${path}`,
        userId: authContext?.user.id,
        status,
        requestId,
      });
    } else if (status >= 400) {
      logger.warn('Audit log - failed', {
        action: `${method} ${path}`,
        userId: authContext?.user.id,
        status,
        requestId,
      });
    }
  };
}

/**
 * Error Logging Middleware
 */
export function createErrorLoggingMiddleware() {
  return async (c: AppContext, next: Next) => {
    try {
      await next();
    } catch (error) {
      const logger = c.get('logger') as Logger;
      const requestId = c.get('requestId') || 'unknown';
      const authContext = c.get('auth') as AuthContext;

      logger.error('Unhandled error', {
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        } : error,
        requestId,
        userId: authContext?.user.id,
        path: c.req.path,
        method: c.req.method,
      });

      // Re-throw to let error handler deal with it
      throw error;
    }
  };
}

/**
 * Helper function to get client IP
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

/**
 * Performance Metrics Collection
 */
export function createMetricsMiddleware() {
  return async (c: AppContext, next: Next) => {
    const start = performance.now();
    
    await next();
    
    const duration = performance.now() - start;
    const metrics = c.get('metrics') as RequestMetrics;
    
    if (metrics) {
      metrics.duration_ms = Math.round(duration);
      
      // Here you could send metrics to a monitoring service
      // For example: sendToDatadog(metrics), sendToCloudWatch(metrics), etc.
    }
  };
}

/**
 * Combined logging middleware stack
 */
export function createLoggingStack() {
  return [
    createLoggingMiddleware(),
    createSecurityLoggingMiddleware(),
    createAuditLoggingMiddleware(),
    createErrorLoggingMiddleware(),
    createMetricsMiddleware(),
  ];
}