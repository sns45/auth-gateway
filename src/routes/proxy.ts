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
 * GET /api/health - Health check endpoint (doesn't require auth)
 * Must be registered BEFORE catch-all routes
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
  } catch (error) {
    logger.error(`Health check error`, error);
    return c.json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
      request_id: requestId,
    }, 500);
  }
});

/**
 * WebSocket proxy for /api/ws
 * Must be registered BEFORE catch-all routes
 */
proxyRoutes.get('/ws', requireAuth, async (c) => {
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

  } catch (error) {
    logger.error(`WebSocket proxy error`, {
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error,
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
 * Must be registered BEFORE catch-all routes
 */
proxyRoutes.get('/:version/sync', requireAuth, async (c) => {
  const logger = c.get('logger') as Logger;
  const authContext = c.get('auth') as AuthContext;
  const requestId = c.get('requestId') || 'unknown';
  const version = c.req.param('version');
  
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
      path: c.req.path,
      version
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

  } catch (error) {
    logger.error(`Versioned sync WebSocket proxy error`, {
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error,
      requestId,
      userId: authContext.user.id,
      version
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
 * ALL /api/* - Proxy all API requests to Convex
 * This is a catch-all route and MUST be registered LAST
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
    let body: string | undefined;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      // Check content type to determine how to read body
      const contentType = c.req.header('content-type') || '';
      
      if (contentType.includes('application/octet-stream') || 
          contentType.includes('application/x-protobuf')) {
        // Handle binary data - convert to base64 string
        const arrayBuffer = await c.req.arrayBuffer();
        body = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
      } else {
        // Handle text data
        body = await c.req.text();
      }
    }

    // Get query string
    const queryString = new URL(c.req.url).search;
    const fullPath = proxiedPath + queryString;
    
    logger.debug(`Proxying API request to Convex`, {
      requestId,
      originalPath,
      proxiedPath,
      fullPath,
      method,
      userId: authContext.user.id,
    });

    // Forward request to Convex
    const response = await convexService.proxyRequest(
      fullPath,
      method,
      headers,
      body
    );

    // Get response body
    const responseArrayBuffer = await response.arrayBuffer();
    let responseBody: ArrayBuffer | Uint8Array = responseArrayBuffer;
    
    // Check if response is JSON to potentially transform it
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      // Convert to string for JSON processing
      const text = new TextDecoder().decode(responseArrayBuffer);
      
      // You could transform the JSON here if needed
      // For example, adding gateway metadata
      
      // Convert back to Uint8Array for the response
      responseBody = new TextEncoder().encode(text);
    }

    // Prepare response headers
    const responseHeaders: Record<string, string> = {};
    
    // Only forward safe headers from Convex
    response.headers.forEach((value, key) => {
      // Skip headers that should not be forwarded
      if ((REMOVE_HEADERS as readonly string[]).includes(key.toLowerCase())) {
        return;
      }
      
      // Include specific headers that are safe
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

  } catch (error) {
    logger.error(`Proxy error`, {
      requestId,
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : error,
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
 * Extract headers to forward to Convex
 */
function extractHeaders(c: any): Record<string, string> {
  const headers: Record<string, string> = {};
  const authContext = c.get('auth') as AuthContext;
  
  // Add authorization header with user context
  // Use token if available, otherwise create a service token with user context
  if (authContext.token) {
    headers['authorization'] = `Bearer ${authContext.token}`;
  } else {
    // For session-based auth, we need to pass user context differently
    headers['x-authenticated-user-id'] = authContext.user.id;
    headers['x-authenticated-session-id'] = authContext.session_id;
  }
  
  // Add user context headers
  headers['x-user-id'] = authContext.user.id;
  headers['x-user-role'] = authContext.user.role;
  headers['x-request-id'] = c.get('requestId') || 'unknown';
  
  // Forward specific headers from the original request
  CONVEX_FORWARD_HEADERS.forEach(header => {
    const value = c.req.header(header);
    if (value) {
      headers[header] = value;
    }
  });
  
  return headers;
}