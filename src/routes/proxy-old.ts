import { Hono } from 'hono';
import { CloudflareEnv, AuthContext } from '@/types/auth';
import { Variables } from '@/types/context';
import { APIErrorCodes, CONVEX_FORWARD_HEADERS, REMOVE_HEADERS } from '@/types/api';
import { requireAuth } from '@/middleware/auth';
import { ConvexService } from '@/services/convex';
import { Logger } from '@/middleware/logging';

/**
 * Convex Proxy Routes
 * Forwards authenticated requests to Convex backend
 */
export const proxyRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * ALL /api/* - Proxy all API requests to Convex
 * This is a catch-all route and should be registered LAST
 */
proxyRoutes.all('/*', requireAuth, async (c) => {
  const logger = c.get('logger') as Logger;
  const requestId = c.get('requestId') || 'unknown';
  const authContext = c.get('auth') as AuthContext;
  
  try {
    const convexService = new ConvexService(c.env, logger);
    
    // Extract the path - it's already without /api/ prefix since we're mounted on /api
    const originalPath = c.req.path;
    const proxiedPath = originalPath.replace(/^\//, '');
    
    // Get request details
    const method = c.req.method;
    const headers = extractHeaders(c);
    
    // Get request body if present (handle binary data)
    let body: string | ArrayBuffer | undefined;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      // Check content type to determine how to read body
      const contentType = c.req.header('content-type') || '';
      
      if (contentType.includes('application/octet-stream') || 
          contentType.includes('application/x-protobuf')) {
        // Handle binary data
        body = await c.req.arrayBuffer();
      } else {
        // Handle text data
        body = await c.req.text();
      }
    }

    logger.debug(`Proxying request to Convex`, {
      requestId,
      method,
      originalPath,
      proxiedPath,
      userId: authContext.user.id,
      requiresProtocolHandling: convexService.requiresProtocolHandling(originalPath)
    });

    // Use protocol-aware request handling if needed
    let response: Response;
    if (convexService.requiresProtocolHandling(originalPath)) {
      response = await convexService.handleConvexProtocolRequest(
        proxiedPath,
        method,
        headers,
        body,
        authContext.user.id,
        authContext.user.role,
        authContext.permissions,
        authContext.session_id,
        requestId
      );
    } else {
      // Fallback to regular proxy
      response = await convexService.proxyRequest(
        proxiedPath,
        method,
        headers,
        typeof body === 'string' ? body : undefined,
        authContext.user.id,
        authContext.user.role,
        authContext.permissions,
        authContext.session_id,
        requestId
      );
    }

    // Forward the response
    const responseBody = await response.text();
    
    // Copy response headers (filtered)
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      // Only forward safe headers
      const safePlaceholder = [
        'content-type',
        'content-length',
        'cache-control',
        'expires',
        'last-modified',
        'etag',
        'x-request-id',
        'x-response-time',
      ];
      
      if (safePlaceholder.includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    logger.debug(`Convex response received`, {
      requestId,
      status: response.status,
      contentType: response.headers.get('content-type'),
    });

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (_error) {
    logger.error(`Proxy error`, {
      requestId,
      error: _error instanceof Error ? {
        name: _error.name,
        message: _error.message,
        stack: _error.stack,
      } : _error,
      path: c.req.path,
      method: c.req.method,
      userId: authContext.user.id,
    });

    return c.json({
      success: false,
      error: {
        message: 'Backend service unavailable',
        code: APIErrorCodes.CONVEX_ERROR,
        request_id: requestId,
      }
    }, 502);
  }
});

/**
 * GET /api/health - Health check endpoint (doesn't require auth)
 */
proxyRoutes.get('/health', async (c) => {
  const logger = c.get('logger') as Logger;
  const requestId = c.get('requestId') || 'unknown';
  
  try {
    const convexService = new ConvexService(c.env, logger);
    const isHealthy = await convexService.checkHealth();
    
    if (isHealthy) {
      return c.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
          convex: 'healthy',
          gateway: 'healthy',
        }
      });
    } else {
      return c.json({
        status: 'degraded',
        timestamp: new Date().toISOString(),
        services: {
          convex: 'unhealthy',
          gateway: 'healthy',
        }
      }, 503);
    }
  } catch (_error) {
    logger.error(`Health check error`, _error);
    return c.json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
      request_id: requestId,
    }, 500);
  }
});

/**
 * WebSocket proxy support
 */
