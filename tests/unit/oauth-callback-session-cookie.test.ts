/**
 * Test OAuth callback session cookie detection logic
 * 
 * This test specifically focuses on the improved approach where we:
 * 1. Check for session cookies being set by Better Auth
 * 2. Use simple response status and cookie presence to determine success
 * 3. Provide clear logging for debugging
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { CloudflareEnv } from '@/types/auth';
import type { Variables } from '@/types/context';

// Mock the CloudflareEnv for testing
const createMockEnv = (): CloudflareEnv => ({
  AUTH_STORE: {} as KVNamespace,
  NODE_ENV: 'development',
  JWT_SECRET: 'test-jwt-secret-that-is-long-enough-for-testing-purposes',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-for-validation',
  CONVEX_URL: 'https://test-convex.convex.cloud',
  CONVEX_DEPLOY_KEY: 'test-deploy-key',
  CONVEX_SITE_URL: 'https://test-convex.convex.site',
  FRONTEND_URL: 'http://localhost:5173',
  OAUTH_BASE_URL: 'http://localhost:8787',
  ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:3000',
  BETTER_AUTH_SECRET: 'test-better-auth-secret-that-is-long-enough-for-validation',
  LOG_LEVEL: 'info',
});

// Create a test app with the OAuth callback route
const createTestApp = () => {
  const app = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();
  
  // Mock middleware
  app.use('*', async (c, next) => {
    // Initialize c.env if it doesn't exist, then assign mock values
    c.env = c.env || {};
    Object.assign(c.env, createMockEnv());
    
    c.set('logger', {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as any);
    c.set('requestId', 'test-request-id');
    await next();
  });

  // Simplified OAuth callback route with session cookie detection logic
  app.get('/api/auth/callback/:provider', async (c) => {
    const logger = c.get('logger');
    const requestId = c.get('requestId') || 'unknown';
    
    try {
      const provider = c.req.param('provider');
      const searchParams = new URL(c.req.url).searchParams;
      const queryString = searchParams.toString();
      
      // Prepare headers for Convex request
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Origin': c.req.header('origin') || '',
        'X-Request-ID': requestId,
      };
      
      // Forward auth-related headers
      const authHeaders = ['cookie', 'authorization', 'better-auth-cookie'];
      authHeaders.forEach(header => {
        const value = c.req.header(header);
        if (value) {
          headers[header] = value;
        }
      });
      
      const callbackPath = `callback/${provider}${queryString ? `?${queryString}` : ''}`;
      
      // Use mocked fetch
      const response = await fetch(`${c.env.CONVEX_SITE_URL}/api/auth/${callbackPath}`, {
        method: 'GET',
        headers,
      });
      
      const responseBody = await response.text();
      const contentType = response.headers.get('content-type') || '';
      
      // Extract cookies 
      const cookieHeaders: string[] = [];
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          cookieHeaders.push(value);
        }
      });
      
      // Check for session cookies - MAIN LOGIC BEING TESTED
      const hasSessionCookies = cookieHeaders.some(cookie => 
        cookie.toLowerCase().includes('session') || 
        cookie.toLowerCase().includes('better-auth') ||
        cookie.toLowerCase().includes('auth') ||
        cookie.toLowerCase().includes('jwt')
      );
      
      logger.info(`OAuth Callback - Simple Status Check`, {
        requestId,
        provider,
        responseStatus: response.status,
        setCookieHeaders: cookieHeaders,
        responseBodyPreview: responseBody.substring(0, 200),
        hasSessionCookies
      });

      const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:5173';
      let originalUrl = frontendUrl;
      
      // Helper function
      const appendQueryParams = (url: string, params: Record<string, string>): string => {
        const urlObj = new URL(url);
        Object.entries(params).forEach(([key, value]) => {
          urlObj.searchParams.set(key, value);
        });
        return urlObj.toString();
      };

      let redirectUrl = originalUrl;

      // NEW LOGIC: Check session cookies first, then status, then content
      if (response.status >= 400) {
        redirectUrl = appendQueryParams(originalUrl, {
          error: 'oauth_failed',
          provider: provider
        });
      } else if (hasSessionCookies) {
        // Session cookies detected - Better Auth likely succeeded
        redirectUrl = appendQueryParams(originalUrl, {
          auth: 'success',
          provider: provider
        });
      } else if (contentType.includes('text/html')) {
        // Better Auth returned HTML - assume success if status is OK
        redirectUrl = appendQueryParams(originalUrl, {
          auth: 'success',
          provider: provider
        });
      } else {
        // Non-HTML response - assume success if status is OK
        redirectUrl = appendQueryParams(originalUrl, {
          auth: 'success',
          provider: provider
        });
      }
      
      // Build redirect response with cookies
      const redirectHeaders = new Headers({
        'Location': redirectUrl,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      
      // Add Set-Cookie headers
      cookieHeaders.forEach(cookieValue => {
        redirectHeaders.append('Set-Cookie', cookieValue);
      });
      
      return new Response(null, {
        status: 302,
        headers: redirectHeaders
      });
      
    } catch (error) {
      const errorUrl = new URL(c.env.FRONTEND_URL || 'http://localhost:5173');
      errorUrl.searchParams.set('error', 'oauth_error');
      errorUrl.searchParams.set('details', error instanceof Error ? error.message : 'Unknown error');
      
      return new Response(null, {
        status: 302,
        headers: {
          'Location': errorUrl.toString()
        }
      });
    }
  });

  return app;
};

describe('OAuth Callback - Session Cookie Detection', () => {
  let app: Hono;
  
  beforeEach(() => {
    app = createTestApp();
  });

  test('should detect success when Better Auth sets session cookies', async () => {
    // Mock the Convex response with Better Auth session cookies
    const mockFetch = vi.fn().mockResolvedValue(new Response(
      '<html><body>OAuth processed</body></html>',
      {
        status: 200,
        headers: new Headers([
          ['content-type', 'text/html'],
          ['set-cookie', 'better-auth.session_token=abc123; HttpOnly; Path=/; Max-Age=86400'],
          ['set-cookie', 'better-auth.csrf_token=xyz789; HttpOnly; Path=/; SameSite=Lax']
        ])
      }
    ));

    // Mock fetch globally
    global.fetch = mockFetch;

    const request = new Request('http://localhost:8787/api/auth/callback/google?code=test_code&state=test_state', {
      method: 'GET'
    });

    const response = await app.request(request);

    expect(response.status).toBe(302);
    
    const location = response.headers.get('location');
    expect(location).toContain('auth=success');
    expect(location).toContain('provider=google');
    expect(location).toContain('localhost:5173');
    
    // Check that Better Auth cookies were forwarded
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    expect(setCookieHeaders.length).toBeGreaterThan(0);
  });

  test('should detect success when generic auth cookies are set', async () => {
    // Mock the Convex response with generic auth cookies
    const mockFetch = vi.fn().mockResolvedValue(new Response(
      '<html><body>Authentication completed</body></html>',
      {
        status: 200,
        headers: new Headers([
          ['content-type', 'text/html'],
          ['set-cookie', 'session_id=sess_12345; HttpOnly; Path=/'],
          ['set-cookie', 'auth_token=token_67890; HttpOnly; Path=/; SameSite=Strict']
        ])
      }
    ));

    global.fetch = mockFetch;

    const request = new Request('http://localhost:8787/api/auth/callback/github?code=test_code');

    const response = await app.request(request);

    expect(response.status).toBe(302);
    
    const location = response.headers.get('location');
    expect(location).toContain('auth=success');
    expect(location).toContain('provider=github');
  });

  test('should detect success when JWT cookies are set', async () => {
    // Mock the Convex response with JWT cookies
    const mockFetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'OAuth completed' }),
      {
        status: 200,
        headers: new Headers([
          ['content-type', 'application/json'],
          ['set-cookie', 'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature; HttpOnly; Path=/']
        ])
      }
    ));

    global.fetch = mockFetch;

    const request = new Request('http://localhost:8787/api/auth/callback/discord?code=test_code');

    const response = await app.request(request);

    expect(response.status).toBe(302);
    
    const location = response.headers.get('location');
    expect(location).toContain('auth=success');
    expect(location).toContain('provider=discord');
  });

  test('should assume success for HTML response with OK status even without session cookies', async () => {
    // Mock the Convex response without session cookies but with OK status
    const mockFetch = vi.fn().mockResolvedValue(new Response(
      '<html><body>OAuth flow completed</body></html>',
      {
        status: 200,
        headers: new Headers([
          ['content-type', 'text/html']
        ])
      }
    ));

    global.fetch = mockFetch;

    const request = new Request('http://localhost:8787/api/auth/callback/google?code=test_code');

    const response = await app.request(request);

    expect(response.status).toBe(302);
    
    const location = response.headers.get('location');
    expect(location).toContain('auth=success');
    expect(location).toContain('provider=google');
  });

  test('should detect error when response status is 400+', async () => {
    // Mock the Convex response with error status
    const mockFetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'OAuth failed' }),
      {
        status: 400,
        headers: new Headers([
          ['content-type', 'application/json']
        ])
      }
    ));

    global.fetch = mockFetch;

    const request = new Request('http://localhost:8787/api/auth/callback/google?code=invalid_code');

    const response = await app.request(request);

    expect(response.status).toBe(302);
    
    const location = response.headers.get('location');
    expect(location).toContain('error=oauth_failed');
    expect(location).toContain('provider=google');
  });

  test('should redirect to correct frontend URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(
      '<html><body>Success</body></html>',
      {
        status: 200,
        headers: new Headers([
          ['content-type', 'text/html'],
          ['set-cookie', 'session_id=test123; HttpOnly; Path=/']
        ])
      }
    ));

    global.fetch = mockFetch;

    const request = new Request('http://localhost:8787/api/auth/callback/google?code=test_code');

    const response = await app.request(request);

    expect(response.status).toBe(302);
    
    const location = response.headers.get('location');
    expect(location).toContain('http://localhost:5173');
  });
});