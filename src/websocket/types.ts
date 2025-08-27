/**
 * WebSocket Proxy Types
 * Type definitions for WebSocket proxy implementation
 */

export interface WebSocketMessage {
  type: string;
  data?: any;
  id?: string;
  timestamp?: number;
}

export interface WebSocketConnectionConfig {
  userId: string;
  userRole: string;
  permissions: string[];
  sessionId: string;
  requestId: string;
}

export interface WebSocketConnectionState {
  isConnected: boolean;
  connectedAt: number;
  lastActivity: number;
  messageCount: number;
  errorCount: number;
}

export interface WebSocketProxyOptions {
  convexUrl: string;
  convexApiKey: string;
  maxMessageSize?: number;
  connectionTimeout?: number;
  heartbeatInterval?: number;
  maxReconnectAttempts?: number;
}

export interface WebSocketError {
  code: string;
  message: string;
  details?: string;
  timestamp: number;
}

export enum WebSocketEventType {
  OPEN = 'open',
  MESSAGE = 'message', 
  CLOSE = 'close',
  ERROR = 'error',
  HEARTBEAT = 'heartbeat'
}

export enum WebSocketCloseCode {
  NORMAL_CLOSURE = 1000,
  GOING_AWAY = 1001,
  PROTOCOL_ERROR = 1002,
  UNSUPPORTED_DATA = 1003,
  INVALID_FRAME_PAYLOAD_DATA = 1007,
  POLICY_VIOLATION = 1008,
  MESSAGE_TOO_BIG = 1009,
  INTERNAL_ERROR = 1011,
  SERVICE_RESTART = 1012,
  TRY_AGAIN_LATER = 1013,
  BAD_GATEWAY = 1014
}

export interface ConvexWebSocketMessage {
  type: 'subscribe' | 'unsubscribe' | 'mutation' | 'query' | 'action';
  id: string;
  payload: any;
  auth?: {
    userId: string;
    userRole: string;
    permissions: string[];
    sessionId: string;
  };
}

export interface WebSocketMetrics {
  connectionsTotal: number;
  messagesForwarded: number;
  errorsTotal: number;
  averageConnectionTime: number;
  lastError?: WebSocketError;
}