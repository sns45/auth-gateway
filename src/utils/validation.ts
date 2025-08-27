import { z } from 'zod';
import { Context } from 'hono';
import { APIErrorCodes } from '@/types/api';

// Common validation schemas
export const EmailSchema = z.string()
  .email('Invalid email format')
  .min(3, 'Email must be at least 3 characters')
  .max(255, 'Email must be less than 255 characters');

export const PasswordSchema = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be less than 128 characters')
  .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, 'Password must contain at least one lowercase letter, one uppercase letter, and one number');

export const UUIDSchema = z.string()
  .uuid('Invalid UUID format');

export const URLSchema = z.string()
  .url('Invalid URL format');

// Environment validation schema
export const EnvironmentSchema = z.object({
  // AUTH_STORE will be provided by Cloudflare Workers runtime
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.union([z.string().regex(/^\d+$/).transform(Number), z.number()]).optional().default(8787),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  CONVEX_URL: URLSchema,
  CONVEX_SITE_URL: URLSchema,
  CONVEX_DEPLOY_KEY: z.string().min(1, 'CONVEX_DEPLOY_KEY is required'),
  ALLOWED_ORIGINS: z.string().min(1, 'ALLOWED_ORIGINS is required'),
  FRONTEND_URL: URLSchema.optional().default('http://localhost:3000'),
  OAUTH_BASE_URL: URLSchema.optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  RATE_LIMIT_WINDOW: z.union([z.string().regex(/^\d+$/).transform(Number), z.number()]).optional().default(60000),
  RATE_LIMIT_MAX: z.union([z.string().regex(/^\d+$/).transform(Number), z.number()]).optional().default(100),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  KV_NAMESPACE_ID: z.string().optional(),
  SESSION_COOKIE_NAME: z.string().optional().default('auth_session'),
  SESSION_TIMEOUT: z.union([z.string().regex(/^\d+$/).transform(Number), z.number()]).optional().default(3600),
}).transform((data) => ({
  ...data,
  // Add AUTH_STORE as a placeholder - it will be provided by Cloudflare runtime
  AUTH_STORE: undefined as any as KVNamespace
}));

// OAuth provider validation
export const OAuthProviderSchema = z.enum(['google']);

// Authentication request schemas
export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  rememberMe: z.boolean().optional().default(false),
});

export const OAuthCallbackSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required'),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

// CORS origin validation
export function validateOrigin(origin: string, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  
  for (const allowed of allowedOrigins) {
    // Exact match
    if (allowed === origin) {
      return true;
    }
    
    // Wildcard subdomain support (e.g., *.example.com)
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(2);
      if (origin.endsWith(`.${domain}`) || origin === domain) {
        return true;
      }
    }
    
    // Development localhost support
    if (allowed === 'http://localhost:*' && origin.match(/^http:\/\/localhost:\d+$/)) {
      return true;
    }
  }
  
  return false;
}

// Parse and validate allowed origins from environment
export function parseAllowedOrigins(originsString: string): string[] {
  return originsString
    .split(',')
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0);
}

// Validate request body against schema
export async function validateRequestBody<T>(
  c: Context,
  schema: z.ZodSchema<T>
): Promise<{ success: true; data: T } | { success: false; error: any }> {
  try {
    const body = await c.req.json();
    const data = schema.parse(body);
    return { success: true, data };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: {
          message: 'Validation failed',
          code: APIErrorCodes.VALIDATION_ERROR,
          details: error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(', ')
        }
      };
    }
    return {
      success: false,
      error: {
        message: 'Invalid JSON',
        code: APIErrorCodes.INVALID_REQUEST,
        details: 'Request body must be valid JSON'
      }
    };
  }
}

// Validate query parameters against schema
export function validateQueryParams<T>(
  c: Context,
  schema: z.ZodSchema<T>
): { success: true; data: T } | { success: false; error: any } {
  try {
    const query = c.req.query();
    const data = schema.parse(query);
    return { success: true, data };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: {
          message: 'Query parameter validation failed',
          code: APIErrorCodes.VALIDATION_ERROR,
          details: error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(', ')
        }
      };
    }
    return {
      success: false,
      error: {
        message: 'Invalid query parameters',
        code: APIErrorCodes.INVALID_REQUEST,
        details: 'Query parameters are invalid'
      }
    };
  }
}

// Sanitize user input
export function sanitizeString(input: string, maxLength: number = 255): string {
  return input
    .trim()
    .slice(0, maxLength)
    .replace(/[<>\"'&]/g, '') // Remove potentially dangerous characters
    .replace(/\s+/g, ' '); // Normalize whitespace
}

// Validate email format
export function isValidEmail(email: string): boolean {
  try {
    EmailSchema.parse(email);
    return true;
  } catch {
    return false;
  }
}

// Validate password strength
export function isValidPassword(password: string): boolean {
  try {
    PasswordSchema.parse(password);
    return true;
  } catch {
    return false;
  }
}

// Validate UUID format
export function isValidUUID(uuid: string): boolean {
  try {
    UUIDSchema.parse(uuid);
    return true;
  } catch {
    return false;
  }
}

// Validate URL format
export function isValidURL(url: string): boolean {
  try {
    URLSchema.parse(url);
    return true;
  } catch {
    return false;
  }
}

// IP address validation
export function isValidIP(ip: string): boolean {
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
  
  return ipv4Regex.test(ip) || ipv6Regex.test(ip);
}

// Rate limit key validation
export function validateRateLimitKey(key: string): boolean {
  return /^[a-zA-Z0-9_:.-]+$/.test(key) && key.length <= 100;
}

export type ValidatedEnvironment = z.infer<typeof EnvironmentSchema>;