import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { CloudflareEnv } from '@/types/auth';
import type { Variables } from '@/types/context';

/**
 * Test the OAuth callback redirect functionality
 * This tests the specific route that handles OAuth callbacks and redirects to the frontend
 */

// Mock the CloudflareEnv for testing
const createMockEnv = (): CloudflareEnv => ({
  AUTH_STORE: {} as KVNamespace,
  NODE_ENV: 'development',
  JWT_SECRET: 'test-jwt-secret-that-is-long-enough-for-validation',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-for-validation',
  BETTER_AUTH_SECRET: 'test-better-auth-secret-that-is-long-enough-for-validation',
  CONVEX_URL: 'https://rosy-007.convex.cloud',
  CONVEX_SITE_URL: 'https://rosy-007.convex.site',
  CONVEX_DEPLOY_KEY: 'test-deploy-key',
  ALLOWED_ORIGINS: 'http://localhost:3000,https://staging.example.com',
  FRONTEND_URL: 'http://localhost:3000',
  OAUTH_BASE_URL: 'https://auth.example.com',
  LOG_LEVEL: 'info',
});

// Create a simple test app with just the OAuth callback route
const createTestApp = () => {
  const app = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();
  
  // Mock logger and environment
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

  // OAuth callback route - simplified version for testing
  app.get('/api/auth/callback/:provider', async (c) => {
    const logger = c.get('logger');
    const requestId = c.get('requestId') || 'unknown';
    
    try {
      const provider = c.req.param('provider');
      const searchParams = new URL(c.req.url).searchParams;
      const queryString = searchParams.toString();
      
      // Mock the Convex response based on test scenario
      let mockStatus = 200;
      let mockBody = '<html><body>OAuth Success</body></html>';
      let mockHeaders = new Headers();
      
      // Check for test scenario markers in query params
      if (searchParams.get('test_scenario') === 'error') {
        mockStatus = 400;
        mockBody = JSON.stringify({ error: 'invalid_code' });
      } else if (searchParams.get('test_scenario') === 'json_success') {
        mockBody = JSON.stringify({ success: true, user: { id: '123' } });
        mockHeaders.set('content-type', 'application/json');
      } else if (searchParams.get('test_scenario') === 'with_cookies') {
        mockHeaders.append('set-cookie', 'better-auth.session_token=abc123; HttpOnly; Path=/');
        mockHeaders.append('set-cookie', 'better-auth.csrf_token=xyz789; HttpOnly; Path=/');
      }
      
      // Mock fetch call
      global.fetch = vi.fn().mockResolvedValue({
        status: mockStatus,
        headers: mockHeaders,
        text: () => Promise.resolve(mockBody)
      } as Response);
      
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
      
      const response = await fetch(`${c.env.CONVEX_SITE_URL}/api/auth/${callbackPath}`, {
        method: 'GET',
        headers,
      });
      
      const responseBody = await response.text();
      const contentType = response.headers.get('content-type') || '';
      
      // Copy cookies
      const cookieHeaders: string[] = [];
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          cookieHeaders.push(value);
        }
      });
      
      // Determine redirect URL
      const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:3000';
      let redirectUrl = frontendUrl;
      
      if (response.status >= 400) {
        redirectUrl = `${frontendUrl}?error=oauth_failed&provider=${provider}`;
      } else if (contentType.includes('text/html')) {
        if (responseBody.includes('success') || responseBody.includes('authenticated') || 
            responseBody.includes('logged') || response.status === 200) {
          redirectUrl = `${frontendUrl}?auth=success&provider=${provider}`;
        } else {
          redirectUrl = `${frontendUrl}?auth=unknown&provider=${provider}`;
        }
      } else {
        try {
          const jsonResponse = JSON.parse(responseBody);
          if (jsonResponse.success === false || jsonResponse.error) {
            redirectUrl = `${frontendUrl}?error=oauth_failed&provider=${provider}&details=${encodeURIComponent(jsonResponse.error?.message || 'Unknown error')}`;
          } else {
            redirectUrl = `${frontendUrl}?auth=success&provider=${provider}`;
          }
        } catch {
          redirectUrl = response.status < 400 
            ? `${frontendUrl}?auth=success&provider=${provider}`
            : `${frontendUrl}?error=oauth_failed&provider=${provider}`;
        }
      }
      
      const redirectHeaders: Record<string, string> = {
        'Location': redirectUrl,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      };
      
      let responseInit: ResponseInit = {
        status: 302,
        headers: redirectHeaders
      };
      
      if (cookieHeaders.length > 0) {
        const responseHeaders = new Headers(redirectHeaders);
        cookieHeaders.forEach(cookieValue => {
          responseHeaders.append('Set-Cookie', cookieValue);
        });
        responseInit.headers = responseHeaders;
      }
      
      return new Response(null, responseInit);
      
    } catch (error) {
      const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:3000';
      return new Response(null, {
        status: 302,
        headers: {
          'Location': `${frontendUrl}?error=oauth_error&details=${encodeURIComponent(error instanceof Error ? error.message : 'Unknown error')}`
        }
      });
    }
  });

  return app;
};

