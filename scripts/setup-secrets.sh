#!/bin/bash

# Script to set up Wrangler secrets for local development
# Run this script once to configure all necessary secrets

echo "Setting up Wrangler secrets for in8-auth-gateway..."
echo "Make sure you have the .env file configured with all secrets."
echo ""

# Source the .env file
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "Error: .env file not found!"
    exit 1
fi

# Set secrets for development environment
echo "Setting secrets for development environment..."

echo "$JWT_SECRET" | npx wrangler secret put JWT_SECRET --env development
echo "$SESSION_SECRET" | npx wrangler secret put SESSION_SECRET --env development
echo "$BETTER_AUTH_SECRET" | npx wrangler secret put BETTER_AUTH_SECRET --env development
echo "$CONVEX_DEPLOY_KEY" | npx wrangler secret put CONVEX_DEPLOY_KEY --env development
echo "$GOOGLE_CLIENT_SECRET" | npx wrangler secret put GOOGLE_CLIENT_SECRET --env development

echo ""
echo "Secrets have been configured for the development environment."
echo "You can now run 'npm run dev' to start the server."