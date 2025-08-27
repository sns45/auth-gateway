#!/bin/bash

# Development server wrapper script
# This script loads secrets from Doppler and passes them to Wrangler

echo "🚀 Starting Auth Gateway Development Server"
echo "========================================"
echo ""

# Sync secrets from Doppler
echo "📥 Syncing secrets from Doppler..."
doppler secrets download --no-file --format env --project auth --config dev > .dev.vars

# Source the secrets
set -a
source .dev.vars
set +a

echo "✅ Secrets loaded"
echo ""

# Start wrangler with all the secrets as --var flags
echo "🔧 Starting Wrangler dev server..."
npx wrangler dev src/index.ts \
  --config config/wrangler.toml \
  --local \
  --var JWT_SECRET:"$JWT_SECRET" \
  --var SESSION_SECRET:"$SESSION_SECRET" \
  --var BETTER_AUTH_SECRET:"$BETTER_AUTH_SECRET" \
  --var CONVEX_API_KEY:"$CONVEX_API_KEY" \
  --var CONVEX_DEPLOY_KEY:"$CONVEX_DEPLOY_KEY" \
  --var GOOGLE_CLIENT_SECRET:"$GOOGLE_CLIENT_SECRET" \
  --var GITHUB_CLIENT_SECRET:"$GITHUB_CLIENT_SECRET" \
  --var DISCORD_CLIENT_SECRET:"$DISCORD_CLIENT_SECRET"