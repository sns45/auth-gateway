import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { CloudflareEnv } from '@/types/auth';
import { Variables } from '@/types/context';
import { APIErrorCodes, AuthResponse } from '@/types/api';
import { validateRequestBody, validateQueryParams, LoginRequestSchema, OAuthCallbackSchema } from '@/utils/validation';
import { createJWT, createRefreshToken } from '@/utils/jwt';
import { SessionService } from '@/services/session';
import { ConvexService } from '@/services/convex';
import { OAuthService } from '@/services/oauth';
import { requireAuth, optionalAuth } from '@/middleware/auth';
import { createRateLimitMiddleware } from '@/middleware/rate-limit';
import { Logger } from '@/middleware/logging';

/**
 * Authentication Routes
 */
export const authRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

// Apply rate limiting to auth routes
const authRateLimit = createRateLimitMiddleware({
  customConfig: 'authentication',
});


/**
 * POST /auth/login - Email/Password Login
 */
authRoutes.post('/login', authRateLimit, async (c) => {
  const logger = c.get('logger') as Logger;
  const requestId = c.get('requestId') || 'unknown';
  
  try {
    // Validate request body
    const validation = await validateRequestBody(c, LoginRequestSchema);
    if (!validation.success) {
      return c.json({
        success: false,
        error: validation.error,
      }, 400);
    }

    const { email, password, rememberMe } = validation.data;
    
    // Initialize services
    const convexService = new ConvexService(c.env, logger);
    const sessionService = new SessionService(c.env, logger);
    
    // Authenticate with Convex
    const user = await convexService.authenticateUser(email, password);
    if (!user) {
      logger.warn(`Login failed for ${email}`, { requestId, email });
      return c.json({
        success: false,
        error: {
          message: 'Invalid credentials',
          code: APIErrorCodes.INVALID_CREDENTIALS,
        }
      }, 401);
    }

    // Get user permissions
    const permissions = await convexService.getUserPermissions(user.id, user.role);
    
    // Create session
    const ip = getClientIP(c);
    const userAgent = c.req.header('user-agent') || 'unknown';
    const { sessionId } = await sessionService.createSession(
      user,
      ip,
      userAgent,
      permissions
    );

    // Create JWT token
    const tokenExpiry = rememberMe ? 7 * 24 * 3600 : 3600; // 7 days or 1 hour
    const _token = await createJWT({
      sub: user.id,
      role: user.role,
      permissions,
      session_id: sessionId,
    }, c.env.JWT_SECRET, tokenExpiry);

    // Create refresh token
    const _refreshToken = await createRefreshToken(
      user.id,
      sessionId,
      c.env.JWT_SECRET,
      rememberMe ? 30 * 24 * 3600 : 7 * 24 * 3600 // 30 days or 7 days
    );

    // Set session cookie
    const cookieOptions = {
      httpOnly: true,
      secure: c.env.NODE_ENV === 'production',
      sameSite: 'Strict' as const,
      maxAge: rememberMe ? 7 * 24 * 3600 : 24 * 3600,
      path: '/',
    };

    setCookie(c, c.env.SESSION_COOKIE_NAME || 'auth_session', sessionId, cookieOptions);
    
    // Also set a non-httpOnly cookie for the session ID that JavaScript can read
    const isProdOrStaging = c.env.NODE_ENV === 'production' || c.env.NODE_ENV === 'staging';
    const cookieDomainStr = isProdOrStaging ? '; Domain=.example.com' : '';
    c.header('Set-Cookie', `auth_session_id=${sessionId}; Path=/; Max-Age=${cookieOptions.maxAge}${cookieDomainStr}; SameSite=${cookieOptions.sameSite}${isProdOrStaging ? '; Secure' : ''}`, { append: true });

    // Update last login
    await convexService.updateLastLogin(user.id);

    logger.info(`User logged in`, { 
      requestId, 
      userId: user.id, 
      email: user.email,
      rememberMe: rememberMe 
    });

    const response: AuthResponse = {
      success: true,
      user,
      expires_at: new Date(Date.now() + tokenExpiry * 1000).toISOString(),
    };

    return c.json(response);

  } catch (error) {
    logger.error(`Login error`, error);
    return c.json({
      success: false,
      error: {
        message: 'Authentication service error',
        code: APIErrorCodes.INTERNAL_ERROR,
      }
    }, 500);
  }
});

/**
 * GET /api/auth/signin/{provider} - OAuth Login Initiation (Better Auth pattern)
 */
