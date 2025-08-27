#!/bin/bash

# Script to provision Cloudflare KV namespaces for all environments
# This creates the KV namespaces needed for sessions, rate limiting, and caching

echo "🚀 Provisioning Cloudflare KV Namespaces for in8 Auth Gateway"
echo "============================================================"
echo ""

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Error: wrangler CLI is not installed."
    echo "   Please run: npm install -g wrangler"
    exit 1
fi

# Check if user is logged in to Cloudflare
if ! wrangler whoami &> /dev/null; then
    echo "❌ Error: Not logged in to Cloudflare."
    echo "   Please run: wrangler login"
    exit 1
fi

echo "📦 Creating KV namespaces..."
echo ""

# Development namespaces
echo "🔧 Development Environment:"
echo -n "  Creating SESSIONS namespace... "
DEV_SESSIONS_ID=$(wrangler kv:namespace create "in8_auth_sessions_dev" --preview 2>&1 | grep -oE 'id = "[^"]*"' | sed 's/id = "//;s/"$//')
if [ -n "$DEV_SESSIONS_ID" ]; then
    echo "✅ Created with ID: $DEV_SESSIONS_ID"
else
    echo "⚠️  May already exist"
fi

echo -n "  Creating RATE_LIMITS namespace... "
DEV_RATELIMITS_ID=$(wrangler kv:namespace create "in8_auth_ratelimits_dev" --preview 2>&1 | grep -oE 'id = "[^"]*"' | sed 's/id = "//;s/"$//')
if [ -n "$DEV_RATELIMITS_ID" ]; then
    echo "✅ Created with ID: $DEV_RATELIMITS_ID"
else
    echo "⚠️  May already exist"
fi

echo -n "  Creating AUTH_CACHE namespace... "
DEV_CACHE_ID=$(wrangler kv:namespace create "in8_auth_cache_dev" --preview 2>&1 | grep -oE 'id = "[^"]*"' | sed 's/id = "//;s/"$//')
if [ -n "$DEV_CACHE_ID" ]; then
    echo "✅ Created with ID: $DEV_CACHE_ID"
else
    echo "⚠️  May already exist"
fi

echo ""

# Staging namespaces
echo "🚧 Staging Environment:"
echo -n "  Creating SESSIONS namespace... "
STAGING_SESSIONS_ID=$(wrangler kv:namespace create "in8_auth_sessions_staging" 2>&1 | grep -oE 'id = "[^"]*"' | sed 's/id = "//;s/"$//')
if [ -n "$STAGING_SESSIONS_ID" ]; then
    echo "✅ Created with ID: $STAGING_SESSIONS_ID"
else
    echo "⚠️  May already exist"
fi

echo -n "  Creating RATE_LIMITS namespace... "
STAGING_RATELIMITS_ID=$(wrangler kv:namespace create "in8_auth_ratelimits_staging" 2>&1 | grep -oE 'id = "[^"]*"' | sed 's/id = "//;s/"$//')
if [ -n "$STAGING_RATELIMITS_ID" ]; then
    echo "✅ Created with ID: $STAGING_RATELIMITS_ID"
else
    echo "⚠️  May already exist"
fi

echo -n "  Creating AUTH_CACHE namespace... "
STAGING_CACHE_ID=$(wrangler kv:namespace create "in8_auth_cache_staging" 2>&1 | grep -oE 'id = "[^"]*"' | sed 's/id = "//;s/"$//')
if [ -n "$STAGING_CACHE_ID" ]; then
    echo "✅ Created with ID: $STAGING_CACHE_ID"
else
    echo "⚠️  May already exist"
fi

echo ""

# Production namespaces
echo "🚀 Production Environment:"
echo -n "  Creating SESSIONS namespace... "
PROD_SESSIONS_ID=$(wrangler kv:namespace create "in8_auth_sessions_prod" 2>&1 | grep -oE 'id = "[^"]*"' | sed 's/id = "//;s/"$//')
if [ -n "$PROD_SESSIONS_ID" ]; then
    echo "✅ Created with ID: $PROD_SESSIONS_ID"
else
    echo "⚠️  May already exist"
fi

echo -n "  Creating RATE_LIMITS namespace... "
PROD_RATELIMITS_ID=$(wrangler kv:namespace create "in8_auth_ratelimits_prod" 2>&1 | grep -oE 'id = "[^"]*"' | sed 's/id = "//;s/"$//')
if [ -n "$PROD_RATELIMITS_ID" ]; then
    echo "✅ Created with ID: $PROD_RATELIMITS_ID"
else
    echo "⚠️  May already exist"
fi

echo -n "  Creating AUTH_CACHE namespace... "
PROD_CACHE_ID=$(wrangler kv:namespace create "in8_auth_cache_prod" 2>&1 | grep -oE 'id = "[^"]*"' | sed 's/id = "//;s/"$//')
if [ -n "$PROD_CACHE_ID" ]; then
    echo "✅ Created with ID: $PROD_CACHE_ID"
else
    echo "⚠️  May already exist"
fi

echo ""
echo "============================================================"
echo ""

# List all KV namespaces to verify
echo "📋 Current KV Namespaces:"
wrangler kv:namespace list

echo ""
echo "============================================================"
echo ""
echo "📝 IMPORTANT: Update your wrangler.toml with the actual KV namespace IDs"
echo ""
echo "The namespace IDs shown above should be added to your wrangler.toml file."
echo "Replace the placeholder IDs with the actual IDs created."
echo ""
echo "Example:"
echo "  [[kv_namespaces]]"
echo "  binding = \"SESSIONS\""
echo "  id = \"<actual-namespace-id>\""
echo ""
echo "✅ KV namespace provisioning complete!"