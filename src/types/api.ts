import { z } from 'zod';

// Common API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    message: string;
    code: string;
    details?: string;
  };
  meta?: {
    request_id: string;
    timestamp: string;
    version: string;
  };
}

// Pagination Types
export interface PaginationParams {
  page: number;
  limit: number;
  offset?: number;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
    has_next: boolean;
    has_prev: boolean;
  };
}

// Health Check Types
export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
  checks: {
    convex: 'healthy' | 'unhealthy';
    session_store: 'healthy' | 'unhealthy';
    database: 'healthy' | 'unhealthy';
  };
  metrics: {
    memory_usage: number;
    cpu_usage: number;
    active_sessions: number;
    requests_per_minute: number;
  };
}

// Error Types
export const APIErrorCodes = {
  // Authentication Errors (4xx)
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_INVALID: 'SESSION_INVALID',
  
  // Authorization Errors (4xx)
  ACCESS_DENIED: 'ACCESS_DENIED',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  RESOURCE_FORBIDDEN: 'RESOURCE_FORBIDDEN',
  
  // Rate Limiting (4xx)
  RATE_LIMITED: 'RATE_LIMITED',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  
  // Client Errors (4xx)
  INVALID_REQUEST: 'INVALID_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MISSING_PARAMETER: 'MISSING_PARAMETER',
  INVALID_PARAMETER: 'INVALID_PARAMETER',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  RESOURCE_CONFLICT: 'RESOURCE_CONFLICT',
  
  // Server Errors (5xx)
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  CONVEX_ERROR: 'CONVEX_ERROR',
  SESSION_STORE_ERROR: 'SESSION_STORE_ERROR',
  OAUTH_ERROR: 'OAUTH_ERROR',
  
  // CORS Errors
  CORS_ERROR: 'CORS_ERROR',
  INVALID_ORIGIN: 'INVALID_ORIGIN',
  PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
} as const;

export type APIErrorCode = typeof APIErrorCodes[keyof typeof APIErrorCodes];

// Request Validation Schemas
export const PaginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

export const RequestIdSchema = z.object({
  id: z.string().uuid(),
});

// Headers that should be forwarded to Convex
export const CONVEX_FORWARD_HEADERS = [
  'X-User-ID',
  'X-User-Role',
  'X-User-Permissions',
  'X-Session-ID',
  'X-Request-ID',
  'Authorization',
  'Content-Type',
  'Accept',
  'User-Agent',
] as const;

// Headers that should be removed before forwarding
export const REMOVE_HEADERS = [
  'Cookie',
  'Set-Cookie',
  'X-Real-IP',
  'X-Forwarded-For',
  'X-Forwarded-Proto',
  'Host',
  'Connection',
] as const;

// Security Headers
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
} as const;

// Performance monitoring types
export interface RequestMetrics {
  request_id: string;
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  user_id?: string;
  ip_address: string;
  user_agent: string;
  timestamp: string;
}

export interface PerformanceMetrics {
  requests_total: number;
  requests_per_minute: number;
  average_response_time: number;
  error_rate: number;
  active_sessions: number;
  memory_usage_mb: number;
}

export type PaginationRequest = z.infer<typeof PaginationSchema>;
export type RequestIdRequest = z.infer<typeof RequestIdSchema>;

// Re-export AuthResponse from auth types
export { AuthResponse, ErrorResponse } from './auth';