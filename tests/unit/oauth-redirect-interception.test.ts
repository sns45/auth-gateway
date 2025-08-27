import { describe, it, expect } from 'vitest';

/**
 * Test the OAuth redirect URL replacement functions
 * These are the helper functions used in the Better Auth proxy
 */

/**
 * Helper function to recursively replace OAuth URLs in JSON objects
 */
function replaceOAuthUrls(obj: any, convexUrl: string, gatewayUrl: string): any {
  if (typeof obj === 'string') {
    // Replace any occurrence of the Convex URL with the gateway URL
    // Handle both regular and URL-encoded strings
    let result = obj.replace(new RegExp(escapeRegExp(convexUrl), 'g'), gatewayUrl);
    
    // Also handle URL-encoded versions
    const encodedConvexUrl = encodeURIComponent(convexUrl);
    const encodedGatewayUrl = encodeURIComponent(gatewayUrl);
    result = result.replace(new RegExp(escapeRegExp(encodedConvexUrl), 'g'), encodedGatewayUrl);
    
    return result;
  } else if (Array.isArray(obj)) {
    return obj.map(item => replaceOAuthUrls(item, convexUrl, gatewayUrl));
  } else if (obj && typeof obj === 'object') {
    const newObj: any = {};
    for (const [key, value] of Object.entries(obj)) {
      newObj[key] = replaceOAuthUrls(value, convexUrl, gatewayUrl);
    }
    return newObj;
  }
  return obj;
}

