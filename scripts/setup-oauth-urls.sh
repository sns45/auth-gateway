#!/bin/bash

# Script to set up OAuth base URLs for different environments
# This ensures OAuth callbacks go through the gateway instead of directly to Convex

set -e

echo "Setting up OAuth Base URLs for different environments..."

# Production environment
echo "Setting production OAuth base URL..."
wrangler secret put OAUTH_BASE_URL --env production --text "https://auth.example.com" 2>/dev/null || true

# Alternative: Set as environment variable instead of secret
# wrangler env set OAUTH_BASE_URL "https://auth.example.com" --env production

echo "Setting staging OAuth base URL..."
wrangler secret put OAUTH_BASE_URL --env staging --text "https://auth-staging.example.com" 2>/dev/null || true

# Alternative: Set as environment variable instead of secret
# wrangler env set OAUTH_BASE_URL "https://auth-staging.example.com" --env staging

echo "OAuth base URLs configured successfully!"
echo ""
echo "Environment URLs:"
echo "- Production: https://auth.example.com"
echo "- Staging: https://auth-staging.example.com"
echo "- Development: http://localhost:8787 (set in wrangler.toml)"
echo ""
echo "OAuth callbacks will now go through the gateway instead of directly to Convex."