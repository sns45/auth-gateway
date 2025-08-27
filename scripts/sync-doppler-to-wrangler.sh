#!/bin/bash

# Sync secrets from Doppler to Wrangler
# This script is useful for deploying to Cloudflare Workers

echo "🔄 Syncing secrets from Doppler to Wrangler..."

# Check if Doppler is configured
if ! doppler configure get token > /dev/null 2>&1; then
    echo "❌ Error: Doppler is not configured. Run 'doppler setup' first."
    exit 1
fi

# Get current config
CONFIG=$(doppler configure get config)
echo "📋 Using Doppler config: $CONFIG"

# Define which secrets to sync
SECRETS_TO_SYNC=(
    "JWT_SECRET"
    "SESSION_SECRET"
    "BETTER_AUTH_SECRET"
    "CONVEX_DEPLOY_KEY"
    "GOOGLE_CLIENT_SECRET"
)

# Sync each secret
for SECRET in "${SECRETS_TO_SYNC[@]}"; do
    echo -n "  Syncing $SECRET... "
    VALUE=$(doppler secrets get $SECRET --plain 2>/dev/null)
    if [ $? -eq 0 ] && [ -n "$VALUE" ]; then
        echo "$VALUE" | wrangler secret put $SECRET --name in8-auth-gateway > /dev/null 2>&1
        if [ $? -eq 0 ]; then
            echo "✅"
        else
            echo "❌ Failed to set in Wrangler"
        fi
    else
        echo "⚠️  Not found in Doppler"
    fi
done

echo ""
echo "✅ Secret sync complete!"
echo ""
echo "📝 Note: You may need to deploy your worker for secrets to take effect:"
echo "   npm run deploy"