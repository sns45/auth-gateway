#!/bin/bash

# Doppler Setup Script for Auth Service
# This script sets up secrets in Doppler for all environments

set -e

echo "🔐 Doppler Secrets Setup for Auth Service"
echo "========================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo -e "${RED}❌ .env file not found!${NC}"
    echo "Please create a .env file with your secrets first."
    echo "You can use .env.template as a starting point:"
    echo "  cp .env.template .env"
    exit 1
fi

# Source the .env file
set -a
source .env
set +a

# Function to set secrets for an environment
set_environment_secrets() {
    local env=$1
    local env_name=$2
    
    echo -e "\n${BLUE}📋 Setting secrets for ${env_name} environment${NC}"
    echo "================================================"
    
    # Core secrets (same for all environments)
    echo -e "${YELLOW}Setting core secrets...${NC}"
    
    # JWT and Session secrets
    doppler secrets set JWT_SECRET="$JWT_SECRET" --project auth --config "$env" --silent
    echo "✅ JWT_SECRET"
    
    doppler secrets set SESSION_SECRET="$SESSION_SECRET" --project auth --config "$env" --silent
    echo "✅ SESSION_SECRET"
    
    doppler secrets set BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" --project auth --config "$env" --silent
    echo "✅ BETTER_AUTH_SECRET"
    
    # Convex secrets
    echo -e "\n${YELLOW}Setting Convex secrets...${NC}"
    
    doppler secrets set CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY" --project auth --config "$env" --silent
    echo "✅ CONVEX_DEPLOY_KEY"
    
    doppler secrets set CONVEX_API_KEY="$CONVEX_API_KEY" --project auth --config "$env" --silent
    echo "✅ CONVEX_API_KEY"
    
    # OAuth secrets
    echo -e "\n${YELLOW}Setting OAuth secrets...${NC}"
    
    doppler secrets set GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" --project auth --config "$env" --silent
    echo "✅ GOOGLE_CLIENT_ID"
    
    doppler secrets set GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" --project auth --config "$env" --silent
    echo "✅ GOOGLE_CLIENT_SECRET"
    
    if [ -n "$GITHUB_CLIENT_ID" ]; then
        doppler secrets set GITHUB_CLIENT_ID="$GITHUB_CLIENT_ID" --project auth --config "$env" --silent
        echo "✅ GITHUB_CLIENT_ID"
    fi
    
    if [ -n "$GITHUB_CLIENT_SECRET" ]; then
        doppler secrets set GITHUB_CLIENT_SECRET="$GITHUB_CLIENT_SECRET" --project auth --config "$env" --silent
        echo "✅ GITHUB_CLIENT_SECRET"
    fi
    
    if [ -n "$DISCORD_CLIENT_ID" ]; then
        doppler secrets set DISCORD_CLIENT_ID="$DISCORD_CLIENT_ID" --project auth --config "$env" --silent
        echo "✅ DISCORD_CLIENT_ID"
    fi
    
    if [ -n "$DISCORD_CLIENT_SECRET" ]; then
        doppler secrets set DISCORD_CLIENT_SECRET="$DISCORD_CLIENT_SECRET" --project auth --config "$env" --silent
        echo "✅ DISCORD_CLIENT_SECRET"
    fi
    
    # Cloudflare secrets
    echo -e "\n${YELLOW}Setting Cloudflare secrets...${NC}"
    
    if [ -n "$CLOUDFLARE_API_TOKEN" ]; then
        doppler secrets set CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" --project auth --config "$env" --silent
        echo "✅ CLOUDFLARE_API_TOKEN"
    fi
    
    if [ -n "$CLOUDFLARE_ACCOUNT_ID" ]; then
        doppler secrets set CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" --project auth --config "$env" --silent
        echo "✅ CLOUDFLARE_ACCOUNT_ID"
    fi
    
    # Environment-specific variables
    echo -e "\n${YELLOW}Setting environment-specific variables...${NC}"
    
    case "$env" in
        "dev")
            doppler secrets set NODE_ENV="development" --project auth --config "$env" --silent
            doppler secrets set CONVEX_URL="https://rosy-007.convex.cloud" --project auth --config "$env" --silent
            doppler secrets set CONVEX_SITE_URL="https://rosy-007.convex.site" --project auth --config "$env" --silent
            doppler secrets set ALLOWED_ORIGINS="http://localhost:3000,http://localhost:3001,http://localhost:5173,http://localhost:8787" --project auth --config "$env" --silent
            doppler secrets set LOG_LEVEL="debug" --project auth --config "$env" --silent
            ;;
        "stg")
            doppler secrets set NODE_ENV="staging" --project auth --config "$env" --silent
            doppler secrets set CONVEX_URL="https://rosy-007.convex.cloud" --project auth --config "$env" --silent
            doppler secrets set CONVEX_SITE_URL="https://rosy-007.convex.site" --project auth --config "$env" --silent
            doppler secrets set ALLOWED_ORIGINS="https://staging.example.com,https://auth-staging.example.com" --project auth --config "$env" --silent
            doppler secrets set LOG_LEVEL="info" --project auth --config "$env" --silent
            ;;
        "prd")
            doppler secrets set NODE_ENV="production" --project auth --config "$env" --silent
            doppler secrets set CONVEX_URL="https://rosy-007.convex.cloud" --project auth --config "$env" --silent
            doppler secrets set CONVEX_SITE_URL="https://rosy-007.convex.site" --project auth --config "$env" --silent
            doppler secrets set ALLOWED_ORIGINS="https://example.com,https://auth.example.com" --project auth --config "$env" --silent
            doppler secrets set LOG_LEVEL="warn" --project auth --config "$env" --silent
            ;;
    esac
    
    echo "✅ Environment variables"
    
    echo -e "\n${GREEN}✅ All secrets set for ${env_name}!${NC}"
}

# Main execution
echo -e "${BLUE}🔍 Checking Doppler authentication...${NC}"
if ! doppler me &> /dev/null; then
    echo -e "${RED}❌ Not authenticated with Doppler!${NC}"
    echo "Please run: doppler login"
    exit 1
fi

echo -e "${GREEN}✅ Authenticated with Doppler${NC}"

# Set up all environments
set_environment_secrets "dev" "Development"
set_environment_secrets "stg" "Staging"
set_environment_secrets "prd" "Production"

echo -e "\n${GREEN}✅ All environments configured!${NC}"
echo ""
echo -e "${BLUE}📋 Next steps:${NC}"
echo "1. Verify secrets: doppler secrets --project auth --config dev"
echo "2. Test locally: npm run dev"
echo "3. Deploy via GitLab CI/CD pipeline"
echo ""
echo -e "${YELLOW}⚠️  Important:${NC}"
echo "- Make sure DOPPLER_TOKEN is set in GitLab CI/CD variables"
echo "- Use 'doppler run' to inject secrets when running locally"
echo "- Never commit the .env file to version control"
echo ""

# Show summary
echo -e "${BLUE}📊 Configuration Summary:${NC}"
echo "Project: auth"
echo "Environments: dev, stg, prd"
echo ""
doppler configs --project auth