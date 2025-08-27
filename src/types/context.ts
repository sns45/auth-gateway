import { Context } from 'hono';
import { CloudflareEnv, AuthContext, SessionData, UserProfile } from './auth';
import { Logger } from '@/middleware/logging';
import { RateLimitStatus } from './auth';

/**
 * Extended Hono Context Variables
 */
export interface Variables {
  // Authentication
  auth: AuthContext;
  user: UserProfile;
  session: SessionData;
  permissions: string[];
  
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

/**
 * Type guard for auth context
 */
export function hasAuthContext(c: AppContext): boolean {
  try {
    const auth = c.get('auth');
    return auth !== undefined && auth !== null;
  } catch {
    return false;
  }
}