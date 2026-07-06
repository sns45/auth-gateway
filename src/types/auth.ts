import { z } from 'zod';

// User Profile Types
export interface UserProfile {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
  role: 'admin' | 'user' | 'guest';
  created_at: string;
  last_login: string;
}

// Session Types
export interface SessionData {
  user_id: string;
  user_role: string;
  permissions: string[];
  ip_address: string;
  user_agent: string;
  created_at: string;
  expires_at: string;
  last_activity: string;
}

// JWT Payload
export interface JWTPayload {
  sub: string; // user_id
  role: string;
  permissions: string[];
  session_id: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

// Request Context
export interface AuthContext {
  user: UserProfile;
  session: SessionData;
  session_id: string;
  permissions: string[];
  token?: string; // JWT token if available
}

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
  user?: UserProfile;
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
  // Single KV Namespace for all storage
  AUTH_STORE: KVNamespace;
  
  // Secrets (from Doppler or wrangler secret)
  JWT_SECRET: string;
  SESSION_SECRET: string;
  BETTER_AUTH_SECRET: string;
  CONVEX_DEPLOY_KEY: string;
  GOOGLE_CLIENT_SECRET?: string;
  
  // Variables (from wrangler.toml)
  NODE_ENV: 'production' | 'staging' | 'development';
  PORT?: string | number;
  CONVEX_URL: string;
  CONVEX_SITE_URL: string;
  ALLOWED_ORIGINS: string;
  FRONTEND_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  
  // Additional properties
  RATE_LIMIT_WINDOW?: string | number;
  RATE_LIMIT_MAX?: string | number;
  KV_NAMESPACE_ID?: string;
  
  // Session configuration
  SESSION_COOKIE_NAME?: string;
  SESSION_TIMEOUT?: string | number;

  // Cookie domain override (defaults to apex of the request hostname)
  COOKIE_DOMAIN?: string;

  // Shared secret proving gateway identity to Convex HTTP actions
  CONVEX_SYNC_SECRET?: string;

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
  auth?: AuthContext;
  rate_limit?: RateLimitStatus;
  request_id: string;
}

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;
export type OAuthCallback = z.infer<typeof OAuthCallbackSchema>;