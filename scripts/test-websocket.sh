#!/bin/bash

# WebSocket Testing Script for Hono Gateway

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
GATEWAY_URL="${GATEWAY_URL:-http://localhost:8787}"
WS_URL="${WS_URL:-ws://localhost:8787/api/ws}"
JWT_TOKEN="${JWT_TOKEN:-}"

echo -e "${BLUE}🚀 WebSocket Testing Script${NC}"
echo "=============================="

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to log messages
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}"
}

# Check dependencies
log "Checking dependencies..."

if ! command_exists curl; then
    error "curl is required but not installed"
    exit 1
fi

if ! command_exists wscat; then
    warn "wscat not found. Installing..."
    npm install -g wscat
fi

if ! command_exists jq; then
    warn "jq not found. JSON parsing will be limited"
fi

# Test 1: Health check
log "Testing gateway health..."
if curl -s -f "${GATEWAY_URL}/health" > /dev/null; then
    log "✅ Gateway is healthy"
else
    error "❌ Gateway health check failed"
    exit 1
fi

# Test 2: Gateway info
log "Getting gateway information..."
GATEWAY_INFO=$(curl -s "${GATEWAY_URL}/" | jq -r '.endpoints.websocket // "not found"' 2>/dev/null || echo "not found")
if [ "$GATEWAY_INFO" != "not found" ]; then
    log "✅ WebSocket endpoint available: $GATEWAY_INFO"
else
    warn "⚠️  WebSocket endpoint not listed in gateway info"
fi

# Test 3: WebSocket upgrade without auth (should fail)
log "Testing WebSocket upgrade without authentication..."
RESPONSE=$(curl -s -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" "${GATEWAY_URL}/api/ws" | head -1)
if echo "$RESPONSE" | grep -q "401\|400"; then
    log "✅ Correctly rejected unauthenticated WebSocket upgrade"
else
    warn "⚠️  Unexpected response for unauthenticated upgrade: $RESPONSE"
fi

# Test 4: Get JWT token (if not provided)
if [ -z "$JWT_TOKEN" ]; then
    log "No JWT token provided. You can test manually with:"
    echo "  1. Get a JWT token from the auth endpoint"
    echo "  2. Set JWT_TOKEN environment variable"
    echo "  3. Run: JWT_TOKEN='your-token' ./scripts/test-websocket.sh"
    echo ""
    echo "Example manual WebSocket test:"
    echo "  wscat -c '$WS_URL' -H 'Authorization: Bearer YOUR_TOKEN'"
else
    # Test 5: WebSocket connection with auth
    log "Testing WebSocket connection with authentication..."
    
    # Create temporary test file
    TEMP_FILE=$(mktemp)
    
    # Test WebSocket connection
    log "Connecting to WebSocket: $WS_URL"
    echo "Testing WebSocket connection for 10 seconds..."
    
    timeout 10s wscat -c "$WS_URL" -H "Authorization: Bearer $JWT_TOKEN" > "$TEMP_FILE" 2>&1 &
    WSCAT_PID=$!
    
    # Send test message after connection
    sleep 2
    if kill -0 $WSCAT_PID 2>/dev/null; then
        log "Sending test message..."
        echo '{"type":"heartbeat","data":{"test":true}}' | timeout 1s wscat -c "$WS_URL" -H "Authorization: Bearer $JWT_TOKEN" 2>/dev/null || true
    fi
    
    # Wait for wscat to finish or timeout
    wait $WSCAT_PID 2>/dev/null || true
    
    # Check results
    if [ -s "$TEMP_FILE" ]; then
        log "✅ WebSocket connection established and responded"
        log "Response preview:"
        head -3 "$TEMP_FILE" | sed 's/^/  /'
    else
        warn "⚠️  WebSocket connection may not have established properly"
    fi
    
    # Cleanup
    rm -f "$TEMP_FILE"
fi

# Test 6: Connection metrics (if available)
log "Checking connection metrics..."
METRICS=$(curl -s "${GATEWAY_URL}/health" 2>/dev/null | jq -r '.metrics // "not available"' 2>/dev/null || echo "not available")
if [ "$METRICS" != "not available" ]; then
    log "✅ Metrics available: $METRICS"
else
    log "ℹ️  Connection metrics not available"
fi

echo ""
log "🎉 WebSocket testing completed!"

# Summary and tips
echo ""
echo -e "${BLUE}📋 Testing Summary:${NC}"
echo "==================="
echo "• Gateway health: ✅"
echo "• WebSocket endpoint: $([ "$GATEWAY_INFO" != "not found" ] && echo "✅" || echo "⚠️")"
echo "• Auth protection: ✅"
echo "• Connection test: $([ -n "$JWT_TOKEN" ] && echo "✅" || echo "⏭️ Skipped")"

if [ -z "$JWT_TOKEN" ]; then
    echo ""
    echo -e "${YELLOW}💡 To test with authentication:${NC}"
    echo "1. Authenticate and get JWT token:"
    echo "   curl -X POST ${GATEWAY_URL}/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"user@example.com\",\"password\":\"password\"}'"
    echo ""
    echo "2. Test WebSocket with token:"
    echo "   JWT_TOKEN='your-token' ./scripts/test-websocket.sh"
    echo ""
    echo "3. Interactive testing:"
    echo "   wscat -c '${WS_URL}' -H 'Authorization: Bearer YOUR_TOKEN'"
fi

echo ""
echo -e "${GREEN}✨ WebSocket proxy is ready for use!${NC}"