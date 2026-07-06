import { Next } from 'hono';
import { CloudflareEnv, AuthContext, RateLimitConfig, RateLimitStatus } from '@/types/auth';
import { APIErrorCodes } from '@/types/api';
import { AppContext } from '@/types/context';

/**
 * Rate Limiting Middleware using Cloudflare KV for distributed rate limiting
 */
export class RateLimitService {
  private kv: KVNamespace;
  private configs: Map<string, RateLimitConfig>;
  private env: CloudflareEnv;

  constructor(env: CloudflareEnv) {
    this.env = env;
    this.kv = env.AUTH_STORE; // Using single KV store
    this.configs = new Map();
    this.initializeConfigs(env);
  }

  /**
   * Get environment prefix for KV keys
   */
  private getEnvPrefix(): string {
    switch (this.env.NODE_ENV) {
      case 'production':
        return 'prod';
      case 'staging':
        return 'staging';
      default:
        return 'dev';
    }
  }

  /**
   * Initialize rate limit configurations
   */
  private initializeConfigs(_env: CloudflareEnv) {
    const window = 900; // 15 minutes default
    
    // Anonymous users
    this.configs.set('anonymous', {
      window,
      max_requests: 10, // Default for anonymous
      identifier_key: 'ip',
    });

    // Authenticated users
    this.configs.set('authenticated', {
      window,
      max_requests: 100, // Default for authenticated
      identifier_key: 'user_id',
    });

    // Premium users
    this.configs.set('premium', {
      window,
      max_requests: 500, // Default for premium
      identifier_key: 'user_id',
    });

    // Global rate limit (per IP)
    this.configs.set('global', {
      window: 60, // 1 minute
      max_requests: 200,
      identifier_key: 'ip',
    });
  }

  /**
   * Check rate limit for a given identifier
   */
  async checkRateLimit(
    identifier: string,
    configKey: string = 'anonymous'
  ): Promise<RateLimitStatus> {
    const config = this.configs.get(configKey);
    if (!config) {
      throw new Error(`Rate limit config not found: ${configKey}`);
    }

    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - config.window;
    const key = `${this.getEnvPrefix()}:ratelimit:${configKey}:${identifier}`;

    try {
      // Get current rate limit data
      const data = await this.kv.get(key);
      let requests: number[] = [];
      
      if (data) {
        requests = JSON.parse(data);
        // Filter out requests outside the current window
        requests = requests.filter(timestamp => timestamp > windowStart);
      }

      // Add current request
      requests.push(now);

      // Check if limit exceeded
      const remaining = Math.max(0, config.max_requests - requests.length);
      const isLimited = requests.length > config.max_requests;

      // Store updated requests with environment prefix
      await this.kv.put(key, JSON.stringify(requests), {
        expirationTtl: config.window + 60, // Add buffer for cleanup
      });

      const resetTime = windowStart + config.window;
      const retryAfter = isLimited ? resetTime - now : undefined;

      return {
        limit: config.max_requests,
        remaining,
        reset: resetTime,
        retry_after: retryAfter,
      };
    } catch (error) {
      console.error('Rate limit check error:', error);
      // On error, allow request but log
      return {
        limit: config.max_requests,
        remaining: config.max_requests,
        reset: now + config.window,
      };
    }
  }

  /**
   * Get rate limit configuration for user type
   */
  private getRateLimitConfig(authContext?: AuthContext): string {
    if (!authContext) {
      return 'anonymous';
    }

    // Check for premium users (example logic)
    if (authContext.user.role === 'admin' || 
        authContext.permissions.includes('premium')) {
      return 'premium';
    }

    return 'authenticated';
  }