authRoutes.get('/signin/:provider', async (c) => {
  const logger = c.get('logger') as Logger;
  const provider = c.req.param('provider') as any;
  const baseUrl = getBaseURL(c);
  const redirectUri = c.req.query('redirect_uri') || `${baseUrl}/api/auth/callback/${provider}`;
  
  try {
    const oauthService = new OAuthService(c.env);
    
    if (!oauthService.isProviderSupported(provider)) {
      return c.json({
        success: false,
        error: {
          message: 'OAuth provider not supported',
          code: APIErrorCodes.INVALID_PARAMETER,
        }
      }, 400);
    }

    const authUrl = oauthService.getAuthorizationUrl(provider, redirectUri);
    if (!authUrl) {
      return c.json({
        success: false,
        error: {
          message: 'OAuth provider not configured',
          code: APIErrorCodes.OAUTH_ERROR,
        }
      }, 500);
    }

    logger.info(`OAuth login initiated`, { 
      provider, 
      redirectUri, 
      baseUrl,
      configuredBaseUrl: c.env.OAUTH_BASE_URL || 'none' 
    });
    
    return c.redirect(authUrl);

  } catch (error) {
    logger.error(`OAuth initiation error`, error);
    return c.json({
      success: false,
      error: {
        message: 'OAuth service error',
        code: APIErrorCodes.OAUTH_ERROR,
      }
    }, 500);
  }
});

/**
 * GET /api/auth/callback/{provider} - OAuth Callback
 */
