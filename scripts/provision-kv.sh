#!/bin/bash

# Script to provision a single Cloudflare KV namespace for all environments

echo "🚀 Provisioning Cloudflare KV Namespace for in8 Auth Gateway"
echo "==========================================================="
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

echo "📦 Creating single KV namespace for all environments..."
echo ""

# Create the main KV namespace
echo -n "Creating AUTH_STORE namespace... "
KV_OUTPUT=$(wrangler kv:namespace create "AUTH_STORE" 2>&1)
KV_ID=$(echo "$KV_OUTPUT" | grep -oE 'id = "[^"]*"' | sed 's/id = "//;s/"$//' | head -1)

if [ -n "$KV_ID" ]; then
    echo "✅ Created!"
    echo ""
    echo "KV Namespace ID: $KV_ID"
    
    # Create preview namespace for local development
    echo -n "Creating AUTH_STORE preview namespace... "
    PREVIEW_OUTPUT=$(wrangler kv:namespace create "AUTH_STORE" --preview 2>&1)
    PREVIEW_ID=$(echo "$PREVIEW_OUTPUT" | grep -oE 'id = "[^"]*"' | sed 's/id = "//;s/"$//' | head -1)
    
    if [ -n "$PREVIEW_ID" ]; then
        echo "✅ Created!"
        echo "Preview ID: $PREVIEW_ID"
    else
        echo "⚠️  May already exist"
    fi
    
    echo ""
    echo "==========================================================="
    echo ""
    echo "📝 Update your wrangler.toml with these IDs:"
    echo ""
    echo "[[kv_namespaces]]"
    echo "binding = \"AUTH_STORE\""
    echo "id = \"$KV_ID\""
    echo "preview_id = \"$PREVIEW_ID\""
    echo ""
else
    echo "⚠️  Namespace may already exist"
    echo ""
    echo "To view existing namespaces, run:"
    echo "wrangler kv:namespace list"
fi

echo ""
echo "==========================================================="
echo ""
echo "📋 Current KV Namespaces:"
wrangler kv:namespace list

echo ""
echo "✅ Done! Single KV namespace setup complete."
echo ""
echo "This KV namespace will be used for:"
echo "  • Session storage"
echo "  • Rate limiting"
echo "  • Auth caching"
echo "  • All environments (dev, staging, prod)"