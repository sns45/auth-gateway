#!/bin/bash
# Deploy auth gateway with Doppler environment variables

# Exit on error
set -e

# Check if environment is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <environment>"
    echo "Example: $0 stg"
    exit 1
fi

ENV=$1

echo "Deploying auth gateway to environment: $ENV"

# Get environment variables from Doppler
OAUTH_BASE_URL=$(doppler secrets get OAUTH_BASE_URL --plain --config $ENV 2>/dev/null || echo "")
FRONTEND_URL=$(doppler secrets get FRONTEND_URL --plain --config $ENV 2>/dev/null || echo "")
ALLOWED_ORIGINS=$(doppler secrets get ALLOWED_ORIGINS --plain --config $ENV 2>/dev/null || echo "")
NODE_ENV=$(doppler secrets get NODE_ENV --plain --config $ENV 2>/dev/null || echo "")
GOOGLE_CLIENT_ID=$(doppler secrets get GOOGLE_CLIENT_ID --plain --config $ENV 2>/dev/null || echo "")

# Build the wrangler command with environment variables
WRANGLER_CMD="wrangler deploy src/index.ts --config config/wrangler.toml"

# Add environment variables if they exist
if [ -n "$NODE_ENV" ]; then
    WRANGLER_CMD="$WRANGLER_CMD --var NODE_ENV:$NODE_ENV"
fi

if [ -n "$OAUTH_BASE_URL" ]; then
    WRANGLER_CMD="$WRANGLER_CMD --var OAUTH_BASE_URL:$OAUTH_BASE_URL"
fi

if [ -n "$FRONTEND_URL" ]; then
    WRANGLER_CMD="$WRANGLER_CMD --var FRONTEND_URL:$FRONTEND_URL"
fi

if [ -n "$ALLOWED_ORIGINS" ]; then
    WRANGLER_CMD="$WRANGLER_CMD --var ALLOWED_ORIGINS:\"$ALLOWED_ORIGINS\""
fi

if [ -n "$GOOGLE_CLIENT_ID" ]; then
    WRANGLER_CMD="$WRANGLER_CMD --var GOOGLE_CLIENT_ID:$GOOGLE_CLIENT_ID"
fi

echo "Deploying with command:"
echo "$WRANGLER_CMD"

# First sync secrets from Doppler to Wrangler
echo "Syncing secrets from Doppler to Wrangler..."
./scripts/sync-doppler-to-wrangler.sh

# Deploy using Doppler to inject secrets
doppler run --config $ENV -- bash -c "$WRANGLER_CMD"