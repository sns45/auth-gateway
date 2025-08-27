#!/bin/bash

# Single Worker Provisioning Script for Cloudflare
# This provisions one worker that handles all environments

set -e

echo "🚀 Cloudflare Worker Provisioning"
echo "================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo -e "${RED}❌ Wrangler CLI not found. Please install it first:${NC}"
    echo "   npm install -g wrangler"
    exit 1
fi

# Check if logged in
echo -e "${BLUE}📋 Checking Cloudflare authentication...${NC}"
if ! wrangler whoami &> /dev/null; then
    echo -e "${YELLOW}⚠️  Not logged in to Cloudflare. Running wrangler login...${NC}"
    wrangler login
fi

echo -e "${GREEN}✅ Authenticated with Cloudflare${NC}"
echo ""

# Function to set secrets
set_secret() {
    local secret_name=$1
    local env_var=$2
    local description=$3
    
    echo -e "${BLUE}🔐 Setting secret: ${secret_name}${NC}"
    echo "   ${description}"
    
    if [ -z "${!env_var}" ]; then
        echo -e "${YELLOW}   ⚠️  ${env_var} not found in environment${NC}"
        echo "   Please enter value for ${secret_name}:"
        read -s secret_value
        echo ""
    else
        secret_value="${!env_var}"
        echo -e "${GREEN}   ✓ Using value from ${env_var}${NC}"
    fi
    
    echo "$secret_value" | wrangler secret put "$secret_name" --name in8-auth-gateway --config config/wrangler.toml
}

# Deploy the worker
echo -e "${BLUE}📦 Deploying worker...${NC}"
echo ""

# Build the project first
echo -e "${BLUE}🔨 Building project...${NC}"
npm run build

# Deploy to Cloudflare (single deployment)
echo -e "${BLUE}🚀 Deploying to Cloudflare Workers...${NC}"
wrangler deploy src/index.ts --config config/wrangler.toml

echo ""
echo -e "${BLUE}🔐 Setting up secrets...${NC}"
echo ""

# Set secrets from environment or prompt
set_secret "JWT_SECRET" "JWT_SECRET" "JWT signing secret (32+ chars)"
set_secret "SESSION_SECRET" "SESSION_SECRET" "Session encryption secret (32+ chars)"
set_secret "BETTER_AUTH_SECRET" "BETTER_AUTH_SECRET" "Better Auth secret key"
set_secret "CONVEX_DEPLOY_KEY" "CONVEX_DEPLOY_KEY" "Convex deployment key"
set_secret "CONVEX_API_KEY" "CONVEX_API_KEY" "Convex API key"
set_secret "GOOGLE_CLIENT_SECRET" "GOOGLE_CLIENT_SECRET" "Google OAuth client secret"
set_secret "GITHUB_CLIENT_SECRET" "GITHUB_CLIENT_SECRET" "GitHub OAuth client secret (optional)"
set_secret "DISCORD_CLIENT_SECRET" "DISCORD_CLIENT_SECRET" "Discord OAuth client secret (optional)"

echo ""
echo -e "${GREEN}✅ Worker provisioning complete!${NC}"
echo ""
echo -e "${BLUE}📋 Summary:${NC}"
echo "   Worker Name: in8-auth-gateway"
echo "   KV Namespace: AUTH_STORE (already provisioned)"
echo "   Routes:"
echo "     - https://auth.example.com (production)"
echo "     - https://auth-staging.example.com (staging)"
echo "     - http://localhost:8787 (development)"
echo ""
echo -e "${BLUE}🔍 Next steps:${NC}"
echo "   1. Configure DNS records for auth.example.com and auth-staging.example.com"
echo "   2. Update your applications to use the gateway URLs"
echo "   3. Monitor the worker dashboard at https://dash.cloudflare.com"
echo ""
echo -e "${YELLOW}⚠️  Important:${NC}"
echo "   - The worker automatically detects environment from hostname"
echo "   - All environments share the same KV namespace with prefixes"
echo "   - Secrets are shared across all environments"
echo ""