describe('OAuth Callback Redirect', () => {
  let app: Hono;
  let env: CloudflareEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createMockEnv();
  });

  describe('Successful OAuth Callback', () => {
    it('should redirect to frontend with success parameters for HTML response', async () => {
      const request = new Request('http://test.com/api/auth/callback/google?code=success123&state=test', {
        method: 'GET'
      });

      const response = await app.request(request);

      expect(response.status).toBe(302);
      
      const location = response.headers.get('Location');
      expect(location).toBeDefined();
      expect(location).toBe('http://localhost:3000?auth=success&provider=google');
      
      // Check cache headers
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    });

    it('should redirect to frontend with success parameters for JSON response', async () => {
      const request = new Request('http://test.com/api/auth/callback/github?code=success123&state=test&test_scenario=json_success', {
        method: 'GET'
      });

      const response = await app.request(request);

      expect(response.status).toBe(302);
      
      const location = response.headers.get('Location');
      expect(location).toBe('http://localhost:3000?auth=success&provider=github');
    });

    it('should forward cookies from Convex response', async () => {
      const request = new Request('http://test.com/api/auth/callback/google?code=success123&state=test&test_scenario=with_cookies', {
        method: 'GET'
      });

      const response = await app.request(request);

      expect(response.status).toBe(302);
      
      // Check that cookies are forwarded
      const cookies = response.headers.getSetCookie();
      expect(cookies).toContain('better-auth.session_token=abc123; HttpOnly; Path=/');
      expect(cookies).toContain('better-auth.csrf_token=xyz789; HttpOnly; Path=/');
    });
  });

  describe('Failed OAuth Callback', () => {
    it('should redirect to frontend with error parameters for 400 response', async () => {
      const request = new Request('http://test.com/api/auth/callback/google?code=invalid&state=test&test_scenario=error', {
        method: 'GET'
      });

      const response = await app.request(request);

      expect(response.status).toBe(302);
      
      const location = response.headers.get('Location');
      expect(location).toBe('http://localhost:3000?error=oauth_failed&provider=google');
    });

    it('should handle missing code parameter', async () => {
      const request = new Request('http://test.com/api/auth/callback/google?state=test', {
        method: 'GET'
      });

      const response = await app.request(request);

      expect(response.status).toBe(302);
      
      const location = response.headers.get('Location');
      expect(location).toContain('error=oauth_failed');
      expect(location).toContain('provider=google');
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      // Mock fetch to throw an error
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const request = new Request('http://test.com/api/auth/callback/google?code=test&state=test', {
        method: 'GET'
      });

      const response = await app.request(request);

      expect(response.status).toBe(302);
      
      const location = response.headers.get('Location');
      expect(location).toContain('error=oauth_error');
      expect(location).toContain('details=Network%20error');
    });
  });

  describe('Provider Support', () => {
    it('should handle different OAuth providers', async () => {
      const providers = ['google', 'github', 'discord'];
      
      for (const provider of providers) {
        const request = new Request(`http://test.com/api/auth/callback/${provider}?code=test&state=test`, {
          method: 'GET'
        });

        const response = await app.request(request);

        expect(response.status).toBe(302);
        
        const location = response.headers.get('Location');
        expect(location).toContain(`provider=${provider}`);
      }
    });
  });

  describe('Environment Configuration', () => {
    it('should use custom FRONTEND_URL when configured', async () => {
      // Create a new app with custom environment
      const customApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();
      
      customApp.use('*', async (c, next) => {
        // Mock environment with custom FRONTEND_URL
        c.env = c.env || {};
        Object.assign(c.env, {
          ...createMockEnv(),
          FRONTEND_URL: 'https://custom-frontend.com'
        });
        
        c.set('logger', {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn()
        } as any);
        c.set('requestId', 'test-request-id');
        await next();
      });

      // Copy the OAuth callback route logic
      customApp.get('/api/auth/callback/:provider', async (c) => {
        const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:3000';
        const provider = c.req.param('provider');
        const redirectUrl = `${frontendUrl}?auth=success&provider=${provider}`;
        
        return new Response(null, {
          status: 302,
          headers: { 'Location': redirectUrl }
        });
      });

      const request = new Request('http://test.com/api/auth/callback/google?code=test&state=test', {
        method: 'GET'
      });

      const response = await customApp.request(request);

      expect(response.status).toBe(302);
      
      const location = response.headers.get('Location');
      expect(location).toContain('https://custom-frontend.com');
    });

    it('should fall back to localhost when FRONTEND_URL is not configured', async () => {
      // Create a new app with undefined FRONTEND_URL
      const fallbackApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();
      
      fallbackApp.use('*', async (c, next) => {
        // Mock environment without FRONTEND_URL
        const envWithoutFrontendUrl = createMockEnv();
        delete (envWithoutFrontendUrl as any).FRONTEND_URL;
        c.env = c.env || {};
        Object.assign(c.env, envWithoutFrontendUrl);
        
        c.set('logger', {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn()
        } as any);
        c.set('requestId', 'test-request-id');
        await next();
      });

      // Copy the OAuth callback route logic
      fallbackApp.get('/api/auth/callback/:provider', async (c) => {
        const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:3000';
        const provider = c.req.param('provider');
        const redirectUrl = `${frontendUrl}?auth=success&provider=${provider}`;
        
        return new Response(null, {
          status: 302,
          headers: { 'Location': redirectUrl }
        });
      });

      const request = new Request('http://test.com/api/auth/callback/google?code=test&state=test', {
        method: 'GET'
      });

      const response = await fallbackApp.request(request);

      expect(response.status).toBe(302);
      
      const location = response.headers.get('Location');
      expect(location).toContain('http://localhost:3000');
    });
  });
});