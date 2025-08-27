/**
 * WebSocket Proxy Integration Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketProxy } from '@/websocket/proxy';
import { WebSocketProxyOptions, WebSocketConnectionConfig } from '@/websocket/types';
import { Logger } from '@/middleware/logging';
import { AuthContext } from '@/types/auth';

// Mock WebSocket for testing
class MockWebSocket {
  static readonly READY_STATE_CONNECTING = 0;
  static readonly READY_STATE_OPEN = 1;
  static readonly READY_STATE_CLOSING = 2;
  static readonly READY_STATE_CLOSED = 3;

  public readyState = MockWebSocket.READY_STATE_CONNECTING;
  private listeners: { [key: string]: Function[] } = {};

  constructor(public url: string, public options?: any) {
    // Simulate connection establishment
    setTimeout(() => {
      this.readyState = MockWebSocket.READY_STATE_OPEN;
      this.dispatchEvent('open', {});
    }, 100);
  }

  addEventListener(event: string, callback: Function) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  removeEventListener(event: string, callback: Function) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
  }

  send(data: string) {
    // Simulate message sending
    console.log('MockWebSocket.send:', data);
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.READY_STATE_CLOSED;
    this.dispatchEvent('close', { code, reason });
  }

  private dispatchEvent(event: string, data: any) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => callback(data));
    }
  }

  // Simulate receiving a message
  simulateMessage(data: string) {
    this.dispatchEvent('message', { data });
  }
}

// Mock WebSocketPair for testing
class MockWebSocketPair {
  constructor() {
    return [new MockWebSocket('mock://client'), new MockWebSocket('mock://server')];
  }
}

// Mock global WebSocket and WebSocketPair
(globalThis as any).WebSocket = MockWebSocket;
(globalThis as any).WebSocketPair = MockWebSocketPair;

describe('WebSocket Proxy Integration Tests', () => {
  let mockLogger: Logger;
  let mockAuthContext: AuthContext;
  let proxyOptions: WebSocketProxyOptions;

  beforeAll(() => {
    // Mock logger
    mockLogger = {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: () => {},
      level: 'debug',
      requestId: 'test-request',
      parseLogLevel: () => 'debug' as any,
      log: () => {},
    } as unknown as Logger;

    // Mock auth context
    mockAuthContext = {
      user: {
        id: 'test-user-123',
        email: 'test@example.com',
        name: 'Test User',
        role: 'user',
        created_at: '2024-01-01T00:00:00Z',
        last_login: '2024-01-01T00:00:00Z'
      },
      session: {
        user_id: 'test-user-123',
        user_role: 'user',
        permissions: ['read', 'write'],
        ip_address: '127.0.0.1',
        user_agent: 'test',
        created_at: '2024-01-01T00:00:00Z',
        expires_at: '2024-01-02T00:00:00Z',
        last_activity: '2024-01-01T00:00:00Z'
      },
      session_id: 'test-session-123',
      permissions: ['read', 'write']
    };

    // Proxy options
    proxyOptions = {
      convexUrl: 'http://localhost:3000',
      convexApiKey: 'test-api-key',
      maxMessageSize: 1024 * 1024,
      connectionTimeout: 5000,
      heartbeatInterval: 10000
    };
  });

  afterAll(() => {
    // Cleanup
  });

  it('should handle WebSocket upgrade request successfully', async () => {
    // Mock request with proper WebSocket headers
    const mockRequest = new Request('http://localhost:8787/api/ws', {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'upgrade',
        'Sec-WebSocket-Key': 'test-key',
        'Sec-WebSocket-Version': '13'
      }
    });

    // Test WebSocket upgrade handling
    const response = await WebSocketProxy.handleUpgrade(
      mockRequest,
      mockAuthContext,
      proxyOptions,
      mockLogger
    );

    expect(response).toBeDefined();
    expect(response.status).toBe(101);
  });

  it('should reject non-WebSocket upgrade requests', async () => {
    // Mock regular HTTP request
    const mockRequest = new Request('http://localhost:8787/api/ws', {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const response = await WebSocketProxy.handleUpgrade(
      mockRequest,
      mockAuthContext,
      proxyOptions,
      mockLogger
    );

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toBe('Expected WebSocket upgrade');
  });

  it('should create WebSocket proxy with correct configuration', () => {
    const config: WebSocketConnectionConfig = {
      userId: mockAuthContext.user.id,
      userRole: mockAuthContext.user.role,
      permissions: mockAuthContext.permissions,
      sessionId: mockAuthContext.session_id,
      requestId: 'test-request-123'
    };

    const proxy = new (WebSocketProxy as any)(proxyOptions, config, mockLogger);

    expect(proxy).toBeDefined();
    expect(proxy.getConnectionState().isConnected).toBe(false);
    expect(proxy.getMetrics().connectionsTotal).toBe(0);
  });

  it('should handle message parsing correctly', () => {
    const config: WebSocketConnectionConfig = {
      userId: mockAuthContext.user.id,
      userRole: mockAuthContext.user.role,
      permissions: mockAuthContext.permissions,
      sessionId: mockAuthContext.session_id,
      requestId: 'test-request-123'
    };

    const proxy = new (WebSocketProxy as any)(proxyOptions, config, mockLogger);

    // Test valid JSON message
    const validMessage = JSON.stringify({
      type: 'subscribe',
      id: 'test-id',
      data: { query: 'messages' }
    });

    const parsed = proxy.parseMessage(validMessage);
    expect(parsed).toBeDefined();
    expect(parsed.type).toBe('subscribe');
    expect(parsed.id).toBe('test-id');

    // Test invalid JSON
    const parsed2 = proxy.parseMessage('invalid json');
    expect(parsed2).toBeNull();
  });

  it('should enrich messages with auth context for Convex', () => {
    const config: WebSocketConnectionConfig = {
      userId: mockAuthContext.user.id,
      userRole: mockAuthContext.user.role,
      permissions: mockAuthContext.permissions,
      sessionId: mockAuthContext.session_id,
      requestId: 'test-request-123'
    };

    const proxy = new (WebSocketProxy as any)(proxyOptions, config, mockLogger);

    const message = {
      type: 'subscribe',
      id: 'test-id',
      data: { query: 'messages' }
    };

    const enriched = proxy.enrichMessageForConvex(message);

    expect(enriched.auth).toBeDefined();
    expect(enriched.auth.userId).toBe(mockAuthContext.user.id);
    expect(enriched.auth.userRole).toBe(mockAuthContext.user.role);
    expect(enriched.auth.permissions).toEqual(mockAuthContext.permissions);
    expect(enriched.auth.sessionId).toBe(mockAuthContext.session_id);
  });

  it('should sanitize messages from Convex for client', () => {
    const config: WebSocketConnectionConfig = {
      userId: mockAuthContext.user.id,
      userRole: mockAuthContext.user.role,
      permissions: mockAuthContext.permissions,
      sessionId: mockAuthContext.session_id,
      requestId: 'test-request-123'
    };

    const proxy = new (WebSocketProxy as any)(proxyOptions, config, mockLogger);

    const message = {
      type: 'subscription_update',
      id: 'test-id',
      data: {
        results: ['message1', 'message2'],
        auth: { sensitive: 'data' },
        internal: { secret: 'value' }
      }
    };

    const sanitized = proxy.sanitizeMessageForClient(message);

    expect(sanitized.type).toBe('subscription_update');
    expect(sanitized.id).toBe('test-id');
    expect(sanitized.data.results).toEqual(['message1', 'message2']);
    expect(sanitized.data.auth).toBeUndefined();
    expect(sanitized.data.internal).toBeUndefined();
  });

  it('should track connection metrics', () => {
    const config: WebSocketConnectionConfig = {
      userId: mockAuthContext.user.id,
      userRole: mockAuthContext.user.role,
      permissions: mockAuthContext.permissions,
      sessionId: mockAuthContext.session_id,
      requestId: 'test-request-123'
    };

    const proxy = new (WebSocketProxy as any)(proxyOptions, config, mockLogger);

    const initialMetrics = proxy.getMetrics();
    expect(initialMetrics.connectionsTotal).toBe(0);
    expect(initialMetrics.messagesForwarded).toBe(0);
    expect(initialMetrics.errorsTotal).toBe(0);

    // Simulate activity
    proxy.updateActivity();
    const state = proxy.getConnectionState();
    expect(state.messageCount).toBe(1);
    expect(state.lastActivity).toBeGreaterThan(0);
  });

  it('should handle WebSocket errors gracefully', () => {
    const config: WebSocketConnectionConfig = {
      userId: mockAuthContext.user.id,
      userRole: mockAuthContext.user.role,
      permissions: mockAuthContext.permissions,
      sessionId: mockAuthContext.session_id,
      requestId: 'test-request-123'
    };

    const proxy = new (WebSocketProxy as any)(proxyOptions, config, mockLogger);
    const mockClient = new MockWebSocket('mock://client') as any;

    // Test error handling
    proxy.handleError(new Error('Test error'), mockClient);

    const metrics = proxy.getMetrics();
    expect(metrics.errorsTotal).toBe(1);
    expect(metrics.lastError).toBeDefined();
    expect(metrics.lastError.message).toBe('Test error');
  });
});