#!/bin/bash

# Script to set Cloudflare Worker secrets from .env file

set -e

echo "🔐 Setting Cloudflare Worker Secrets"
echo "===================================="
echo ""

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "❌ .env file not found!"
    echo "Please create a .env file with your secrets first."
    exit 1
fi

# Source the .env file
set -a
source .env
set +a

# Function to set a secret
set_secret() {
    local secret_name=$1
    local secret_value=$2
    
    if [ -n "$secret_value" ]; then
        echo "✅ Setting $secret_name"
        echo "$secret_value" | wrangler secret put "$secret_name" --name in8-auth-gateway --config config/wrangler.toml
    else
        echo "⚠️  Skipping $secret_name (not set in .env)"
    fi
}

echo "Setting core secrets..."
set_secret "JWT_SECRET" "$JWT_SECRET"
set_secret "SESSION_SECRET" "$SESSION_SECRET"
set_secret "BETTER_AUTH_SECRET" "$BETTER_AUTH_SECRET"
set_secret "CONVEX_DEPLOY_KEY" "$CONVEX_DEPLOY_KEY"
set_secret "CONVEX_API_KEY" "$CONVEX_API_KEY"

echo ""
echo "Setting OAuth secrets..."
set_secret "GOOGLE_CLIENT_SECRET" "$GOOGLE_CLIENT_SECRET"
set_secret "GITHUB_CLIENT_SECRET" "$GITHUB_CLIENT_SECRET"
set_secret "DISCORD_CLIENT_SECRET" "$DISCORD_CLIENT_SECRET"

echo ""
echo "✅ All secrets have been set!"
echo ""
echo "You can verify secrets with:"
echo "  wrangler secret list --name in8-auth-gateway --config config/wrangler.toml"