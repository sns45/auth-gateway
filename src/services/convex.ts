import { UserProfile, CloudflareEnv } from '@/types/auth';
import { CONVEX_FORWARD_HEADERS } from '@/types/api';
import { ConvexProtocolHandler, createConvexProtocolHandler, ConvexRequestContext } from '@/convex/protocol';
import { Logger } from '@/middleware/logging';

/**
 * Convex API Client Service
 * Handles communication with the Convex backend
 */
export class ConvexService {
  private apiUrl: string;
  private apiKey: string;
  private syncSecret?: string;
  private protocolHandler: ConvexProtocolHandler;
  private logger: Logger;

  constructor(env: CloudflareEnv, logger: Logger) {
    this.apiUrl = env.CONVEX_URL;
    this.apiKey = env.CONVEX_DEPLOY_KEY;
    this.syncSecret = env.CONVEX_SYNC_SECRET;
    this.logger = logger;

    // Initialize Convex protocol handler
    this.protocolHandler = createConvexProtocolHandler({
      deploymentUrl: this.apiUrl,
      apiKey: this.apiKey
    }, logger);
  }

  /**
   * Headers for Convex HTTP actions. The X-Sync-Key proves the request comes
   * from the gateway; the Convex side rejects writes without it.
   */
  private convexSyncHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.syncSecret) {
      headers['X-Sync-Key'] = this.syncSecret;
    }
    return headers;
  }

  /**
   * Authenticate user with Convex backend
   */
  async authenticateUser(email: string, password: string): Promise<UserProfile | null> {
    try {
      // For now, we don't support email/password auth since we're using OAuth
      // This method is kept for compatibility but will always return null
      this.logger.warn('Email/password authentication not implemented - use OAuth instead');
      return null;
    } catch (error) {
      console.error('Convex authentication error:', error);
      throw new Error('Authentication service unavailable');
    }
  }

  /**
   * Get user profile by ID
   */
  async getUserProfile(userId: string): Promise<UserProfile | null> {
    try {
      const convexSiteUrl = this.apiUrl.replace('convex.cloud', 'convex.site');
      const response = await fetch(`${convexSiteUrl}/api/users/get-by-id`, {
        method: 'POST',
        headers: this.convexSyncHeaders(),
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Failed to get user profile: ${response.statusText}`);
      }

      const result = await response.json() as any;
      
      // Check for HTTP endpoint errors
      if (!result.success) {
        this.logger.error('Get user profile failed', {
          error: result.error,
          userId
        });
        if (result.error?.includes('not found')) {
          return null;
        }
        throw new Error(result.error || 'Failed to get user profile');
      }
      
      return result.user as UserProfile;
    } catch (error) {
      console.error('Convex get user profile error:', error);
      throw new Error('User service unavailable');
    }
  }

  /**
   * Update user last login timestamp
   */
  async updateLastLogin(userId: string): Promise<boolean> {
    try {
      const convexSiteUrl = this.apiUrl.replace('convex.cloud', 'convex.site');
      const response = await fetch(`${convexSiteUrl}/api/users/update-last-login`, {
        method: 'POST',
        headers: this.convexSyncHeaders(),
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        return false;
      }
      
      const result = await response.json() as any;
      return result.success === true;
    } catch (error) {
      console.error('Convex update last login error:', error);
      return false;
    }
  }

  /**
   * Get user permissions
   */
  async getUserPermissions(userId: string, role: string): Promise<string[]> {
    try {
      const convexSiteUrl = this.apiUrl.replace('convex.cloud', 'convex.site');
      const response = await fetch(`${convexSiteUrl}/api/users/get-permissions`, {
        method: 'POST',
        headers: this.convexSyncHeaders(),
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        console.warn('Failed to get user permissions, using role defaults');
        return this.getDefaultPermissions(role);
      }

      const result = await response.json() as any;
      
      if (!result.success) {
        console.warn('Get permissions failed, using role defaults:', result.error);
        return this.getDefaultPermissions(role);
      }
      
      return result.permissions || this.getDefaultPermissions(role);
    } catch (error) {
      console.error('Convex get permissions error:', error);
      return this.getDefaultPermissions(role);
    }
  }

  /**
   * Handle Convex protocol-specific requests
   */
  async handleConvexProtocolRequest(
    path: string,
    method: string,
    headers: Record<string, string>,
    body?: string | ArrayBuffer | Uint8Array,
    userId?: string,
    userRole?: string,
    permissions?: string[],
    sessionId?: string,
    requestId?: string
  ): Promise<Response> {
    try {
      const context: ConvexRequestContext = {
        userId,
        userRole,
        permissions,
        sessionId,
        requestId,
        authToken: headers['authorization']?.replace('Bearer ', '')
      };

      // Check if this is a Convex-specific endpoint
      if (!this.protocolHandler.isConvexEndpoint(path)) {
        return this.proxyRequest(path, method, headers, typeof body === 'string' ? body : undefined, userId, userRole, permissions, sessionId, requestId);
      }

      // Handle different Convex endpoints
      const _endpointConfig = this.protocolHandler.getEndpointConfig(path);
      
      if (path.includes('/sync')) {
        // Handle sync protocol (WebSocket upgrade should be handled elsewhere)
        return new Response('Sync endpoint requires WebSocket upgrade', { 
          status: 400,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      if (path.includes('/function')) {
        return this.handleFunctionCall(path, method, headers, body, context);
      }

      // Default to regular proxy for other endpoints
      return this.proxyRequest(path, method, headers, typeof body === 'string' ? body : undefined, userId, userRole, permissions, sessionId, requestId);
    } catch (error) {
      this.logger.error('Convex protocol request error:', {
        error: error instanceof Error ? error.message : String(error),
        path,
        method,
        requestId
      });
      
      return new Response(JSON.stringify({ 
        error: 'Convex protocol error',
        message: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Handle Convex function calls with protocol processing
   */
  private async handleFunctionCall(
    path: string,
    method: string,
    headers: Record<string, string>,
    body?: string | ArrayBuffer | Uint8Array,
    context?: ConvexRequestContext
  ): Promise<Response> {
    try {
      // Parse request body if present
      let processedBody = body;
      
      if (body && (body instanceof ArrayBuffer || body instanceof Uint8Array)) {
        // Handle binary data - Convex typically uses JSON but may have binary optimization
        const textBody = new TextDecoder().decode(body);
        try {
          const _parsed = JSON.parse(textBody);
          processedBody = textBody;
        } catch {
          // Not JSON, treat as raw binary
          processedBody = body;
        }
      }

      // Prepare headers for Convex
      const convexHeaders = this.prepareHeaders(headers, {
        userId: context?.userId,
        userRole: context?.userRole,
        permissions: context?.permissions,
        sessionId: context?.sessionId,
        requestId: context?.requestId
      });

      // Make request to Convex function endpoint
      const convexUrl = this.protocolHandler.getFunctionUrl(path.replace('/api/function/', ''));
      
      const response = await fetch(convexUrl, {
        method,
        headers: convexHeaders,
        body: processedBody as any
      });

      // Process response - handle potential binary data
      const responseHeaders = new Headers();
      
      // Copy safe headers
      const safeHeaders = [
        'content-type',
        'content-length',
        'cache-control',
        'x-request-id'
      ];

      safeHeaders.forEach(header => {
        const value = response.headers.get(header);
        if (value) {
          responseHeaders.set(header, value);
        }
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });

    } catch (error) {
      this.logger.error('Convex function call error:', {
        error: error instanceof Error ? error.message : String(error),
        path
      });
      
      throw error;
    }
  }

  /**
   * Process WebSocket message for Convex sync protocol
   */
  async processWebSocketMessage(
    message: string | ArrayBuffer | Uint8Array,
    context: ConvexRequestContext
  ): Promise<string | ArrayBuffer | null> {
    try {
      // Parse client message
      const clientMessage = this.protocolHandler.parseClientMessage(message);
      if (!clientMessage) {
        this.logger.warn('Failed to parse client message for Convex protocol');
        return null;
      }

      // Encode message for Convex backend
      const encodedMessage = this.protocolHandler.encodeClientMessage(clientMessage, context);
      
      this.logger.debug('Processed WebSocket message for Convex', {
        messageType: clientMessage.type,
        requestId: context.requestId
      });

      return encodedMessage;
    } catch (error) {
      this.logger.error('WebSocket message processing error:', {
        error: error instanceof Error ? error.message : String(error),
        requestId: context.requestId
      });
      return null;
    }
  }

  /**
   * Process WebSocket response from Convex backend
   */
  async processWebSocketResponse(
    message: string | ArrayBuffer | Uint8Array
  ): Promise<string | ArrayBuffer | null> {
    try {
      // Parse server message
      const serverMessage = this.protocolHandler.parseServerMessage(message);
      if (!serverMessage) {
        this.logger.warn('Failed to parse server message from Convex');
        return null;
      }

      // Encode message for client
      const encodedMessage = this.protocolHandler.encodeServerMessage(serverMessage);
      
      this.logger.debug('Processed WebSocket response from Convex', {
        messageType: serverMessage.type
      });

      return encodedMessage;
    } catch (error) {
      this.logger.error('WebSocket response processing error:', {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Get Convex sync WebSocket URL
   */
  getConvexSyncUrl(): string {
    return this.protocolHandler.getSyncWebSocketUrl();
  }

  /**
   * Check if path requires Convex protocol handling
   */
  requiresProtocolHandling(path: string): boolean {
    return this.protocolHandler.isConvexEndpoint(path);
  }

  /**
   * Proxy request to Convex with authentication context
   */
  async proxyRequest(
    path: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    userId?: string,
    userRole?: string,
    permissions?: string[],
    sessionId?: string,
    requestId?: string
  ): Promise<Response> {
    try {
      // Clean and prepare headers
      const cleanHeaders = this.prepareHeaders(headers, {
        userId,
        userRole,
        permissions,
        sessionId,
        requestId,
      });

      // Remove leading slash and /api prefix if present
      const cleanPath = path.replace(/^\/?(api\/)?/, '');
      const url = `${this.apiUrl}/${cleanPath}`;

      const response = await fetch(url, {
        method,
        headers: cleanHeaders,
        body: body || undefined,
      });

      // Create response with filtered headers
      const filteredHeaders = new Headers();
      
      // Copy safe headers from Convex response
      const safeHeaders = [
        'content-type',
        'content-length',
        'cache-control',
        'expires',
        'last-modified',
        'etag',
        'x-request-id',
        'x-response-time',
      ];

      safeHeaders.forEach(header => {
        const value = response.headers.get(header);
        if (value) {
          filteredHeaders.set(header, value);
        }
      });

      // Add security headers
      filteredHeaders.set('X-Content-Type-Options', 'nosniff');
      filteredHeaders.set('X-Frame-Options', 'DENY');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: filteredHeaders,
      });
    } catch (error) {
      console.error('Convex proxy error:', error);
      throw new Error('Backend service unavailable');
    }
  }

  /**
   * Check Convex service health
   * Note: Convex doesn't have a standard /health endpoint, 
   * so we test basic connectivity instead
   */
  async checkHealth(): Promise<boolean> {
    try {
      // Test basic connectivity without authentication
      // Convex will return an error about missing function, but that's expected
      const response = await fetch(`${this.apiUrl}/api/query`, {
        method: 'POST',
        headers: this.convexSyncHeaders(),
        body: JSON.stringify({
          path: 'system:health',
          args: {},
          format: 'json'
        })
      });

      // Accept any response that shows Convex is reachable
      // 200 = success, 400 = bad request, 500 = server error (function not found)
      return response.status === 200 || response.status === 400 || response.status === 500;
    } catch (error) {
      console.error('Convex health check error:', error);
      return false;
    }
  }

  /**
   * Handle OAuth user creation/update
   */
  async handleOAuthUser(
    provider: string,
    oauthUserId: string,
    email: string,
    name: string,
    avatarUrl?: string
  ): Promise<UserProfile> {
    try {
      // Call Convex HTTP endpoint for OAuth user handling
      // This uses the HTTP action we created since direct mutation calls require different auth
      const convexSiteUrl = this.apiUrl.replace('convex.cloud', 'convex.site');
      const response = await fetch(`${convexSiteUrl}/api/auth/oauth-user`, {
        method: 'POST',
        headers: this.convexSyncHeaders(),
        body: JSON.stringify({
          provider,
          oauthUserId,
          email,
          name,
          avatarUrl,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('Convex OAuth mutation failed', {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
          provider,
          email
        });
        throw new Error(`OAuth user handling failed: ${response.statusText}`);
      }

      const result = await response.json() as any;
      
      // Check for HTTP endpoint errors
      if (!result.success) {
        this.logger.error('Convex HTTP endpoint returned error', {
          error: result.error,
          provider,
          email
        });
        throw new Error(result.error || 'OAuth user creation failed');
      }
      
      // Extract user from HTTP response
      const user = result.user;
      if (!user) {
        throw new Error('No user returned from Convex');
      }

      return user as UserProfile;
    } catch (error) {
      this.logger.error('Convex OAuth user error:', {
        error: error instanceof Error ? error.message : String(error),
        provider,
        email
      });
      throw new Error('OAuth user service unavailable');
    }
  }

  /**
   * Prepare headers for Convex request
   */
  private prepareHeaders(
    originalHeaders: Record<string, string>,
    authContext: {
      userId?: string;
      userRole?: string;
      permissions?: string[];
      sessionId?: string;
      requestId?: string;
    }
  ): Record<string, string> {
    const headers: Record<string, string> = {};

    // Copy allowed headers
    CONVEX_FORWARD_HEADERS.forEach(header => {
      const value = originalHeaders[header.toLowerCase()];
      if (value) {
        headers[header] = value;
      }
    });

    // Add authentication context headers
    if (authContext.userId) {
      headers['X-User-ID'] = authContext.userId;
    }
    if (authContext.userRole) {
      headers['X-User-Role'] = authContext.userRole;
    }
    if (authContext.permissions) {
      headers['X-User-Permissions'] = authContext.permissions.join(',');
    }
    if (authContext.sessionId) {
      headers['X-Session-ID'] = authContext.sessionId;
    }
    if (authContext.requestId) {
      headers['X-Request-ID'] = authContext.requestId;
    }

    // Add internal service authorization
    headers['Authorization'] = `Bearer ${this.apiKey}`;

    // Ensure content-type for POST/PUT requests
    if (!headers['Content-Type'] && originalHeaders['content-type']) {
      headers['Content-Type'] = originalHeaders['content-type'];
    }

    return headers;
  }

  /**
   * Create WebSocket connection to Convex backend
   * Uses the correct Convex WebSocket sync endpoint
   */
  async createWebSocketConnection(
    userId: string,
    userRole: string,
    permissions: string[],
    sessionId: string,
    requestId: string
  ): Promise<WebSocket> {
    try {
      // Use the Convex sync WebSocket URL - Convex typically uses /api/sync for WebSocket
      const wsUrl = this.protocolHandler.getSyncWebSocketUrl();
      
      this.logger.debug('Creating Convex WebSocket connection', {
        wsUrl,
        userId,
        requestId
      });
      
      const webSocket = new WebSocket(wsUrl);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
        }, 30000); // 30 second timeout

        webSocket.addEventListener('open', () => {
          clearTimeout(timeout);
          this.logger.debug('Convex WebSocket connection established', { requestId });
          resolve(webSocket);
        });

        webSocket.addEventListener('error', (event) => {
          clearTimeout(timeout);
          this.logger.error('Convex WebSocket connection error', { event, requestId });
          reject(new Error('Failed to connect to Convex WebSocket'));
        });
      });
    } catch (error) {
      this.logger.error('Convex WebSocket creation error', { error, requestId });
      throw new Error('WebSocket service unavailable');
    }
  }

  /**
   * Check if WebSocket endpoint is available
   * Test by attempting to create a WebSocket connection
   */
  async checkWebSocketHealth(): Promise<boolean> {
    try {
      const wsUrl = this.protocolHandler.getSyncWebSocketUrl();
      
      // Create a test WebSocket connection
      const testWs = new WebSocket(wsUrl);
      
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          testWs.close();
          resolve(false);
        }, 5000); // 5 second timeout for health check
        
        testWs.addEventListener('open', () => {
          clearTimeout(timeout);
          testWs.close();
          resolve(true);
        });
        
        testWs.addEventListener('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });
      });
    } catch (error) {
      this.logger.error('Convex WebSocket health check error', { error });
      return false;
    }
  }

  /**
   * Get default permissions based on role
   */
  private getDefaultPermissions(role: string): string[] {
    switch (role) {
      case 'admin':
        return ['read', 'write', 'delete', 'admin'];
      case 'user':
        return ['read', 'write'];
      case 'guest':
        return ['read'];
      default:
        return ['read'];
    }
  }
}