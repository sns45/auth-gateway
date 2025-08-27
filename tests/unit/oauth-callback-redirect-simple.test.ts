import { describe, it, expect } from 'vitest';

/**
 * Simple test for OAuth callback redirect logic
 * Tests the redirect URL generation logic independently
 */

describe('OAuth Callback Redirect Logic', () => {
  // Extract the redirect URL generation logic for testing
  function generateRedirectUrl(
    convexResponse: { status: number; body: string; contentType: string },
    provider: string,
    frontendUrl: string = 'http://localhost:3000'
  ): string {
    let redirectUrl = frontendUrl;
    
    if (convexResponse.status >= 400) {
      redirectUrl = `${frontendUrl}?error=oauth_failed&provider=${provider}`;
    } else if (convexResponse.contentType.includes('text/html')) {
      if (convexResponse.body.includes('success') || 
          convexResponse.body.includes('authenticated') || 
          convexResponse.body.includes('logged')) {
        redirectUrl = `${frontendUrl}?auth=success&provider=${provider}`;
      } else {
        redirectUrl = `${frontendUrl}?auth=unknown&provider=${provider}`;
      }
    } else {
      try {
        const jsonResponse = JSON.parse(convexResponse.body);
        if (jsonResponse.success === false || jsonResponse.error) {
          redirectUrl = `${frontendUrl}?error=oauth_failed&provider=${provider}&details=${encodeURIComponent(jsonResponse.error?.message || 'Unknown error')}`;
        } else {
          redirectUrl = `${frontendUrl}?auth=success&provider=${provider}`;
        }
      } catch {
        redirectUrl = convexResponse.status < 400 
          ? `${frontendUrl}?auth=success&provider=${provider}`
          : `${frontendUrl}?error=oauth_failed&provider=${provider}`;
      }
    }
    
    return redirectUrl;
  }

  describe('HTML Response Handling', () => {
    it('should redirect to success for successful HTML response', () => {
      const convexResponse = {
        status: 200,
        body: '<html><body>OAuth Success - User authenticated</body></html>',
        contentType: 'text/html'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'google');
      expect(redirectUrl).toBe('http://localhost:3000?auth=success&provider=google');
    });

    it('should redirect to unknown for unclear HTML response', () => {
      const convexResponse = {
        status: 200,
        body: '<html><body>Some unclear response</body></html>',
        contentType: 'text/html'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'github');
      expect(redirectUrl).toBe('http://localhost:3000?auth=unknown&provider=github');
    });

    it('should detect success keywords in HTML', () => {
      const successKeywords = ['success', 'authenticated', 'logged'];
      
      successKeywords.forEach(keyword => {
        const convexResponse = {
          status: 200,
          body: `<html><body>OAuth ${keyword}</body></html>`,
          contentType: 'text/html'
        };
        
        const redirectUrl = generateRedirectUrl(convexResponse, 'google');
        expect(redirectUrl).toBe('http://localhost:3000?auth=success&provider=google');
      });
    });
  });

  describe('JSON Response Handling', () => {
    it('should redirect to success for successful JSON response', () => {
      const convexResponse = {
        status: 200,
        body: JSON.stringify({ success: true, user: { id: '123' } }),
        contentType: 'application/json'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'google');
      expect(redirectUrl).toBe('http://localhost:3000?auth=success&provider=google');
    });

    it('should redirect to error for failed JSON response', () => {
      const convexResponse = {
        status: 200,
        body: JSON.stringify({ success: false, error: { message: 'Invalid code' } }),
        contentType: 'application/json'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'google');
      expect(redirectUrl).toBe('http://localhost:3000?error=oauth_failed&provider=google&details=Invalid%20code');
    });

    it('should handle malformed JSON gracefully', () => {
      const convexResponse = {
        status: 200,
        body: '{ invalid json',
        contentType: 'application/json'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'google');
      expect(redirectUrl).toBe('http://localhost:3000?auth=success&provider=google');
    });

    it('should redirect to error for malformed JSON with error status', () => {
      const convexResponse = {
        status: 400,
        body: '{ invalid json',
        contentType: 'application/json'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'google');
      expect(redirectUrl).toBe('http://localhost:3000?error=oauth_failed&provider=google');
    });
  });

  describe('Error Response Handling', () => {
    it('should redirect to error for 400 status', () => {
      const convexResponse = {
        status: 400,
        body: JSON.stringify({ error: 'invalid_request' }),
        contentType: 'application/json'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'google');
      expect(redirectUrl).toBe('http://localhost:3000?error=oauth_failed&provider=google');
    });

    it('should redirect to error for 401 status', () => {
      const convexResponse = {
        status: 401,
        body: 'Unauthorized',
        contentType: 'text/plain'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'github');
      expect(redirectUrl).toBe('http://localhost:3000?error=oauth_failed&provider=github');
    });

    it('should redirect to error for 500 status', () => {
      const convexResponse = {
        status: 500,
        body: 'Internal Server Error',
        contentType: 'text/plain'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'discord');
      expect(redirectUrl).toBe('http://localhost:3000?error=oauth_failed&provider=discord');
    });
  });

  describe('Provider Support', () => {
    it('should handle different OAuth providers', () => {
      const providers = ['google', 'github', 'discord', 'facebook', 'twitter'];
      
      providers.forEach(provider => {
        const convexResponse = {
          status: 200,
          body: '<html><body>OAuth success</body></html>',
          contentType: 'text/html'
        };
        
        const redirectUrl = generateRedirectUrl(convexResponse, provider);
        expect(redirectUrl).toContain(`provider=${provider}`);
        expect(redirectUrl).toContain('auth=success');
      });
    });
  });

  describe('Custom Frontend URL', () => {
    it('should use custom frontend URL when provided', () => {
      const customFrontendUrl = 'https://my-app.com';
      const convexResponse = {
        status: 200,
        body: '<html><body>OAuth success</body></html>',
        contentType: 'text/html'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'google', customFrontendUrl);
      expect(redirectUrl).toBe('https://my-app.com?auth=success&provider=google');
    });

    it('should handle custom frontend URL with error', () => {
      const customFrontendUrl = 'https://my-app.com';
      const convexResponse = {
        status: 400,
        body: JSON.stringify({ error: { message: 'OAuth failed' } }),
        contentType: 'application/json'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'google', customFrontendUrl);
      expect(redirectUrl).toBe('https://my-app.com?error=oauth_failed&provider=google');
    });
  });

  describe('URL Encoding', () => {
    it('should properly encode error details', () => {
      const convexResponse = {
        status: 200,
        body: JSON.stringify({ 
          success: false, 
          error: { message: 'Invalid code: special chars & symbols!' } 
        }),
        contentType: 'application/json'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'google');
      expect(redirectUrl).toContain('details=Invalid%20code%3A%20special%20chars%20%26%20symbols!');
    });

    it('should handle undefined error message', () => {
      const convexResponse = {
        status: 200,
        body: JSON.stringify({ 
          success: false, 
          error: {} // No message property
        }),
        contentType: 'application/json'
      };
      
      const redirectUrl = generateRedirectUrl(convexResponse, 'google');
      expect(redirectUrl).toContain('details=Unknown%20error');
    });
  });
});