proxyRoutes.get('/api/ws', requireAuth, async (c) => {
  const logger = c.get('logger') as Logger;
  const authContext = c.get('auth') as AuthContext;
  const requestId = c.get('requestId') || 'unknown';
  
  // Check if this is a WebSocket upgrade request
  const upgrade = c.req.header('upgrade');
  if (upgrade?.toLowerCase() !== 'websocket') {
    return c.json({
      success: false,
      error: {
        message: 'WebSocket upgrade required',
        code: APIErrorCodes.INVALID_REQUEST,
      }
    }, 400);
  }

  try {
    logger.info(`WebSocket connection request`, {
      userId: authContext.user.id,
      userRole: authContext.user.role,
      requestId
    });

    // Create Convex service for protocol handling
    const convexService = new ConvexService(c.env, logger);

    // Import WebSocketProxy dynamically to avoid issues
    const { WebSocketProxy } = await import('@/websocket/proxy');
    
    // Configure WebSocket proxy options
    const options = {
      convexUrl: c.env.CONVEX_URL,
      convexApiKey: c.env.CONVEX_DEPLOY_KEY,
      maxMessageSize: 1024 * 1024, // 1MB
      connectionTimeout: 30000, // 30 seconds
      heartbeatInterval: 30000, // 30 seconds
      maxReconnectAttempts: 5
    };

    // Handle WebSocket upgrade with Convex protocol support
    return await WebSocketProxy.handleUpgrade(
      c.req.raw,
      authContext,
      options,
      logger,
      convexService
    );

  } catch (_error) {
    logger.error(`WebSocket proxy error`, {
      error: _error instanceof Error ? {
        name: _error.name,
        message: _error.message,
        stack: _error.stack
      } : _error,
      requestId,
      userId: authContext.user.id
    });
    
    return c.json({
      success: false,
      error: {
        message: 'WebSocket service error',
        code: APIErrorCodes.INTERNAL_ERROR,
        request_id: requestId
      }
    }, 500);
  }
});

/**
 * WebSocket proxy for versioned sync endpoint (e.g., /api/1.25.4/sync)
 * This route must be registered BEFORE the general /api/* catch-all route
 */
proxyRoutes.get('/:version/sync', requireAuth, async (c) => {
  const logger = c.get('logger') as Logger;
  const authContext = c.get('auth') as AuthContext;
  const requestId = c.get('requestId') || 'unknown';
  
  // Check if this is a WebSocket upgrade request
  const upgrade = c.req.header('upgrade');
  if (upgrade?.toLowerCase() !== 'websocket') {
    return c.json({
      success: false,
      error: {
        message: 'WebSocket upgrade required',
        code: APIErrorCodes.INVALID_REQUEST,
      }
    }, 400);
  }

  try {
    logger.info(`Versioned sync WebSocket connection request`, {
      userId: authContext.user.id,
      userRole: authContext.user.role,
      requestId,
      path: c.req.path
    });

    // Create Convex service for protocol handling
    const convexService = new ConvexService(c.env, logger);

    // Import WebSocketProxy dynamically to avoid issues
    const { WebSocketProxy } = await import('@/websocket/proxy');
    
    // Configure WebSocket proxy options
    const options = {
      convexUrl: c.env.CONVEX_URL,
      convexApiKey: c.env.CONVEX_DEPLOY_KEY,
      maxMessageSize: 1024 * 1024, // 1MB
      connectionTimeout: 30000, // 30 seconds
      heartbeatInterval: 30000, // 30 seconds
      maxReconnectAttempts: 5
    };

    // Handle WebSocket upgrade with Convex protocol support
    return await WebSocketProxy.handleUpgrade(
      c.req.raw,
      authContext,
      options,
      logger,
      convexService
    );

  } catch (_error) {
    logger.error(`Versioned sync WebSocket proxy error`, {
      error: _error instanceof Error ? {
        name: _error.name,
        message: _error.message,
        stack: _error.stack
      } : _error,
      requestId,
      userId: authContext.user.id,
      path: c.req.path
    });
    
    return c.json({
      success: false,
      error: {
        message: 'WebSocket service error',
        code: APIErrorCodes.INTERNAL_ERROR,
        request_id: requestId
      }
    }, 500);
  }
});

/**
 * Request size validation middleware for proxy routes
 */
proxyRoutes.use('*', async (c, next) => {
  const contentLength = c.req.header('content-length');
  const maxSize = 10 * 1024 * 1024; // 10MB limit for API requests
  
  if (contentLength && parseInt(contentLength) > maxSize) {
    return c.json({
      success: false,
      error: {
        message: 'Request entity too large',
        code: APIErrorCodes.INVALID_REQUEST,
        details: `Maximum request size is ${maxSize} bytes`,
      }
    }, 413);
  }

  await next();
});

/**
 * Content-Type validation for certain methods
 */
proxyRoutes.use('*', async (c, next) => {
  const method = c.req.method;
  
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const contentType = c.req.header('content-type');
    
    if (!contentType) {
      return c.json({
        success: false,
        error: {
          message: 'Content-Type header required',
          code: APIErrorCodes.INVALID_REQUEST,
        }
      }, 400);
    }

    // Allow common content types
    const allowedTypes = [
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'text/plain',
    ];

    const baseContentType = contentType.split(';')[0].trim();
    if (!allowedTypes.includes(baseContentType)) {
      return c.json({
        success: false,
        error: {
          message: 'Unsupported Content-Type',
          code: APIErrorCodes.INVALID_REQUEST,
          details: `Supported types: ${allowedTypes.join(', ')}`,
        }
      }, 400);
    }
  }

  await next();
});

/**
 * Helper Functions
 */

/**
 * Extract and filter headers for proxying
 */
function extractHeaders(c: any): Record<string, string> {
  const headers: Record<string, string> = {};
  const originalHeaders = c.req.raw.headers;

  // Copy allowed headers
  CONVEX_FORWARD_HEADERS.forEach(header => {
    const value = originalHeaders.get(header);
    if (value) {
      headers[header] = value;
    }
  });

  // Remove headers that shouldn't be forwarded
  REMOVE_HEADERS.forEach(header => {
    delete headers[header];
  });

  return headers;
}

/**
 * Validate JSON request body
 */

/**
 * Stream response helper (for large responses)
 */

/**
 * Request timeout handler
 */
