/**
 * Convex Protocol Handler
 * Implements Convex client-server protocol handling for binary data and sync operations
 * 
 * Key Convex endpoints and operations:
 * - /api/sync - WebSocket sync protocol for real-time updates
 * - /api/function - Function calls (queries, mutations, actions) 
 * - /api/version/sync - Versioned sync endpoint
 * - Binary protocol with Base64 encoding for timestamps and large integers
 */

import { Logger } from '@/middleware/logging';
// import { AuthContext } from '@/types/auth';

// Convex Protocol Types (based on official Convex client analysis)
export interface ConvexTimestamp {
  /** Base64-encoded 64-bit integer representing timestamp */
  readonly value: string;
}

export interface ConvexStateVersion {
  querySet: number;
  ts: ConvexTimestamp;
  identity: number;
}

export interface ConvexQueryId {
  readonly value: number;
}

// Client Message Types
export interface ConvexConnectMessage {
  type: 'Connect';
  sessionId: string;
  connectionCount: number;
  lastCloseReason: string | null;
  maxObservedTimestamp?: ConvexTimestamp;
}

export interface ConvexAddQuery {
  type: 'Add';
  queryId: number;
  udfPath: string;
  args: any[];
  journal?: string | null;
}

export interface ConvexRemoveQuery {
  type: 'Remove';
  queryId: number;
}

export interface ConvexQuerySetModification {
  type: 'ModifyQuerySet';
  baseVersion: number;
  newVersion: number;
  modifications: (ConvexAddQuery | ConvexRemoveQuery)[];
}

export interface ConvexMutationRequest {
  type: 'Mutation';
  requestId: number;
  udfPath: string;
  args: any[];
  componentPath?: string;
}

export interface ConvexActionRequest {
  type: 'Action';
  requestId: number;
  udfPath: string;
  args: any[];
  componentPath?: string;
}

export interface ConvexAuthenticateMessage {
  type: 'Authenticate';
  tokenType: 'Admin' | 'User' | 'None';
  value?: string;
  baseVersion: number;
  impersonating?: any;
}

export interface ConvexEventMessage {
  type: 'Event';
  eventType: string;
  event: any;
}

export type ConvexClientMessage = 
  | ConvexConnectMessage
  | ConvexAuthenticateMessage
  | ConvexQuerySetModification
  | ConvexMutationRequest
  | ConvexActionRequest
  | ConvexEventMessage;

// Server Message Types
export interface ConvexTransitionMessage {
  type: 'Transition';
  startVersion: ConvexStateVersion;
  endVersion: ConvexStateVersion;
  modifications: ConvexStateModification[];
}

export interface ConvexStateModification {
  type: 'QueryUpdated' | 'QueryFailed' | 'QueryRemoved';
  queryId: number;
  value?: any;
  errorMessage?: string;
  logLines: string[];
  journal?: string | null;
  errorData?: any;
}

export interface ConvexMutationResponse {
  type: 'MutationResponse';
  requestId: number;
  success: boolean;
  result: any;
  ts?: ConvexTimestamp;
  logLines: string[];
  errorData?: any;
}

export interface ConvexActionResponse {
  type: 'ActionResponse';
  requestId: number;
  success: boolean;
  result: any;
  logLines: string[];
  errorData?: any;
}

export interface ConvexAuthError {
  type: 'AuthError';
  error: string;
  baseVersion: number;
  authUpdateAttempted: boolean;
}

export interface ConvexFatalError {
  type: 'FatalError';
  error: string;
}

export interface ConvexPingMessage {
  type: 'Ping';
}

export type ConvexServerMessage =
  | ConvexTransitionMessage
  | ConvexMutationResponse
  | ConvexActionResponse
  | ConvexFatalError
  | ConvexAuthError
  | ConvexPingMessage;

export interface ConvexProtocolOptions {
  deploymentUrl: string;
  apiKey?: string;
  maxMessageSize?: number;
  syncEndpoint?: string;
  functionEndpoint?: string;
  version?: string;
}

export interface ConvexRequestContext {
  userId?: string;
  userRole?: string;
  permissions?: string[];
  sessionId?: string;
  requestId?: string;
  authToken?: string;
}

/**
 * Convex Protocol Handler
 * Handles binary protocol encoding/decoding and message proxying
 */
export class ConvexProtocolHandler {
  private options: ConvexProtocolOptions;
  private logger: Logger;
  
  // Convex uses specific version in WebSocket URL path
  private readonly API_VERSION = '1.25.4'; // Current Convex client version
  
  // Known Convex endpoints that need special handling
  public readonly CONVEX_ENDPOINTS = {
    SYNC: '/api/sync',
    SYNC_VERSIONED: `/api/${this.API_VERSION}/sync`,
    FUNCTION: '/api/function', 
    HTTP_FUNCTION: '/api/http_function',
    STREAMING: '/api/streaming_function',
    HEALTH: '/api/health',
    VERSION: '/api/version'
  };