authRoutes.get('/callback/:provider', async (c) => {
  const logger = c.get('logger') as Logger;
  const provider = c.req.param('provider') as any;
  const requestId = c.get('requestId') || 'unknown';
  
  try {
    // Validate query parameters
    const validation = validateQueryParams(c, OAuthCallbackSchema);
    if (!validation.success) {
      logger.error('OAuth callback validation failed', {
        requestId,
        provider,
        error: validation.error,
        query: c.req.query()
      });
      
      const frontendUrl = getFrontendURL(c);
      return c.redirect(`${frontendUrl}?auth=error&message=${encodeURIComponent('Invalid OAuth callback')}&provider=${provider}`);
    }

    const { code } = validation.data;
    
    // Initialize services
    const oauthService = new OAuthService(c.env);
    const convexService = new ConvexService(c.env, logger);
    const sessionService = new SessionService(c.env, logger);
    
    // Exchange code for token
    const baseUrl = getBaseURL(c);
    const redirectUri = `${baseUrl}/api/auth/callback/${provider}`;
    
    logger.info(`OAuth callback processing`, { 
      requestId,
      provider, 
      redirectUri, 
      baseUrl,
      hostname: new URL(c.req.url).hostname
    });
    
    const accessToken = await oauthService.exchangeCodeForToken(provider, code, redirectUri);
    
    if (!accessToken) {
      logger.error('OAuth token exchange failed', {
        requestId,
        provider,
        redirectUri
      });
      
      const frontendUrl = getFrontendURL(c);
      return c.redirect(`${frontendUrl}?auth=error&message=${encodeURIComponent('OAuth authentication failed')}&provider=${provider}&details=token_exchange_failed`);
    }

    // Get user info from OAuth provider
    let userInfo = await oauthService.getUserInfo(provider, accessToken);
    if (!userInfo) {
      logger.error('Failed to get user info', {
        requestId,
        provider
      });
      
      const frontendUrl = getFrontendURL(c);
      return c.redirect(`${frontendUrl}?auth=error&message=${encodeURIComponent('OAuth authentication failed')}&provider=${provider}&details=user_info_failed`);
    }

    if (!userInfo.email) {
      logger.error('Email missing from OAuth response', {
        requestId,
        provider,
        userInfo: { id: userInfo.id, name: userInfo.name }
      });
      
      const frontendUrl = getFrontendURL(c);
      return c.redirect(`${frontendUrl}?auth=error&message=${encodeURIComponent('Email address is required')}&provider=${provider}&details=email_missing`);
    }

    // Handle user in Convex (create or update)
    const user = await convexService.handleOAuthUser(
      provider,
      userInfo.id,
      userInfo.email,
      userInfo.name,
      userInfo.avatar_url
    );

    // Get user permissions
    const permissions = await convexService.getUserPermissions(user.id, user.role);
    
    // Create session
    const ip = getClientIP(c);
    const userAgent = c.req.header('user-agent') || 'unknown';
    const { sessionId } = await sessionService.createSession(
      user,
      ip,
      userAgent,
      permissions
    );

    // Set session cookie with proper domain handling
    const isProduction = c.env.NODE_ENV === 'production';
    const hostname = new URL(c.req.url).hostname;
    
    // Determine cookie domain based on environment
    let cookieDomain: string | undefined;
    if (isProduction) {
      if (hostname.includes('staging')) {
        cookieDomain = '.example.com'; // Allow cookie on all staging subdomains
      } else {
        cookieDomain = '.example.com'; // Allow cookie on all production subdomains
      }
    }
    
    const cookieOptions = {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax' as const, // Changed from 'Strict' to 'lax' for OAuth flows
      maxAge: 7 * 24 * 3600, // 7 days
      path: '/',
      domain: cookieDomain,
    };

    setCookie(c, c.env.SESSION_COOKIE_NAME || 'auth_session', sessionId, cookieOptions);
    
    // Also set a non-httpOnly cookie for the session ID that JavaScript can read
    const isProdOrStaging = c.env.NODE_ENV === 'production' || c.env.NODE_ENV === 'staging';
    const cookieDomainStr = isProdOrStaging ? '; Domain=.example.com' : '';
    c.header('Set-Cookie', `auth_session_id=${sessionId}; Path=/; Max-Age=${cookieOptions.maxAge}${cookieDomainStr}; SameSite=${cookieOptions.sameSite}${isProdOrStaging ? '; Secure' : ''}`, { append: true });

    // Update last login
    await convexService.updateLastLogin(user.id);

    logger.info(`OAuth login successful`, { 
      requestId,
      provider, 
      userId: user.id, 
      email: user.email 
    });

    // Redirect to frontend with success
    const frontendUrl = getFrontendURL(c);
    return c.redirect(`${frontendUrl}?auth=success&provider=${provider}`);

  } catch (error) {
    logger.error(`OAuth callback error`, {
      requestId,
      provider,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    // Redirect to frontend with error
    const frontendUrl = getFrontendURL(c);
    const errorMessage = error instanceof Error ? error.message : 'OAuth authentication failed';
    return c.redirect(`${frontendUrl}?auth=error&message=${encodeURIComponent(errorMessage)}&provider=${provider}`);
  }
});

/**
 * POST /auth/refresh - Refresh Token
 */
authRoutes.post('/refresh', requireAuth, async (c) => {
  const logger = c.get('logger') as Logger;
  const authContext = c.get('auth');
  
  try {
    const sessionService = new SessionService(c.env, logger);
    const convexService = new ConvexService(c.env, logger);
    
    // Get current session
    const _currentSession = authContext.session;
    const user = authContext.user;
    
    // Update session activity
    await sessionService.updateSessionActivity(authContext.session_id);
    
    // Get updated permissions
    const permissions = await convexService.getUserPermissions(user.id, user.role);
    
    // Create new JWT token
    const _token = await createJWT({
      sub: user.id,
      role: user.role,
      permissions,
      session_id: authContext.session_id,
    }, c.env.JWT_SECRET, 3600); // 1 hour

    logger.info(`Token refreshed`, { userId: user.id });

    const response: AuthResponse = {
      success: true,
      user,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    };

    return c.json(response);

  } catch (error) {
    logger.error(`Token refresh error`, error);
    return c.json({
      success: false,
      error: {
        message: 'Token refresh failed',
        code: APIErrorCodes.TOKEN_INVALID,
      }
    }, 401);
  }
});

/**
 * POST /auth/logout - Logout
 */
authRoutes.post('/logout', optionalAuth, async (c) => {
  const logger = c.get('logger') as Logger;
  const authContext = c.get('auth');
  
  try {
    if (authContext) {
      const sessionService = new SessionService(c.env, logger);
      
      // Delete session
      await sessionService.deleteSession(authContext.session_id);
      
      logger.info(`User logged out`, { userId: authContext.user.id });
    }

    // Clear session cookies with explicit Set-Cookie headers
    const isProduction = c.env.NODE_ENV === 'production' || c.env.NODE_ENV === 'staging';
    const hostname = new URL(c.req.url).hostname;
    
    // Determine cookie domain based on environment
    let cookieDomain = '';
    if (isProduction) {
      cookieDomain = '; Domain=.example.com';
    }
    
    // Clear both cookies by setting them to expire in the past
    c.header('Set-Cookie', `auth_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT${cookieDomain}; HttpOnly; SameSite=Lax${isProduction ? '; Secure' : ''}`, { append: true });
    c.header('Set-Cookie', `auth_session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT${cookieDomain}; SameSite=Lax${isProduction ? '; Secure' : ''}`, { append: true });

    return c.json({ success: true });

  } catch (error) {
    logger.error(`Logout error`, error);
    return c.json({ success: true }); // Always succeed logout
  }
});

/**
 * POST /auth/signout - Sign Out (Better Auth compatible)
 */
authRoutes.post('/signout', optionalAuth, async (c) => {
  const logger = c.get('logger') as Logger;
  const authContext = c.get('auth');
  
  try {
    if (authContext) {
      const sessionService = new SessionService(c.env, logger);
      
      // Delete session
      await sessionService.deleteSession(authContext.session_id);
      
      logger.info(`User signed out`, { userId: authContext.user.id });
    }

    // Clear session cookies with explicit Set-Cookie headers
    const isProduction = c.env.NODE_ENV === 'production' || c.env.NODE_ENV === 'staging';
    const hostname = new URL(c.req.url).hostname;
    
    // Determine cookie domain based on environment
    let cookieDomain = '';
    if (isProduction) {
      cookieDomain = '; Domain=.example.com';
    }
    
    // Clear both cookies by setting them to expire in the past
    c.header('Set-Cookie', `auth_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT${cookieDomain}; HttpOnly; SameSite=Lax${isProduction ? '; Secure' : ''}`, { append: true });
    c.header('Set-Cookie', `auth_session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT${cookieDomain}; SameSite=Lax${isProduction ? '; Secure' : ''}`, { append: true });

    return c.json({ success: true });

  } catch (error) {
    logger.error(`Sign out error`, error);
    return c.json({ success: true }); // Always succeed logout
  }
});

/**
 * GET /auth/me - Get Current User
 */
authRoutes.get('/me', requireAuth, async (c) => {
  const authContext = c.get('auth');
  
  return c.json({
    success: true,
    user: authContext.user,
    session: {
      id: authContext.session_id,
      expiresAt: authContext.session.expires_at,
    },
    permissions: authContext.permissions,
    session_expires_at: authContext.session.expires_at,
  });
});

/**
 * GET /auth/session - Get Current Session (alias for /me)
 */
authRoutes.get('/session', requireAuth, async (c) => {
  const authContext = c.get('auth');
  
  return c.json({
    success: true,
    user: authContext.user,
    session: {
      id: authContext.session_id,
      expiresAt: authContext.session.expires_at,
    },
    permissions: authContext.permissions,
    session_expires_at: authContext.session.expires_at,
  });
});

/**
 * GET /auth/get-session - Get Current Session Status (no auth required)
 */
authRoutes.get('/get-session', optionalAuth, async (c) => {
  const authContext = c.get('auth');
  
  // If no session, return 204 No Content
  if (!authContext) {
    return c.body(null, 204);
  }
  
  return c.json({
    success: true,
    user: authContext.user,
    session: {
      id: authContext.session_id,
      expiresAt: authContext.session.expires_at,
    },
  });
});

/**
 * GET /auth/providers - Get Available OAuth Providers
 */
authRoutes.get('/providers', async (c) => {
  const oauthService = new OAuthService(c.env);
  const providers = oauthService.getAvailableProviders();
  
  return c.json({
    success: true,
    providers,
  });
});

/**
 * Helper Functions
 */

function getClientIP(c: any): string {
  const headers = [
    'cf-connecting-ip',
    'x-forwarded-for',
    'x-real-ip',
    'x-client-ip',
  ];

  for (const header of headers) {
    const value = c.req.header(header);
    if (value) {
      return value.split(',')[0].trim();
    }
  }

  return c.req.header('remote-addr') || 'unknown';
}

function getBaseURL(c: any): string {
  // Use configured OAuth base URL if available
  if (c.env.OAUTH_BASE_URL) {
    return c.env.OAUTH_BASE_URL;
  }
  
  // Fallback to environment-specific base URL
  const hostname = new URL(c.req.url).hostname;
  
  if (hostname === 'auth.example.com') {
    return 'https://auth.example.com';
  } else if (hostname === 'auth-staging.example.com') {
    return 'https://auth-staging.example.com';
  } else {
    // For development, use localhost with the appropriate port
    const protocol = c.env.NODE_ENV === 'production' ? 'https' : 'http';
    const host = c.req.header('host') || 'localhost:8787';
    return `${protocol}://${host}`;
  }
}

function getFrontendURL(c: any): string {
  // Detect environment based on the request hostname
  const hostname = new URL(c.req.url).hostname;
  
  // Production environments
  if (hostname === 'auth.example.com') {
    return 'https://example.com';
  } else if (hostname === 'auth-staging.example.com') {
    return 'https://staging.example.com';
  }
  
  // Use configured frontend URL if available
  if (c.env.FRONTEND_URL) {
    return c.env.FRONTEND_URL;
  }
  
  // Fallback to allowed origins
  if (c.env.ALLOWED_ORIGINS) {
    const origins = c.env.ALLOWED_ORIGINS.split(',');
    return origins[0] || 'http://localhost:5173';
  }
  
  // Development fallback
  return 'http://localhost:5173';
}