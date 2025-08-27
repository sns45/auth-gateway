#!/bin/bash

# Upload secrets from Doppler to Cloudflare Workers
# Usage: ./upload-secrets.sh [environment]

set -e

ENVIRONMENT=${1:-stg}

echo "Uploading secrets to Cloudflare Workers for environment: $ENVIRONMENT"

# Map environment names
if [ "$ENVIRONMENT" = "stg" ] || [ "$ENVIRONMENT" = "staging" ]; then
    DOPPLER_CONFIG="stg"
elif [ "$ENVIRONMENT" = "prd" ] || [ "$ENVIRONMENT" = "production" ]; then
    DOPPLER_CONFIG="prd"
else
    DOPPLER_CONFIG="dev"
fi

# Set up Doppler
export DOPPLER_PROJECT="auth"
export DOPPLER_CONFIG="${DOPPLER_CONFIG}"

# List of secrets to upload
SECRETS=(
    "JWT_SECRET"
    "SESSION_SECRET"
    "BETTER_AUTH_SECRET"
    "GOOGLE_CLIENT_SECRET"
    "CONVEX_DEPLOY_KEY"
)

# Upload each secret
for SECRET in "${SECRETS[@]}"; do
    echo "Uploading $SECRET..."
    VALUE=$(doppler secrets get $SECRET --plain 2>/dev/null || echo "")
    if [ -n "$VALUE" ]; then
        echo "$VALUE" | wrangler secret put $SECRET --config config/wrangler.toml
    else
        echo "Warning: $SECRET not found in Doppler"
    fi
done

echo "Secrets upload complete!"