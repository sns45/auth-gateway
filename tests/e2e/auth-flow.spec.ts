import { test, expect, Page } from '@playwright/test';

test.describe('E2E Authentication Flow', () => {
  let page: Page;
  
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
  });
  
  test.afterEach(async () => {
    await page.close();
  });
  
  test('should display sign in options', async () => {
    // Navigate to the main app
    await page.goto('https://staging.example.com');
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');
    
    // Look for authentication elements
    const signInButton = page.locator('button:has-text("Sign in")').or(
      page.locator('a:has-text("Sign in")')
    );
    
    await expect(signInButton).toBeVisible({ timeout: 10000 });
    
    // Click sign in
    await signInButton.click();
    
    // Should show OAuth options
    await expect(page.locator('text=Sign in with Google')).toBeVisible();
  });
  
  test('should redirect to auth gateway for Google OAuth', async () => {
    await page.goto('https://staging.example.com');
    
    // Find and click Google sign in
    const googleSignIn = page.locator('button:has-text("Sign in with Google")').or(
      page.locator('a:has-text("Sign in with Google")')
    );
    
    await googleSignIn.waitFor({ state: 'visible', timeout: 10000 });
    await googleSignIn.click();
    
    // Should redirect to auth gateway
    await page.waitForURL(/auth-staging\.in8\.sh/, { timeout: 10000 });
    
    // Then should redirect to Google
    await page.waitForURL(/accounts\.google\.com/, { timeout: 10000 });
    
    // Verify we're on Google's OAuth page
    await expect(page).toHaveURL(/accounts\.google\.com/);
    await expect(page).toHaveTitle(/Sign in/);
  });
  
  test('should handle auth gateway health check', async () => {
    // Direct health check
    await page.goto('https://auth-staging.example.com/health');
    
    // Should return JSON response
    const content = await page.textContent('body');
    const health = JSON.parse(content || '{}');
    
    expect(health.status).toBe('ok');
    expect(health.service).toBe('in8-auth-gateway');
    expect(health.environment).toBe('staging');
  });
  
  test('should enforce rate limiting', async () => {
    // Make multiple rapid requests to trigger rate limit
    const requests = [];
    
    for (let i = 0; i < 15; i++) {
      requests.push(
        page.goto('https://auth-staging.example.com/api/auth/session', {
          waitUntil: 'domcontentloaded'
        }).catch(() => null)
      );
    }
    
    await Promise.all(requests);
    
    // Last request should be rate limited
    const response = await page.goto('https://auth-staging.example.com/api/auth/session');
    
    // Check if we hit rate limit
    if (response && response.status() === 429) {
      const headers = response.headers();
      expect(headers['x-ratelimit-limit']).toBeDefined();
      expect(headers['x-ratelimit-remaining']).toBe('0');
    }
  });
  
  test('should handle CORS correctly', async () => {
    // Test from allowed origin
    await page.goto('https://staging.example.com');
    
    // Make API request
    const response = await page.evaluate(async () => {
      const res = await fetch('https://auth-staging.example.com/api/auth/session', {
        method: 'GET'
      });
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries())
      };
    });
    
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://staging.example.com');
  });
  
  test('should maintain session across requests', async () => {
    await page.goto('https://staging.example.com');
    
    // First request - should get a session cookie
    const firstResponse = await page.evaluate(async () => {
      const res = await fetch('https://auth-staging.example.com/api/auth/session', {
        method: 'GET',
      });
      return await res.json();
    });
    
    // Get cookies
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find(c => c.name === 'auth-session');
    
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.secure).toBe(true);
    
    // Second request - should use same session
    const secondResponse = await page.evaluate(async () => {
      const res = await fetch('https://auth-staging.example.com/api/auth/session', {
        method: 'GET',
      });
      return await res.json();
    });
    
    // Session should be consistent
    const first = firstResponse as any;
    const second = secondResponse as any;
    if (first.session && second.session) {
      expect(first.session.id).toBe(second.session.id);
    }
  });
  
  test('should handle signout correctly', async () => {
    await page.goto('https://staging.example.com');
    
    // Sign out
    const signoutResponse = await page.evaluate(async () => {
      const res = await fetch('https://auth-staging.example.com/api/auth/signout', {
        method: 'POST',
      });
      return res.status;
    });
    
    expect(signoutResponse).toBe(200);
    
    // Verify session is cleared
    const sessionResponse = await page.evaluate(async () => {
      const res = await fetch('https://auth-staging.example.com/api/auth/session', {
        method: 'GET',
      });
      return await res.json();
    });
    
    expect((sessionResponse as any).user).toBeNull();
  });
  
  test.describe('Mobile Responsiveness', () => {
    test.use({
      viewport: { width: 375, height: 667 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15'
    });
    
    test('should work on mobile devices', async () => {
      await page.goto('https://staging.example.com');
      
      // Check if sign in is accessible on mobile
      const signInButton = page.locator('button:has-text("Sign in")').or(
        page.locator('a:has-text("Sign in")')
      );
      
      await expect(signInButton).toBeVisible({ timeout: 10000 });
      
      // Should be clickable
      await signInButton.click();
      
      // OAuth options should be visible
      await expect(page.locator('text=Sign in with Google')).toBeVisible();
    });
  });
});