/**
 * Helper function to escape special regex characters
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('OAuth Redirect URL Interception', () => {
  const convexUrl = 'https://rosy-007.convex.site';
  const gatewayUrl = 'https://auth.example.com';

  describe('replaceOAuthUrls', () => {
    it('should replace URLs in simple string', () => {
      const input = 'https://rosy-007.convex.site/auth/callback';
      const expected = 'https://auth.example.com/auth/callback';
      const result = replaceOAuthUrls(input, convexUrl, gatewayUrl);
      expect(result).toBe(expected);
    });

    it('should replace URLs in JSON object', () => {
      const input = {
        redirect_url: 'https://rosy-007.convex.site/auth/callback',
        callback_url: 'https://rosy-007.convex.site/api/auth/github/callback',
        other_field: 'no change'
      };
      const expected = {
        redirect_url: 'https://auth.example.com/auth/callback',
        callback_url: 'https://auth.example.com/api/auth/github/callback',
        other_field: 'no change'
      };
      const result = replaceOAuthUrls(input, convexUrl, gatewayUrl);
      expect(result).toEqual(expected);
    });

    it('should replace URLs in nested objects', () => {
      const input = {
        oauth: {
          providers: {
            github: {
              redirect_uri: 'https://rosy-007.convex.site/api/auth/github/callback'
            },
            google: {
              redirect_uri: 'https://rosy-007.convex.site/api/auth/google/callback'
            }
          }
        },
        base_url: 'https://rosy-007.convex.site'
      };
      const expected = {
        oauth: {
          providers: {
            github: {
              redirect_uri: 'https://auth.example.com/api/auth/github/callback'
            },
            google: {
              redirect_uri: 'https://auth.example.com/api/auth/google/callback'
            }
          }
        },
        base_url: 'https://auth.example.com'
      };
      const result = replaceOAuthUrls(input, convexUrl, gatewayUrl);
      expect(result).toEqual(expected);
    });

    it('should replace URLs in arrays', () => {
      const input = {
        redirect_uris: [
          'https://rosy-007.convex.site/auth/callback',
          'https://rosy-007.convex.site/api/auth/github/callback',
          'https://other-domain.com/callback'  // Should not change
        ]
      };
      const expected = {
        redirect_uris: [
          'https://auth.example.com/auth/callback',
          'https://auth.example.com/api/auth/github/callback',
          'https://other-domain.com/callback'  // Should not change
        ]
      };
      const result = replaceOAuthUrls(input, convexUrl, gatewayUrl);
      expect(result).toEqual(expected);
    });

    it('should handle multiple occurrences in same string', () => {
      const input = 'Visit https://rosy-007.convex.site or https://rosy-007.convex.site/auth';
      const expected = 'Visit https://auth.example.com or https://auth.example.com/auth';
      const result = replaceOAuthUrls(input, convexUrl, gatewayUrl);
      expect(result).toBe(expected);
    });

    it('should not modify non-matching URLs', () => {
      const input = {
        external_url: 'https://github.com/oauth/authorize',
        callback_url: 'https://rosy-007.convex.site/callback',
        another_external: 'https://example.com'
      };
      const expected = {
        external_url: 'https://github.com/oauth/authorize',
        callback_url: 'https://auth.example.com/callback',
        another_external: 'https://example.com'
      };
      const result = replaceOAuthUrls(input, convexUrl, gatewayUrl);
      expect(result).toEqual(expected);
    });

    it('should handle null and undefined values', () => {
      const input = {
        url1: null,
        url2: undefined,
        url3: 'https://rosy-007.convex.site/callback'
      };
      const expected = {
        url1: null,
        url2: undefined,
        url3: 'https://auth.example.com/callback'
      };
      const result = replaceOAuthUrls(input, convexUrl, gatewayUrl);
      expect(result).toEqual(expected);
    });

    it('should handle non-string, non-object primitives', () => {
      const input = {
        number: 123,
        boolean: true,
        url: 'https://rosy-007.convex.site/callback'
      };
      const expected = {
        number: 123,
        boolean: true,
        url: 'https://auth.example.com/callback'
      };
      const result = replaceOAuthUrls(input, convexUrl, gatewayUrl);
      expect(result).toEqual(expected);
    });
  });

  describe('escapeRegExp', () => {
    it('should escape special regex characters', () => {
      expect(escapeRegExp('example.com')).toBe('example\\.com');
      expect(escapeRegExp('http://test.com?param=value')).toBe('http://test\\.com\\?param=value');
      expect(escapeRegExp('https://sub.domain.com/path[0]')).toBe('https://sub\\.domain\\.com/path\\[0\\]');
      expect(escapeRegExp('test+pattern*with?special^chars$')).toBe('test\\+pattern\\*with\\?special\\^chars\\$');
    });

    it('should handle empty string', () => {
      expect(escapeRegExp('')).toBe('');
    });

    it('should handle string with no special characters', () => {
      expect(escapeRegExp('simplestring')).toBe('simplestring');
    });
  });

  describe('Integration scenarios', () => {
    it('should handle typical Better Auth OAuth response', () => {
      const input = {
        url: 'https://github.com/login/oauth/authorize?client_id=12345&redirect_uri=https%3A%2F%2Frosy-007.convex.site%2Fapi%2Fauth%2Fgithub%2Fcallback&scope=user%3Aemail&state=abc123',
        redirect_uri: 'https://rosy-007.convex.site/api/auth/github/callback',
        state: 'abc123'
      };

      const result = replaceOAuthUrls(input, convexUrl, gatewayUrl);
      
      expect(result.redirect_uri).toBe('https://auth.example.com/api/auth/github/callback');
      expect(result.url).toContain('redirect_uri=https%3A%2F%2Fauth.example.com%2Fapi%2Fauth%2Fgithub%2Fcallback');
      expect(result.state).toBe('abc123'); // Should remain unchanged
    });

    it('should handle HTML response with redirect URLs', () => {
      const htmlInput = `
        <form action="https://github.com/login/oauth/authorize">
          <input type="hidden" name="redirect_uri" value="https://rosy-007.convex.site/api/auth/github/callback">
          <input type="hidden" name="client_id" value="12345">
        </form>
      `;
      
      const result = replaceOAuthUrls(htmlInput, convexUrl, gatewayUrl);
      
      expect(result).toContain('value="https://auth.example.com/api/auth/github/callback"');
      expect(result).toContain('action="https://github.com/login/oauth/authorize"'); // External URL unchanged
    });

    it('should handle URL-encoded redirect URIs', () => {
      const input = 'redirect_uri=https%3A%2F%2Frosy-007.convex.site%2Fapi%2Fauth%2Fgithub%2Fcallback';
      const expected = 'redirect_uri=https%3A%2F%2Fauth.example.com%2Fapi%2Fauth%2Fgithub%2Fcallback';
      const result = replaceOAuthUrls(input, convexUrl, gatewayUrl);
      expect(result).toBe(expected);
    });
  });
});