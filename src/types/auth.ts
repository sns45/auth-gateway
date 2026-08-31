import { z } from 'zod';

// OAuth Provider Types
export type OAuthProvider = 'google';

export interface OAuthConfig {
  client_id: string;
  client_secret: string;
  authorize_url: string;
  token_url: string;
  user_info_url: string;
  scopes: string[];
}

// API Request/Response Schemas
export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  remember_me: z.boolean().optional().default(false),
});

export const RefreshTokenRequestSchema = z.object({
  refresh_token: z.string().optional(),
});

export const OAuthCallbackSchema = z.object({
  code: z.string(),
  state: z.string().optional(),
});

// Response Types
export interface AuthResponse {
  success: boolean;
  expires_at?: string;
  message?: string;
  code?: string;
}

export interface ErrorResponse {
  success: false;
  message: string;
  code: string;
  details?: string;
  request_id?: string;
}

// Rate Limiting Types
export interface RateLimitConfig {
  window: number; // seconds
  max_requests: number;
  identifier_key: string; // 'ip' | 'user_id' | 'session_id'
}

export interface RateLimitStatus {
  limit: number;
  remaining: number;
  reset: number;
  retry_after?: number;
}

// CORS Types
export interface CORSConfig {
  allowed_origins: string[];
  allow_credentials: boolean;
  allowed_methods: string[];
  allowed_headers: string[];
  max_age: number;
}

// Environment Types
export interface CloudflareEnv {
  // Authoritative session store. D1 is strongly consistent, so a revoked
  // session is gone on the very next read; KV was not, and could keep
  // authenticating a revoked session for up to a minute.
  AUTH_DB: D1Database;

  // KV, now only for rate limit counters
  AUTH_STORE: KVNamespace;

  // One Durable Object per user, fanning session changes out to that user's
  // open tabs across every device.
  SESSION_HUB: DurableObjectNamespace;
  
  // Secrets (from Doppler or wrangler secret)
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_SECRET?: string;

  // Variables (from wrangler.toml)
  NODE_ENV: 'production' | 'staging' | 'development';
  PORT?: string | number;
  ALLOWED_ORIGINS: string;
  FRONTEND_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';

  // Rate limiting (KV backed)
  RATE_LIMIT_WINDOW?: string | number;
  RATE_LIMIT_MAX?: string | number;
  KV_NAMESPACE_ID?: string;

  // Cookie domain override (defaults to the apex of the request hostname)
  COOKIE_DOMAIN?: string;

  // OAuth Base URL for redirects
  OAUTH_BASE_URL?: string;
  
  
  // Logging and monitoring (optional)
  ENABLE_REQUEST_LOGGING?: string;
  ENABLE_PERFORMANCE_MONITORING?: string;
  ENABLE_CSRF_PROTECTION?: string;
  CONTENT_SECURITY_POLICY?: string;
}

// Hono Context Type Extension
export interface HonoContext {
  env: CloudflareEnv;
  rate_limit?: RateLimitStatus;
  request_id: string;
}

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;
export type OAuthCallback = z.infer<typeof OAuthCallbackSchema>;