  constructor(options: ConvexProtocolOptions, logger: Logger) {
    this.options = {
      version: this.API_VERSION,
      syncEndpoint: '/api/sync',
      functionEndpoint: '/api/function',
      maxMessageSize: 1024 * 1024, // 1MB
      ...options
    };
    this.logger = logger;
  }

  /**
   * Parse client message from WebSocket or HTTP request
   */
  parseClientMessage(data: string | ArrayBuffer | Uint8Array): ConvexClientMessage | null {
    try {
      const messageStr = this.dataToString(data);
      const parsed = JSON.parse(messageStr);
      
      // Validate basic structure
      if (!parsed || typeof parsed.type !== 'string') {
        throw new Error('Invalid message structure');
      }

      // Decode timestamps if present
      return this.decodeClientMessage(parsed);
    } catch (_error) {
      this.logger.error('Failed to parse Convex client message', {
        error: _error instanceof Error ? _error.message : String(_error),
        dataLength: typeof data === 'string' ? data.length : data.byteLength
      });
      return null;
    }
  }

  /**
   * Parse server message from Convex backend
   */
  parseServerMessage(data: string | ArrayBuffer | Uint8Array): ConvexServerMessage | null {
    try {
      const messageStr = this.dataToString(data);
      const parsed = JSON.parse(messageStr);
      
      if (!parsed || typeof parsed.type !== 'string') {
        throw new Error('Invalid server message structure');
      }

      return this.decodeServerMessage(parsed);
    } catch (_error) {
      this.logger.error('Failed to parse Convex server message', {
        error: _error instanceof Error ? _error.message : String(_error)
      });
      return null;
    }
  }

  /**
   * Encode client message for sending to Convex backend
   */
  encodeClientMessage(message: ConvexClientMessage, context: ConvexRequestContext): string {
    try {
      // Add authentication context
      const enrichedMessage = this.enrichClientMessage(message, context);
      
      // Encode timestamps and large integers
      const encoded = this.encodeForConvex(enrichedMessage);
      
      const result = JSON.stringify(encoded);
      
      // Validate message size
      if (result.length > (this.options.maxMessageSize || 1024 * 1024)) {
        throw new Error(`Message too large: ${result.length} bytes`);
      }
      
      return result;
    } catch (_error) {
      this.logger.error('Failed to encode client message', {
        messageType: message.type,
        error: _error instanceof Error ? _error.message : String(_error)
      });
      throw _error;
    }
  }

  /**
   * Encode server message for sending to client
   */
  encodeServerMessage(message: ConvexServerMessage): string {
    try {
      // Sanitize message for client (remove internal fields)
      const sanitized = this.sanitizeServerMessage(message);
      
      // Encode timestamps
      const encoded = this.encodeForClient(sanitized);
      
      return JSON.stringify(encoded);
    } catch (_error) {
      this.logger.error('Failed to encode server message', {
        messageType: message.type,
        error: _error instanceof Error ? _error.message : String(_error)
      });
      throw _error;
    }
  }

  /**
   * Check if request is for a Convex-specific endpoint
   */
  isConvexEndpoint(path: string): boolean {
    return Object.values(this.CONVEX_ENDPOINTS).some(endpoint => 
      path.startsWith(endpoint)
    );
  }

  /**
   * Get WebSocket URL for Convex sync
   */
  getSyncWebSocketUrl(): string {
    const url = new URL(this.options.deploymentUrl);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    // Convex uses the standard /api/sync endpoint for WebSocket connections
    // The versioned endpoint is for specific client compatibility
    return `${protocol}//${url.host}/api/sync`;
  }

  /**
   * Create HTTP function call URL
   */
  getFunctionUrl(functionPath: string): string {
    const cleanPath = functionPath.replace(/^\/+/, '');
    return `${this.options.deploymentUrl}${this.CONVEX_ENDPOINTS.FUNCTION}/${cleanPath}`;
  }

  /**
   * Process binary data from Convex protocol
   * Convex uses Base64 encoding for 64-bit integers and timestamps
   */
  private decodeBase64Timestamp(encoded: string): ConvexTimestamp {
    try {
      // Convex stores 64-bit timestamps as Base64
      const bytes = this.base64ToBytes(encoded);
      const _timestamp = this.bytesToLong(bytes);
      
      return { value: encoded };
    } catch (_error) {
      this.logger.warn('Failed to decode Base64 timestamp', { encoded });
      return { value: encoded }; // Return as-is if decode fails
    }
  }

  /**
   * Encode timestamp to Base64 for Convex
   */
  private encodeTimestampToBase64(timestamp: number): string {
    try {
      const bytes = this.longToBytes(timestamp);
      return this.bytesToBase64(bytes);
    } catch (_error) {
      this.logger.warn('Failed to encode timestamp to Base64', { timestamp });
      return String(timestamp);
    }
  }