  /**
   * Create rate limiting middleware
   */
  createMiddleware(options: {
    skipPaths?: string[];
    customConfig?: string;
    keyGenerator?: (c: AppContext) => string;
  } = {}) {
    const { skipPaths = [], customConfig, keyGenerator } = options;

    return async (c: AppContext, next: Next) => {
      const path = c.req.path;
      const requestId = c.get('requestId') || 'unknown';

      // Skip rate limiting for certain paths
      if (skipPaths.some(skipPath => path.startsWith(skipPath))) {
        await next();
        return;
      }

      try {
        const authContext = c.get('auth') as AuthContext;
        const ip = this.getClientIP(c);

        // Determine rate limit configuration. This middleware runs before
        // auth is established, so authContext is usually absent here; treat
        // requests that present session credentials as authenticated for
        // budgeting (presence is spoofable, but it only buys the larger
        // bucket, and invalid sessions still fail auth downstream).
        let configKey = customConfig || this.getRateLimitConfig(authContext);
        if (configKey === 'anonymous') {
          const hasSessionCredentials =
            !!c.req.header('authorization') ||
            (c.req.header('cookie') || '').includes('auth_session');
          if (hasSessionCredentials) {
            configKey = 'authenticated';
          }
        }
        
        // Generate identifier
        let identifier: string;
        if (keyGenerator) {
          identifier = keyGenerator(c);
        } else if (authContext && configKey !== 'anonymous') {
          identifier = authContext.user.id;
        } else {
          identifier = ip;
        }

        // Check rate limit
        const rateLimitStatus = await this.checkRateLimit(identifier, configKey);
        
        // Set rate limit headers
        c.header('X-Rate-Limit-Limit', rateLimitStatus.limit.toString());
        c.header('X-Rate-Limit-Remaining', rateLimitStatus.remaining.toString());
        c.header('X-Rate-Limit-Reset', rateLimitStatus.reset.toString());

        // Check global rate limit as well
        const globalStatus = await this.checkRateLimit(ip, 'global');
        
        // If either limit is exceeded, return error
        if (rateLimitStatus.retry_after || globalStatus.retry_after) {
          const retryAfter = Math.max(
            rateLimitStatus.retry_after || 0,
            globalStatus.retry_after || 0
          );

          c.header('Retry-After', retryAfter.toString());
          
          console.warn(`[RATE_LIMIT] ${requestId}: Rate limit exceeded for ${identifier} (${configKey})`);
          
          return c.json({
            success: false,
            error: {
              message: 'Rate limit exceeded',
              code: APIErrorCodes.RATE_LIMITED,
              details: `Too many requests. Try again in ${retryAfter} seconds.`,
            },
            retry_after: retryAfter,
          }, 429);
        }

        // Store rate limit status in context for potential use in handlers
        c.set('rateLimit', rateLimitStatus);

        // Log successful rate limit check
        if (c.env.LOG_LEVEL === 'debug') {
          console.log(`[RATE_LIMIT] ${requestId}: ${identifier} (${configKey}) - ${rateLimitStatus.remaining}/${rateLimitStatus.limit} remaining`);
        }

        await next();
      } catch (error) {
        console.error(`[RATE_LIMIT] ${requestId}: Rate limit error:`, error);
        // On error, allow request to continue
        await next();
      }
    };
  }

  /**
   * Extract client IP address
   */
  private getClientIP(c: AppContext): string {
    // Try various headers in order of preference
    const headers = [
      'cf-connecting-ip',     // Cloudflare
      'x-forwarded-for',      // Proxies
      'x-real-ip',           // Nginx
      'x-client-ip',         // Various proxies
    ];

    for (const header of headers) {
      const value = c.req.header(header);
      if (value) {
        // X-Forwarded-For can contain multiple IPs, take the first one
        const ip = value.split(',')[0].trim();
        if (this.isValidIP(ip)) {
          return ip;
        }
      }
    }

    // Fallback to request IP (may not be available in all environments)
    return c.req.header('remote-addr') || 'unknown';
  }

  /**
   * Validate IP address format
   */
  private isValidIP(ip: string): boolean {
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    return ipv4Regex.test(ip) || ipv6Regex.test(ip);
  }
}

/**
 * Create rate limiting middleware
 */
export function createRateLimitMiddleware(options: {
  skipPaths?: string[];
  customConfig?: string;
} = {}) {
  return async (c: AppContext, next: Next) => {
    const rateLimitService = new RateLimitService(c.env);
    const middleware = rateLimitService.createMiddleware(options);
    return middleware(c, next);
  };
}

/**
 * Strict rate limiting for auth endpoints
 */
export const authRateLimit = createRateLimitMiddleware({
  customConfig: 'auth',
});

/**
 * API rate limiting
 */
export const apiRateLimit = createRateLimitMiddleware({
  skipPaths: ['/health', '/metrics'],
});

/**
 * Global rate limiting
 */
export const globalRateLimit = createRateLimitMiddleware();