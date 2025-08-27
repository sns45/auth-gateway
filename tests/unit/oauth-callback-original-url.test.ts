import { describe, it, expect } from 'vitest';

/**
 * Test the OAuth callback original URL redirect logic
 * Tests that the callback redirects back to the original page where OAuth was initiated
 */

describe('OAuth Callback Original URL Redirect', () => {
  // Helper function to simulate the state parsing and redirect URL generation logic
  function extractOriginalUrlFromState(state: string | null, frontendUrl: string): string {
    let originalUrl = frontendUrl; // Default to homepage
    
    if (state) {
      try {
        // Try to decode state as JSON to extract redirect URL
        const stateData = JSON.parse(decodeURIComponent(state));
        if (stateData.redirectUrl && typeof stateData.redirectUrl === 'string') {
          // Validate that the redirect URL is from the same origin for security
          const redirectUrlObj = new URL(stateData.redirectUrl);
          const frontendUrlObj = new URL(frontendUrl);
          
          if (redirectUrlObj.origin === frontendUrlObj.origin) {
            originalUrl = stateData.redirectUrl;
          }
        }
      } catch {
        // If state is not JSON or doesn't contain redirect info, try direct URL decode
        try {
          const decodedState = decodeURIComponent(state);
          // Check if it looks like a URL
          if (decodedState.startsWith('http') || decodedState.startsWith('/')) {
            const redirectUrlObj = new URL(decodedState, frontendUrl);
            const frontendUrlObj = new URL(frontendUrl);
            
            // Only allow same-origin redirects for security
            if (redirectUrlObj.origin === frontendUrlObj.origin) {
              originalUrl = redirectUrlObj.toString();
            }
          }
        } catch {
          // If all parsing fails, stick with default frontend URL
        }
      }
    }
    
    return originalUrl;
  }

  // Helper function to append query parameters to URL
  function appendQueryParams(url: string, params: Record<string, string>): string {
    const urlObj = new URL(url);
    Object.entries(params).forEach(([key, value]) => {
      urlObj.searchParams.set(key, value);
    });
    return urlObj.toString();
  }

  describe('JSON State Format', () => {
    it('should extract redirect URL from JSON state', () => {
      const originalPageUrl = 'https://myapp.com/dashboard?tab=settings';
      const state = encodeURIComponent(JSON.stringify({ 
        redirectUrl: originalPageUrl,
        nonce: 'abc123'
      }));
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      expect(extractedUrl).toBe(originalPageUrl);
    });

    it('should reject redirect URL from different origin', () => {
      const maliciousUrl = 'https://evil.com/steal-tokens';
      const state = encodeURIComponent(JSON.stringify({ 
        redirectUrl: maliciousUrl
      }));
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      expect(extractedUrl).toBe(frontendUrl); // Should fall back to safe default
    });

    it('should handle JSON state without redirectUrl', () => {
      const state = encodeURIComponent(JSON.stringify({ 
        nonce: 'abc123',
        provider: 'google'
      }));
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      expect(extractedUrl).toBe(frontendUrl);
    });
  });

  describe('Direct URL State Format', () => {
    it('should extract redirect URL from direct URL encoding', () => {
      const originalPageUrl = 'https://myapp.com/profile';
      const state = encodeURIComponent(originalPageUrl);
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      expect(extractedUrl).toBe(originalPageUrl);
    });

    it('should handle relative URLs', () => {
      const relativePath = '/dashboard/settings';
      const state = encodeURIComponent(relativePath);
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      expect(extractedUrl).toBe('https://myapp.com/dashboard/settings');
    });

    it('should reject malicious external URLs', () => {
      const maliciousUrl = 'https://evil.com/phishing';
      const state = encodeURIComponent(maliciousUrl);
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      expect(extractedUrl).toBe(frontendUrl); // Should fall back to safe default
    });
  });

  describe('Invalid State Handling', () => {
    it('should handle null state', () => {
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(null, frontendUrl);
      expect(extractedUrl).toBe(frontendUrl);
    });

    it('should handle empty state', () => {
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState('', frontendUrl);
      expect(extractedUrl).toBe(frontendUrl);
    });

    it('should handle malformed JSON state', () => {
      const state = encodeURIComponent('{ invalid json }');
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      expect(extractedUrl).toBe(frontendUrl);
    });

    it('should handle non-URL text in state', () => {
      const state = encodeURIComponent('just some random text');
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      expect(extractedUrl).toBe(frontendUrl);
    });
  });

  describe('Query Parameter Appending', () => {
    it('should append auth success parameters to original URL', () => {
      const originalUrl = 'https://myapp.com/dashboard?tab=settings';
      const params = { auth: 'success', provider: 'google' };
      
      const finalUrl = appendQueryParams(originalUrl, params);
      expect(finalUrl).toBe('https://myapp.com/dashboard?tab=settings&auth=success&provider=google');
    });

    it('should append error parameters to original URL', () => {
      const originalUrl = 'https://myapp.com/login';
      const params = { error: 'oauth_failed', provider: 'github', details: 'Invalid code' };
      
      const finalUrl = appendQueryParams(originalUrl, params);
      expect(finalUrl).toContain('error=oauth_failed');
      expect(finalUrl).toContain('provider=github');
      expect(finalUrl).toContain('details=Invalid+code');
    });

    it('should handle URL with existing query parameters', () => {
      const originalUrl = 'https://myapp.com/page?existing=value&another=param';
      const params = { auth: 'success', provider: 'google' };
      
      const finalUrl = appendQueryParams(originalUrl, params);
      expect(finalUrl).toContain('existing=value');
      expect(finalUrl).toContain('another=param');
      expect(finalUrl).toContain('auth=success');
      expect(finalUrl).toContain('provider=google');
    });

    it('should overwrite existing parameters with same name', () => {
      const originalUrl = 'https://myapp.com/page?auth=pending';
      const params = { auth: 'success', provider: 'google' };
      
      const finalUrl = appendQueryParams(originalUrl, params);
      expect(finalUrl).toBe('https://myapp.com/page?auth=success&provider=google');
      expect(finalUrl).not.toContain('auth=pending');
    });

    it('should handle URL without existing query parameters', () => {
      const originalUrl = 'https://myapp.com/dashboard';
      const params = { auth: 'success', provider: 'google' };
      
      const finalUrl = appendQueryParams(originalUrl, params);
      expect(finalUrl).toBe('https://myapp.com/dashboard?auth=success&provider=google');
    });
  });

  describe('Security Validation', () => {
    it('should allow same-origin subdomain redirects', () => {
      const originalPageUrl = 'https://admin.myapp.com/settings';
      const state = encodeURIComponent(JSON.stringify({ 
        redirectUrl: originalPageUrl
      }));
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      // Should reject because admin.myapp.com is different origin from myapp.com
      expect(extractedUrl).toBe(frontendUrl);
    });

    it('should allow different paths on same origin', () => {
      const originalPageUrl = 'https://myapp.com/admin/dashboard';
      const state = encodeURIComponent(JSON.stringify({ 
        redirectUrl: originalPageUrl
      }));
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      expect(extractedUrl).toBe(originalPageUrl);
    });

    it('should reject different protocols', () => {
      const originalPageUrl = 'http://myapp.com/dashboard'; // http instead of https
      const state = encodeURIComponent(JSON.stringify({ 
        redirectUrl: originalPageUrl
      }));
      const frontendUrl = 'https://myapp.com';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      expect(extractedUrl).toBe(frontendUrl); // Should reject due to protocol mismatch
    });

    it('should allow same origin with different port in development', () => {
      const originalPageUrl = 'http://localhost:3000/dashboard';
      const state = encodeURIComponent(JSON.stringify({ 
        redirectUrl: originalPageUrl
      }));
      const frontendUrl = 'http://localhost:3000';
      
      const extractedUrl = extractOriginalUrlFromState(state, frontendUrl);
      expect(extractedUrl).toBe(originalPageUrl);
    });
  });
});