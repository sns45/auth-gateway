/**
 * WebSocket Proxy Implementation for Hono Gateway
 * Handles WebSocket connections and proxying to Convex backend
 */

import { Logger } from '@/middleware/logging';
import { AuthContext } from '@/types/auth';
import { ConvexService } from '@/services/convex';
import { ConvexRequestContext } from '@/convex/protocol';
import {
  WebSocketMessage,
  WebSocketConnectionConfig,
  WebSocketConnectionState,
  WebSocketProxyOptions,
  WebSocketError,
  // WebSocketEventType,
  WebSocketCloseCode,
  ConvexWebSocketMessage,
  WebSocketMetrics
} from './types';

export class WebSocketProxy {
  private options: WebSocketProxyOptions;
  private logger: Logger;
  private metrics: WebSocketMetrics;
  private connectionState: WebSocketConnectionState;
  private config: WebSocketConnectionConfig;
  private convexService?: ConvexService;

  constructor(
    options: WebSocketProxyOptions,
    config: WebSocketConnectionConfig,
    logger: Logger,
    convexService?: ConvexService
  ) {
    this.options = {
      maxMessageSize: 1024 * 1024, // 1MB default
      connectionTimeout: 30000, // 30 seconds
      heartbeatInterval: 30000, // 30 seconds
      maxReconnectAttempts: 5,
      ...options
    };
    
    this.config = config;
    this.logger = logger;
    this.convexService = convexService;
    
    this.connectionState = {
      isConnected: false,
      connectedAt: 0,
      lastActivity: Date.now(),
      messageCount: 0,
      errorCount: 0
    };
    
    this.metrics = {
      connectionsTotal: 0,
      messagesForwarded: 0,
      errorsTotal: 0,
      averageConnectionTime: 0
    };
  }

  /**
   * Handle WebSocket upgrade request
   */
  static async handleUpgrade(
    request: Request,
    authContext: AuthContext,
    options: WebSocketProxyOptions,
    logger: Logger,
    convexService?: ConvexService
  ): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    const connectionHeader = request.headers.get('Connection');
    
    if (upgradeHeader?.toLowerCase() !== 'websocket' || 
        !connectionHeader?.toLowerCase().includes('upgrade')) {
      return new Response('Expected WebSocket upgrade', { status: 400 });
    }

    const config: WebSocketConnectionConfig = {
      userId: authContext.user.id,
      userRole: authContext.user.role,
      permissions: authContext.permissions,
      sessionId: authContext.session_id,
      requestId: crypto.randomUUID()
    };

