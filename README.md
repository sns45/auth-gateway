# Authentication Gateway

A lightweight authentication gateway service built with Hono.js on Cloudflare Workers, providing OAuth authentication, session management, and secure API proxying for modern web applications.

## Overview

This auth gateway serves as a central authentication service, handling:
- Google OAuth authentication
- Session management with Cloudflare KV storage
- Secure cookie-based authentication
- API proxying with authentication headers
- Real-time session synchronization via Convex

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono.js
- **Session Storage**: Cloudflare KV (with Convex fallback)
- **Database**: Convex (real-time backend)
- **OAuth Provider**: Google
- **Language**: TypeScript

## Features

### 🔐 Authentication
- Google OAuth 2.0 authentication flow
- JWT token generation with secure HTTP-only cookies
- Session management with automatic expiration
- Rate-limited authentication endpoints

### 🍪 Cookie Architecture
- `auth_session`: HTTP-only secure cookie for server validation
- `auth_session_id`: Non-HTTP-only cookie for JavaScript access
- Cross-subdomain cookie support
- SameSite=Lax for OAuth compatibility

### 🚀 Performance Optimizations
- KV write rate limiting (5-minute update intervals)
- Convex fallback for KV limit exceeded scenarios
- Efficient session validation with caching
- Minimal latency through edge deployment

### 🛡️ Security
- CORS configuration for multi-domain support
- Rate limiting on all endpoints
- Encrypted session data in KV storage
- OAuth state parameter for CSRF protection
- Comprehensive security headers

## Project Structure

```
auth/
├── src/
│   ├── index.ts              # Main Cloudflare Worker entry
│   ├── routes/
│   │   ├── auth.ts          # Authentication endpoints
│   │   ├── health.ts        # Health check endpoints
│   │   └── proxy.ts         # API proxy endpoints
│   ├── services/
│   │   ├── session.ts       # Session management with KV
│   │   ├── convex.ts        # Convex backend integration
│   │   └── oauth.ts         # Google OAuth implementation
│   ├── middleware/
│   │   ├── auth.ts          # Authentication middleware
│   │   ├── cors.ts          # CORS configuration
│   │   ├── rate-limit.ts    # Rate limiting
│   │   ├── security.ts      # Security headers
│   │   └── logging.ts       # Structured logging
│   ├── utils/
│   │   ├── jwt.ts           # JWT utilities
│   │   ├── crypto.ts        # Encryption utilities
│   │   └── validation.ts    # Request validation
│   └── types/               # TypeScript definitions
├── config/
│   └── wrangler.toml        # Cloudflare Workers config
├── scripts/                 # Deployment and utility scripts
├── tests/                   # Test suites
└── docs/                    # Documentation
```

## API Endpoints

### Authentication

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/signin/google` | GET | Initiate Google OAuth flow |
| `/api/auth/callback/google` | GET | OAuth callback handler |
| `/api/auth/logout` | POST | Logout and clear session |
| `/api/auth/session` | GET | Get current session info |
| `/api/auth/me` | GET | Get authenticated user |
| `/api/auth/refresh` | POST | Refresh access token |

### Health Checks

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Basic health check |
| `/` | GET | API info and status |

### Proxy

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/proxy/*` | ANY | Proxy authenticated requests to backend services |

## Environment Variables

```env
# Required - Authentication
JWT_SECRET=your-jwt-secret-here
SESSION_SECRET=your-session-secret-here

# Required - OAuth
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
OAUTH_BASE_URL=https://auth.yourdomain.com

# Required - Backend Integration
CONVEX_URL=https://your-deployment.convex.cloud
CONVEX_SITE_URL=https://your-deployment.convex.site

# Required - Frontend
FRONTEND_URL=https://yourdomain.com
ALLOWED_ORIGINS=https://yourdomain.com,https://staging.yourdomain.com

# Optional
SESSION_COOKIE_NAME=auth_session
NODE_ENV=production
```

## Development

### Prerequisites

- Node.js 18+
- Cloudflare Workers account
- Wrangler CLI installed globally
- Convex deployment

### Local Development

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.template .env
# Edit .env with your values

# Run locally with Wrangler
npm run dev

# Run with remote KV bindings
npm run dev:remote
```

### Testing

```bash
# Run unit tests
npm test

# Run type checking
npm run typecheck

# Run linting
npm run lint
```

## Deployment

### Staging Deployment

```bash
# Deploy to Cloudflare Workers staging
npm run deploy:staging
```

### Production Deployment

```bash
# Deploy to Cloudflare Workers production
npm run deploy:production
```

### KV Namespace Setup

The auth service requires a KV namespace for session storage:

```bash
# Create KV namespace (if not exists)
wrangler kv:namespace create AUTH_STORE

# Bind in wrangler.toml
[[kv_namespaces]]
binding = "AUTH_STORE"
id = "your-kv-namespace-id"
```

## Session Management

### KV Storage Strategy

Sessions are stored in Cloudflare KV with the following optimizations:
- Environment-prefixed keys: `{env}:sessions:{sessionId}`
- Encrypted session data
- Automatic TTL based on session expiration
- Rate-limited activity updates (5-minute intervals)

### Convex Fallback

When KV write limits are exceeded (1,000 writes/day on free tier):
- Session creation falls back to Convex-only storage
- Session reads attempt Convex when KV returns null
- Activity updates continue to Convex for real-time sync
- No user-facing impact during fallback

## Security Considerations

1. **Secret Rotation**: Regularly rotate JWT_SECRET and SESSION_SECRET
2. **OAuth Configuration**: Ensure correct redirect URIs in Google Console
3. **CORS Settings**: Be specific with allowed origins in production
4. **Cookie Security**: Always use HTTPS in production for secure cookies
5. **Rate Limiting**: Adjust limits based on expected traffic patterns

## Monitoring

- **Cloudflare Analytics**: Monitor request patterns and errors
- **KV Metrics**: Track storage usage and operation counts
- **Worker Logs**: Use `wrangler tail` for real-time logs
- **Convex Dashboard**: Monitor database operations and WebSocket connections

## Troubleshooting

### Common Issues

1. **KV Limit Exceeded**
   - Error: "KV put() limit exceeded for the day"
   - Solution: Service automatically falls back to Convex
   - Long-term: Consider upgrading KV plan

2. **OAuth Redirect Errors**
   - Verify OAUTH_BASE_URL matches deployment URL
   - Check Google Console redirect URI configuration
   - Ensure cookies are set with correct domain

3. **Session Not Found**
   - Check both KV and Convex for session data
   - Verify cookie domain settings
   - Confirm session hasn't expired

### Debug Commands

```bash
# View real-time logs
npm run logs

# View only errors
npm run logs:error

# Test WebSocket connection (local)
npm run test:websocket

# Test WebSocket connection (production)
npm run test:websocket:prod
```

## Architecture Decisions

### Why Cloudflare Workers?
- Global edge deployment for low latency
- Built-in KV storage for sessions
- Seamless integration with other Cloudflare services
- Cost-effective for authentication workloads

### Why Convex for Fallback?
- Real-time WebSocket support
- Automatic session synchronization across tabs
- Reliable backup when KV limits are hit
- Built-in ReactQuery/hooks for frontend

### Cookie Strategy
- Two-cookie approach balances security and functionality
- HTTP-only cookie prevents XSS attacks
- Non-HTTP-only cookie allows JavaScript session checks
- Cross-subdomain support for platform services

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Ensure all tests pass
5. Submit a pull request

## License

MIT License - see LICENSE file for details