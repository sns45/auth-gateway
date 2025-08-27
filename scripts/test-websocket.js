#!/usr/bin/env node

/**
 * WebSocket Connection Test Script
 * Tests WebSocket connectivity to the auth gateway
 */

const WebSocket = require('ws');

async function testWebSocketConnection() {
  console.log('🧪 Testing WebSocket Connection to Auth Gateway');
  console.log('================================================');

  // Test configuration
  const gatewayUrl = 'ws://localhost:8787';
  const endpoints = [
    '/api/ws',
    '/api/1.25.4/sync',
    '/api/sync'
  ];

  for (const endpoint of endpoints) {
    const wsUrl = `${gatewayUrl}${endpoint}`;
    console.log(`\n📡 Testing endpoint: ${wsUrl}`);
    
    try {
      await testEndpoint(wsUrl);
    } catch (error) {
      console.log(`❌ Failed: ${error.message}`);
    }
  }
}

function testEndpoint(wsUrl) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws?.close();
      reject(new Error('Connection timeout (5s)'));
    }, 5000);

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': 'Bearer test-token',
        'Origin': 'http://localhost:3000'
      }
    });

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log('✅ Connection established');
      ws.close();
      resolve();
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${error.message}`));
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      console.log(`🔌 Connection closed: ${code} - ${reason || 'No reason'}`);
    });

    ws.on('message', (data) => {
      console.log(`📨 Received: ${data.toString()}`);
    });
  });
}

// Run the test
if (require.main === module) {
  testWebSocketConnection()
    .then(() => {
      console.log('\n🎉 WebSocket connection tests completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Test suite failed:', error.message);
      process.exit(1);
    });
}

module.exports = { testWebSocketConnection };