    try {
      // Create WebSocket pair for Cloudflare Workers
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      // Accept the WebSocket connection immediately
      server.accept();
      
      const proxy = new WebSocketProxy(options, config, logger, convexService);
      
      // Handle connection in the background (don't await)
      proxy.handleConnection(server, client).catch(error => {
        logger.error('WebSocket proxy error', {
          error: error instanceof Error ? error.message : String(error),
          userId: config.userId,
          requestId: config.requestId
        });
        server.close(1011, 'Internal error');
      });

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    } catch (error) {
      logger.error('WebSocket upgrade failed', {
        error: error instanceof Error ? error.message : String(error),
        userId: config.userId,
        requestId: config.requestId
      });
      
      return new Response('WebSocket upgrade failed', { status: 500 });
    }
  }

  /**
   * Handle WebSocket connection
   */
  private async handleConnection(server: WebSocket, _client: WebSocket): Promise<void> {
    this.connectionState.isConnected = true;
    this.connectionState.connectedAt = Date.now();
    this.metrics.connectionsTotal++;

    this.logger.info('WebSocket connection established', {
      userId: this.config.userId,
      requestId: this.config.requestId,
      userRole: this.config.userRole
    });

    // Create connection to Convex WebSocket endpoint
    let convexWebSocket: WebSocket | null = null;
    
    try {
      convexWebSocket = await this.createConvexConnection();
      
      // Set up message forwarding
      this.setupClientToConvexForwarding(server, convexWebSocket);
      this.setupConvexToClientForwarding(convexWebSocket, server);
      
      // Set up connection lifecycle handlers
      this.setupConnectionHandlers(server, convexWebSocket);
      
      // Start heartbeat
      this.startHeartbeat(server, convexWebSocket);
      
    } catch (error) {
      this.handleError(error as Error, server);
      if (convexWebSocket) {
        convexWebSocket.close(WebSocketCloseCode.INTERNAL_ERROR, 'Backend connection failed');
      }
    }
  }

  /**
   * Create WebSocket connection to Convex backend
   */
  private async createConvexConnection(): Promise<WebSocket> {
    // Use Convex protocol handler if available for proper sync URL
    const convexWsUrl = this.convexService?.getConvexSyncUrl() || 
      this.options.convexUrl.replace(/^http/, 'ws') + '/api/sync';
    
    this.logger.debug('Creating Convex WebSocket connection', {
      convexWsUrl,
      requestId: this.config.requestId
    });
    
    const convexWebSocket = new WebSocket(convexWsUrl);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        convexWebSocket.close();
        reject(new Error('Convex WebSocket connection timeout'));
      }, this.options.connectionTimeout);

      convexWebSocket.addEventListener('open', () => {
        clearTimeout(timeout);
        this.logger.debug('Connected to Convex WebSocket', {
          requestId: this.config.requestId
        });
        resolve(convexWebSocket);
      });

      convexWebSocket.addEventListener('error', (event) => {
        clearTimeout(timeout);
        this.logger.error('Convex WebSocket connection error', {
          error: event,
          requestId: this.config.requestId,
          convexWsUrl
        });
        reject(new Error(`Failed to connect to Convex WebSocket at ${convexWsUrl}`));
      });
    });
  }

  /**
   * Set up message forwarding from client to Convex
   */
  private setupClientToConvexForwarding(client: WebSocket, convex: WebSocket): void {
    client.addEventListener('message', async (event) => {
      try {
        this.updateActivity();
        
        let messageToSend: string | ArrayBuffer;
        
        // Use Convex protocol handler if available
        if (this.convexService) {
          const context: ConvexRequestContext = {
            userId: this.config.userId,
            userRole: this.config.userRole,
            permissions: this.config.permissions,
            sessionId: this.config.sessionId,
            requestId: this.config.requestId
          };
          
          const processed = await this.convexService.processWebSocketMessage(event.data, context);
          if (!processed) {
            this.logger.warn('Failed to process WebSocket message with Convex protocol');
            return;
          }
          messageToSend = processed;
        } else {
          // Fallback to original message handling
          const message = this.parseMessage(event.data);
          if (!message) return;

          const convexMessage = this.enrichMessageForConvex(message);
          messageToSend = JSON.stringify(convexMessage);
        }
        
        // Validate message size
        const messageSize = typeof messageToSend === 'string' ? 
          messageToSend.length : messageToSend.byteLength;
          
        if (messageSize > (this.options.maxMessageSize || 1024 * 1024)) {
          throw new Error('Message too large');
        }

        // Forward to Convex
        if (convex.readyState === WebSocket.READY_STATE_OPEN) {
          convex.send(messageToSend);
          this.metrics.messagesForwarded++;
          
          this.logger.debug('Message forwarded to Convex', {
            messageSize,
            requestId: this.config.requestId
          });
        } else {
          throw new Error('Convex connection not available');
        }

      } catch (error) {
        this.handleError(error as Error, client);
      }
    });
  }

  /**
   * Set up message forwarding from Convex to client
   */
  private setupConvexToClientForwarding(convex: WebSocket, client: WebSocket): void {
    convex.addEventListener('message', async (event) => {
      try {
        this.updateActivity();
        
        let messageToSend: string | ArrayBuffer;
        
        // Use Convex protocol handler if available
        if (this.convexService) {
          const processed = await this.convexService.processWebSocketResponse(event.data);
          if (!processed) {
            this.logger.warn('Failed to process WebSocket response from Convex');
            return;
          }
          messageToSend = processed;
        } else {
          // Fallback to original message handling
          const message = this.parseMessage(event.data);
          if (!message) return;

          const clientMessage = this.sanitizeMessageForClient(message);
          messageToSend = JSON.stringify(clientMessage);
        }
        
        // Forward to client
        if (client.readyState === WebSocket.READY_STATE_OPEN) {
          client.send(messageToSend);
          this.metrics.messagesForwarded++;
          
          this.logger.debug('Message forwarded to client', {
            messageSize: typeof messageToSend === 'string' ? 
              messageToSend.length : messageToSend.byteLength,
            requestId: this.config.requestId
          });
        }

      } catch (error) {
        this.handleError(error as Error, client);
      }
    });
  }

  /**
   * Set up connection lifecycle handlers
   */
  private setupConnectionHandlers(client: WebSocket, convex: WebSocket): void {
    // Client close handler
    client.addEventListener('close', (event) => {
      this.logger.info('Client WebSocket closed', {
        code: event.code,
        reason: event.reason,
        requestId: this.config.requestId
      });
      
      this.connectionState.isConnected = false;
      if (convex.readyState === WebSocket.READY_STATE_OPEN) {
        convex.close(WebSocketCloseCode.NORMAL_CLOSURE, 'Client disconnected');
      }
    });

    // Convex close handler
    convex.addEventListener('close', (event) => {
      this.logger.info('Convex WebSocket closed', {
        code: event.code,
        reason: event.reason,
        requestId: this.config.requestId
      });
      
      if (client.readyState === WebSocket.READY_STATE_OPEN) {
        client.close(WebSocketCloseCode.BAD_GATEWAY, 'Backend disconnected');
      }
    });

    // Error handlers
    client.addEventListener('error', (event) => {
      this.logger.error('Client WebSocket error', {
        error: event,
        requestId: this.config.requestId
      });
    });

    convex.addEventListener('error', (event) => {
      this.logger.error('Convex WebSocket error', {
        error: event,
        requestId: this.config.requestId
      });
    });
  }

  /**
   * Start heartbeat mechanism
   */
  private startHeartbeat(client: WebSocket, _convex: WebSocket): void {
    const heartbeatInterval = setInterval(() => {
      try {
        if (client.readyState === WebSocket.READY_STATE_OPEN) {
          const heartbeat: WebSocketMessage = {
            type: 'heartbeat',
            timestamp: Date.now(),
            id: crypto.randomUUID()
          };
          client.send(JSON.stringify(heartbeat));
        } else {
          clearInterval(heartbeatInterval);
        }
      } catch (error) {
        this.logger.error('Heartbeat error', {
          error: error instanceof Error ? error.message : String(error),
          requestId: this.config.requestId
        });
        clearInterval(heartbeatInterval);
      }
    }, this.options.heartbeatInterval);

    // Clear heartbeat when connection closes
    client.addEventListener('close', () => {
      clearInterval(heartbeatInterval);
    });
  }

  /**
   * Parse WebSocket message
   */
  private parseMessage(data: string | Buffer | ArrayBuffer): WebSocketMessage | null {
    try {
      const messageStr = typeof data === 'string' ? data : new TextDecoder().decode(data);
      const parsed = JSON.parse(messageStr);
      
      // Validate message structure
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
        return {
          id: parsed.id || crypto.randomUUID(),
          timestamp: parsed.timestamp || Date.now(),
          ...parsed
        };
      }
      
      return null;
    } catch (error) {
      this.logger.error('Failed to parse WebSocket message', {
        error: error instanceof Error ? error.message : String(error),
        requestId: this.config.requestId
      });
      return null;
    }
  }

  /**
   * Enrich message with authentication context for Convex
   */
  private enrichMessageForConvex(message: WebSocketMessage): ConvexWebSocketMessage {
    return {
      type: message.type as any,
      id: message.id || crypto.randomUUID(),
      payload: message.data || message,
      auth: {
        userId: this.config.userId,
        userRole: this.config.userRole,
        permissions: this.config.permissions,
        sessionId: this.config.sessionId
      }
    };
  }

  /**
   * Sanitize message from Convex for client
   */
  private sanitizeMessageForClient(message: WebSocketMessage): WebSocketMessage {
    // Remove sensitive information and ensure safe data
    const sanitized: WebSocketMessage = {
      type: message.type,
      id: message.id,
      timestamp: message.timestamp,
      data: message.data
    };

    // Remove any auth context that shouldn't be sent to client
    if (sanitized.data && typeof sanitized.data === 'object') {
      delete sanitized.data.auth;
      delete sanitized.data.internal;
    }

    return sanitized;
  }

  /**
   * Update connection activity timestamp
   */
  private updateActivity(): void {
    this.connectionState.lastActivity = Date.now();
    this.connectionState.messageCount++;
  }

  /**
   * Handle WebSocket errors
   */
  private handleError(error: Error, client: WebSocket): void {
    this.connectionState.errorCount++;
    this.metrics.errorsTotal++;
    
    const wsError: WebSocketError = {
      code: 'WEBSOCKET_ERROR',
      message: error.message,
      details: error.stack,
      timestamp: Date.now()
    };
    
    this.metrics.lastError = wsError;
    
    this.logger.error('WebSocket proxy error', {
      error: wsError,
      requestId: this.config.requestId,
      userId: this.config.userId
    });

    // Send error message to client if connection is still open
    if (client.readyState === WebSocket.READY_STATE_OPEN) {
      try {
        const errorMessage: WebSocketMessage = {
          type: 'error',
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          data: {
            code: wsError.code,
            message: 'WebSocket proxy error occurred'
          }
        };
        client.send(JSON.stringify(errorMessage));
      } catch (sendError) {
        this.logger.error('Failed to send error message to client', {
          error: sendError instanceof Error ? sendError.message : String(sendError),
          requestId: this.config.requestId
        });
      }
    }
  }

  /**
   * Get connection metrics
   */
  public getMetrics(): WebSocketMetrics {
    return { ...this.metrics };
  }

  /**
   * Get connection state
   */
  public getConnectionState(): WebSocketConnectionState {
    return { ...this.connectionState };
  }
}