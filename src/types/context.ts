import { Context } from 'hono';
import { CloudflareEnv } from './auth';
import { Logger } from '@/middleware/logging';
import { RateLimitStatus } from './auth';

/**
 * Extended Hono Context Variables
 */
export interface Variables {
  // No authentication variables. The gateway resolves a session through Better
  // Auth per request and hands it to the caller; nothing is stashed on the
  // context, so nothing here should imply an authenticated identity is
  // available to middleware.

  // Request tracking
  requestId: string;
  logger: Logger;
  
  // Environment
  environment: {
    nodeEnv: 'production' | 'staging' | 'development';
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    hostname: string;
    isProduction: boolean;
    isStaging: boolean;
    isDevelopment: boolean;
  };
  
  // Validation
  validatedEnv: CloudflareEnv;
  
  // Rate limiting
  rateLimit: RateLimitStatus;
  
  // Metrics
  metrics: {
    request_id: string;
    timestamp: string;
    method: string;
    path: string;
    status_code: number;
    duration_ms: number;
    user_id?: string;
    ip_address: string;
    user_agent: string;
    error?: string;
  };
}

/**
 * Extended Hono Context with CloudflareEnv bindings and Variables
 */
export type AppContext = Context<{
  Bindings: CloudflareEnv;
  Variables: Variables;
}>;
