/**
 * Convex Protocol Handler Tests
 * Tests for binary protocol handling and message processing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConvexProtocolHandler, createConvexProtocolHandler } from '@/convex/protocol';
import { Logger } from '@/middleware/logging';

describe('ConvexProtocolHandler', () => {
  let protocolHandler: ConvexProtocolHandler;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      log: () => {},
      parseLogLevel: () => 'info' as const,
      requestId: 'test'
    } as any;

    protocolHandler = createConvexProtocolHandler({
      deploymentUrl: 'https://test.convex.cloud',
      apiKey: 'test-api-key'
    }, mockLogger);
  });

  describe('Endpoint Detection', () => {
    it('should identify Convex sync endpoints', () => {
      expect(protocolHandler.isConvexEndpoint('/api/sync')).toBe(true);
      expect(protocolHandler.isConvexEndpoint('/api/v1.0.0/sync')).toBe(true);
      expect(protocolHandler.isConvexEndpoint('/api/function/test')).toBe(true);
      expect(protocolHandler.isConvexEndpoint('/api/health')).toBe(true);
    });

    it('should reject non-Convex endpoints', () => {
      expect(protocolHandler.isConvexEndpoint('/api/auth')).toBe(false);
      expect(protocolHandler.isConvexEndpoint('/health')).toBe(false);
      expect(protocolHandler.isConvexEndpoint('/random/path')).toBe(false);
    });
  });

  describe('URL Generation', () => {
    it('should generate correct sync WebSocket URL', () => {
      const syncUrl = protocolHandler.getSyncWebSocketUrl();
      expect(syncUrl).toBe('wss://test.convex.cloud/api/v1.0.0/sync');
    });

    it('should generate correct function URL', () => {
      const functionUrl = protocolHandler.getFunctionUrl('myFunction');
      expect(functionUrl).toBe('https://test.convex.cloud/api/function/myFunction');
    });

    it('should handle function paths with leading slashes', () => {
      const functionUrl = protocolHandler.getFunctionUrl('/api/function/myFunction');
      expect(functionUrl).toBe('https://test.convex.cloud/api/function/api/function/myFunction');
    });
  });

  describe('Message Parsing', () => {
    it('should parse valid Connect message', () => {
      const connectMessage = {
        type: 'Connect',
        sessionId: 'test-session',
        connectionCount: 1,
        lastCloseReason: null
      };

      const parsed = protocolHandler.parseClientMessage(JSON.stringify(connectMessage));
      expect(parsed).toEqual(expect.objectContaining({
        type: 'Connect',
        sessionId: 'test-session',
        connectionCount: 1,
        lastCloseReason: null
      }));
    });

    it('should parse valid Mutation request', () => {
      const mutationMessage = {
        type: 'Mutation',
        requestId: 123,
        udfPath: 'myMutation',
        args: [{ name: 'test' }]
      };

      const parsed = protocolHandler.parseClientMessage(JSON.stringify(mutationMessage));
      expect(parsed).toEqual(expect.objectContaining({
        type: 'Mutation',
        requestId: 123,
        udfPath: 'myMutation',
        args: [{ name: 'test' }]
      }));
    });

    it('should handle invalid JSON', () => {
      const parsed = protocolHandler.parseClientMessage('invalid json');
      expect(parsed).toBeNull();
    });

    it('should handle messages without type', () => {
      const parsed = protocolHandler.parseClientMessage('{"data": "test"}');
      expect(parsed).toBeNull();
    });
  });

  describe('Message Encoding', () => {
    it('should encode Connect message with authentication context', () => {
      const connectMessage = {
        type: 'Connect' as const,
        sessionId: 'test-session',
        connectionCount: 1,
        lastCloseReason: null
      };

      const context = {
        userId: 'user-123',
        userRole: 'admin',
        permissions: ['read', 'write']
      };

      const encoded = protocolHandler.encodeClientMessage(connectMessage, context);
      const parsed = JSON.parse(encoded);
      
      expect(parsed).toEqual(expect.objectContaining({
        type: 'Connect',
        sessionId: 'test-session',
        connectionCount: 1,
        lastCloseReason: null
      }));
    });

    it('should handle message size limits', () => {
      const largeMessage = {
        type: 'Action' as const,
        requestId: 1,
        udfPath: 'test',
        args: [new Array(1000000).fill('x').join('')]
      };

      expect(() => {
        protocolHandler.encodeClientMessage(largeMessage, {});
      }).toThrow('Message too large');
    });
  });

  describe('Server Message Processing', () => {
    it('should parse Transition messages', () => {
      const transitionMessage = {
        type: 'Transition',
        startVersion: { querySet: 1, ts: 'dGVzdA==', identity: 1 },
        endVersion: { querySet: 2, ts: 'dGVzdDI=', identity: 1 },
        modifications: []
      };

      const parsed = protocolHandler.parseServerMessage(JSON.stringify(transitionMessage));
      expect(parsed).toEqual(expect.objectContaining({
        type: 'Transition'
      }));
    });

    it('should parse MutationResponse messages', () => {
      const responseMessage = {
        type: 'MutationResponse',
        requestId: 123,
        success: true,
        result: { data: 'test' },
        ts: 'dGVzdA==',
        logLines: []
      };

      const parsed = protocolHandler.parseServerMessage(JSON.stringify(responseMessage));
      expect(parsed).toEqual(expect.objectContaining({
        type: 'MutationResponse',
        requestId: 123,
        success: true
      }));
    });
  });

  describe('Endpoint Configuration', () => {
    it('should provide correct sync endpoint configuration', () => {
      const config = protocolHandler.getEndpointConfig('/api/sync');
      expect(config).toEqual({
        endpoint: '/api/v1.0.0/sync',
        requiresAuth: true,
        supportsBinary: true
      });
    });

    it('should provide correct function endpoint configuration', () => {
      const config = protocolHandler.getEndpointConfig('/api/function/test');
      expect(config).toEqual({
        endpoint: '/api/function',
        requiresAuth: true,
        supportsBinary: false
      });
    });

    it('should provide default configuration for unknown endpoints', () => {
      const config = protocolHandler.getEndpointConfig('/unknown/path');
      expect(config).toEqual({
        endpoint: '/unknown/path',
        requiresAuth: false,
        supportsBinary: false
      });
    });
  });

  describe('Message Validation', () => {
    it('should validate valid message structure', () => {
      const validMessage = {
        type: 'Connect',
        sessionId: 'test'
      };
      expect(protocolHandler.validateMessage(validMessage)).toBe(true);
    });

    it('should reject invalid message structures', () => {
      expect(protocolHandler.validateMessage(null)).toBe(false);
      expect(protocolHandler.validateMessage('string')).toBe(false);
      expect(protocolHandler.validateMessage({})).toBe(false);
      expect(protocolHandler.validateMessage({ data: 'test' })).toBe(false);
    });
  });

  describe('Binary Data Handling', () => {
    it('should handle ArrayBuffer message data', () => {
      const message = { type: 'Connect', sessionId: 'test' };
      const arrayBuffer = new TextEncoder().encode(JSON.stringify(message)).buffer;
      
      const parsed = protocolHandler.parseClientMessage(arrayBuffer);
      expect(parsed).toEqual(expect.objectContaining({
        type: 'Connect',
        sessionId: 'test'
      }));
    });

    it('should handle Uint8Array message data', () => {
      const message = { type: 'Connect', sessionId: 'test' };
      const uint8Array = new TextEncoder().encode(JSON.stringify(message));
      
      const parsed = protocolHandler.parseClientMessage(uint8Array);
      expect(parsed).toEqual(expect.objectContaining({
        type: 'Connect',
        sessionId: 'test'
      }));
    });
  });
});