  /**
   * Decode client message with timestamp conversion
   */
  private decodeClientMessage(parsed: any): ConvexClientMessage {
    const message = { ...parsed };
    
    // Handle Connect message with maxObservedTimestamp
    if (message.type === 'Connect' && message.maxObservedTimestamp) {
      message.maxObservedTimestamp = this.decodeBase64Timestamp(message.maxObservedTimestamp);
    }
    
    return message as ConvexClientMessage;
  }

  /**
   * Decode server message with timestamp conversion
   */
  private decodeServerMessage(parsed: any): ConvexServerMessage {
    const message = { ...parsed };
    
    // Handle different message types
    switch (message.type) {
      case 'Transition':
        if (message.startVersion?.ts) {
          message.startVersion.ts = this.decodeBase64Timestamp(message.startVersion.ts);
        }
        if (message.endVersion?.ts) {
          message.endVersion.ts = this.decodeBase64Timestamp(message.endVersion.ts);
        }
        break;
      
      case 'MutationResponse':
        if (message.success && message.ts) {
          message.ts = this.decodeBase64Timestamp(message.ts);
        }
        break;
    }
    
    return message as ConvexServerMessage;
  }

  /**
   * Encode message for Convex with proper timestamp format
   */
  private encodeForConvex(message: any): any {
    const encoded = { ...message };
    
    switch (encoded.type) {
      case 'Connect':
        if (encoded.maxObservedTimestamp?.value) {
          encoded.maxObservedTimestamp = encoded.maxObservedTimestamp.value;
        }
        break;
    }
    
    return encoded;
  }

  /**
   * Encode message for client with proper format
   */
  private encodeForClient(message: any): any {
    // Client expects the same format, just ensure proper encoding
    return message;
  }

  /**
   * Enrich client message with authentication context
   */
  private enrichClientMessage(message: ConvexClientMessage, context: ConvexRequestContext): any {
    const enriched = { ...message };
    
    // Add authentication for Convex backend if available
    if (context.authToken && message.type === 'Connect') {
      // Convex handles auth via separate Authenticate message
      return enriched;
    }
    
    return enriched;
  }

  /**
   * Sanitize server message for client (remove internal fields)
   */
  private sanitizeServerMessage(message: ConvexServerMessage): any {
    const sanitized = { ...message };
    
    // Remove any internal fields that shouldn't be sent to client
    if ('internal' in sanitized) {
      delete sanitized.internal;
    }
    
    return sanitized;
  }

  /**
   * Convert various data types to string
   */
  private dataToString(data: string | ArrayBuffer | Uint8Array): string {
    if (typeof data === 'string') {
      return data;
    }
    
    if (data instanceof ArrayBuffer) {
      return new TextDecoder().decode(data);
    }
    
    if (data instanceof Uint8Array) {
      return new TextDecoder().decode(data);
    }
    
    return String(data);
  }

  // Base64 utility methods (simplified - in production, use a proper library)
  private base64ToBytes(base64: string): Uint8Array {
    // For production, use a proper Base64 library
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  private bytesToBase64(bytes: Uint8Array): string {
    // For production, use a proper Base64 library
    let binaryString = '';
    for (let i = 0; i < bytes.length; i++) {
      binaryString += String.fromCharCode(bytes[i]);
    }
    return btoa(binaryString);
  }

  private bytesToLong(bytes: Uint8Array): number {
    // Convert little-endian bytes to number (simplified)
    let result = 0;
    for (let i = 0; i < Math.min(bytes.length, 8); i++) {
      result += bytes[i] * Math.pow(256, i);
    }
    return result;
  }

  private longToBytes(value: number): Uint8Array {
    // Convert number to little-endian bytes (simplified)
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      bytes[i] = (value >> (i * 8)) & 0xFF;
    }
    return bytes;
  }

  /**
   * Validate message structure
   */
  validateMessage(message: any): boolean {
    if (!message || typeof message !== 'object') {
      return false;
    }
    
    if (typeof message.type !== 'string') {
      return false;
    }
    
    // Add more specific validation based on message type
    return true;
  }

  /**
   * Get endpoint configuration for proxying
   */
  getEndpointConfig(path: string): { endpoint: string; requiresAuth: boolean; supportsBinary: boolean } {
    if (path.includes('/sync')) {
      return {
        endpoint: this.CONVEX_ENDPOINTS.SYNC_VERSIONED,
        requiresAuth: true,
        supportsBinary: true
      };
    }
    
    if (path.includes('/function')) {
      return {
        endpoint: this.CONVEX_ENDPOINTS.FUNCTION,
        requiresAuth: true,
        supportsBinary: false
      };
    }
    
    return {
      endpoint: path,
      requiresAuth: false,
      supportsBinary: false
    };
  }
}

/**
 * Factory function to create Convex protocol handler
 */
export function createConvexProtocolHandler(
  options: ConvexProtocolOptions,
  logger: Logger
): ConvexProtocolHandler {
  return new ConvexProtocolHandler(options, logger);
}