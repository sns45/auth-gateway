import { Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { AuthContext, SessionData } from '@/types/auth';
import { APIErrorCodes } from '@/types/api';
import { AppContext } from '@/types/context';
import { verifyJWT, extractJWTFromHeader } from '@/utils/jwt';
import { SessionService } from '@/services/session';
import { ConvexService } from '@/services/convex';
import { Logger } from '@/middleware/logging';

/**
 * Authentication middleware
 * Validates JWT tokens and session cookies
 */
export function createAuthMiddleware(options: {
  required?: boolean;
  requireSession?: boolean;
} = {}) {
  const { required = true, requireSession = true } = options;

  return async (c: AppContext, next: Next) => {
    const env = c.env;
    const requestId = c.get('requestId') || 'unknown';
    
    try {
      // Initialize services
      const logger = c.get('logger') as Logger;
      const sessionService = new SessionService(env, logger);
      const convexService = new ConvexService(env, logger);

      // Try to extract token from multiple sources
      let token: string | null = null;
      let sessionId: string | null = null;

      // 1. Check Authorization header
      const authHeader = c.req.header('authorization');
      if (authHeader) {
        token = extractJWTFromHeader(authHeader);
      }

      // 2. Check session cookie
      if (!token && requireSession) {
        const validatedEnv = c.get('validatedEnv');
        const cookieName = validatedEnv.SESSION_COOKIE_NAME || 'auth_session';
        sessionId = getCookie(c, cookieName) || null;
        
        if (sessionId) {
          // Validate session and extract token
          const sessionData = await sessionService.validateSession(sessionId);
          if (sessionData) {
            // For session-based auth, we might need to create a temporary token
            // or validate the session differently
            // For now, we'll trust the session validation
            const authContext: AuthContext = {
              user: {
                id: sessionData.user_id,
                email: '', // We'll need to fetch this
                name: '',
                role: sessionData.user_role as any,
                created_at: sessionData.created_at,
                last_login: sessionData.last_activity,
              },
              session: sessionData,
              session_id: sessionId,
              permissions: sessionData.permissions,
              // No JWT token for session-based auth
            };

            // Fetch user profile from Convex
            const userProfile = await convexService.getUserProfile(sessionData.user_id);
            if (userProfile) {
              authContext.user = userProfile;
            }

            // Set auth context
            c.set('auth', authContext);
            c.set('user', authContext.user);
            c.set('session', authContext.session);
            c.set('permissions', authContext.permissions);

            // Log successful session auth
            if (env.LOG_LEVEL === 'debug') {
              console.log(`[AUTH] ${requestId}: Session authenticated user ${sessionData.user_id}`);
            }

            await next();
            return;
          }
        }
      }

      // 3. Validate JWT token
      if (token) {
        const payload = await verifyJWT(token, env.JWT_SECRET);
        
        // Get session data if session_id is in token
        let sessionData: SessionData | null = null;
        if (payload.session_id) {
          sessionData = await sessionService.getSession(payload.session_id);
          if (!sessionData) {
            throw new Error('Session not found or expired');
          }
        }

        // Fetch user profile
        const userProfile = await convexService.getUserProfile(payload.sub);
        if (!userProfile) {
          throw new Error('User not found');
        }

        // Create auth context
        const authContext: AuthContext = {
          user: userProfile,
          session: sessionData!,
          session_id: payload.session_id,
          permissions: payload.permissions,
          token: token, // Store the JWT token
        };

        // Set context
        c.set('auth', authContext);
        c.set('user', authContext.user);
        c.set('session', authContext.session);
        c.set('permissions', authContext.permissions);

        // Log successful JWT auth
        if (env.LOG_LEVEL === 'debug') {
          console.log(`[AUTH] ${requestId}: JWT authenticated user ${payload.sub}`);
        }

        await next();
        return;
      }

      // No valid authentication found
      if (required) {
        console.warn(`[AUTH] ${requestId}: Authentication required but not provided`);
        return c.json({
          success: false,
          error: {
            message: 'Authentication required',
            code: APIErrorCodes.AUTH_REQUIRED,
            details: 'Valid session cookie or Bearer token required',
          }
        }, 401);
      }

      // Optional auth - continue without auth context
      await next();

    } catch (error) {
      console.error(`[AUTH] ${requestId}: Authentication error:`, error);
      
      if (required) {
        return c.json({
          success: false,
          error: {
            message: 'Authentication failed',
            code: APIErrorCodes.TOKEN_INVALID,
            details: error instanceof Error ? error.message : 'Invalid token or session',
          }
        }, 401);
      }

      // Optional auth - continue without auth context
      await next();
    }
  };
}

/**
 * Authorization middleware
 * Checks user permissions for specific resources
 */
export function createAuthorizationMiddleware(requiredPermissions: string[]) {
  return async (c: AppContext, next: Next) => {
    const authContext = c.get('auth') as AuthContext;
    const requestId = c.get('requestId') || 'unknown';

    if (!authContext) {
      console.warn(`[AUTHZ] ${requestId}: No auth context for authorization check`);
      return c.json({
        success: false,
        error: {
          message: 'Authentication required',
          code: APIErrorCodes.AUTH_REQUIRED,
          details: 'Must be authenticated to access this resource',
        }
      }, 401);
    }

    // Check if user has required permissions
    const userPermissions = authContext.permissions || [];
    const hasPermission = requiredPermissions.every(perm => 
      userPermissions.includes(perm) || userPermissions.includes('admin')
    );

    if (!hasPermission) {
      console.warn(`[AUTHZ] ${requestId}: Access denied for user ${authContext.user.id}, required: ${requiredPermissions.join(', ')}, has: ${userPermissions.join(', ')}`);
      return c.json({
        success: false,
        error: {
          message: 'Access denied',
          code: APIErrorCodes.ACCESS_DENIED,
          details: `Insufficient permissions. Required: ${requiredPermissions.join(', ')}`,
        }
      }, 403);
    }

    // Log successful authorization
    if (c.env.LOG_LEVEL === 'debug') {
      console.log(`[AUTHZ] ${requestId}: Authorized user ${authContext.user.id} for ${requiredPermissions.join(', ')}`);
    }

    await next();
  };
}

/**
 * Role-based authorization middleware
 */
export function requireRole(allowedRoles: string[]) {
  return async (c: AppContext, next: Next) => {
    const authContext = c.get('auth') as AuthContext;
    const requestId = c.get('requestId') || 'unknown';

    if (!authContext) {
      return c.json({
        success: false,
        error: {
          message: 'Authentication required',
          code: APIErrorCodes.AUTH_REQUIRED,
        }
      }, 401);
    }

    if (!allowedRoles.includes(authContext.user.role)) {
      console.warn(`[ROLE] ${requestId}: Role ${authContext.user.role} not in allowed roles: ${allowedRoles.join(', ')}`);
      return c.json({
        success: false,
        error: {
          message: 'Access denied',
          code: APIErrorCodes.ACCESS_DENIED,
          details: `Role '${authContext.user.role}' not authorized`,
        }
      }, 403);
    }

    await next();
  };
}

/**
 * Optional authentication middleware
 * Sets auth context if present but doesn't require it
 */
export const optionalAuth = createAuthMiddleware({ required: false });

/**
 * Required authentication middleware
 * Requires valid authentication
 */
export const requireAuth = createAuthMiddleware({ required: true });

/**
 * Session-based authentication middleware
 * Specifically requires session cookie authentication
 */
export const requireSession = createAuthMiddleware({ 
  required: true, 
  requireSession: true 
});

/**
 * Admin-only authorization middleware
 */
export const requireAdmin = requireRole(['admin']);

/**
 * User or admin authorization middleware
 */
export const requireUser = requireRole(['user', 'admin']);