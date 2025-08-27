# DNS Setup Instructions for Single Worker Deployment

## Overview

With our single worker deployment, we need to configure DNS to route both production and staging traffic to the same Cloudflare Worker.

## Required DNS Records

Add these CNAME records to your `example.com` domain:

### Production
```
Type: CNAME
Name: auth
Target: in8-auth-gateway.workers.dev
Proxied: Yes (Orange Cloud)
```

### Staging
```
Type: CNAME
Name: auth-staging
Target: in8-auth-gateway.workers.dev
Proxied: Yes (Orange Cloud)
```

## Cloudflare Dashboard Steps

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select your `example.com` domain
3. Go to DNS settings
4. Add the CNAME records above
5. Ensure "Proxied" (orange cloud) is enabled for both records

## Worker Routes

The worker is configured with these routes in `wrangler.toml`:
- `auth.example.com/*` → Production environment
- `auth-staging.example.com/*` → Staging environment

## Environment Detection

The worker automatically detects the environment based on the hostname:
- `auth.example.com` → Uses production settings, `prod:` KV prefix
- `auth-staging.example.com` → Uses staging settings, `staging:` KV prefix
- `localhost:*` → Uses development settings, `dev:` KV prefix

## Verification

After DNS propagation (usually 1-5 minutes), test the endpoints:

```bash
# Test production
curl https://auth.example.com/health

# Test staging
curl https://auth-staging.example.com/health

# Expected response:
{
  "status": "healthy",
  "environment": "production", // or "staging"
  "timestamp": "2024-01-22T20:00:00.000Z"
}
```

## SSL/TLS

Cloudflare automatically provides SSL certificates for both subdomains when proxied through Cloudflare.

## Troubleshooting

1. **DNS not resolving**: Wait up to 5 minutes for propagation
2. **SSL errors**: Ensure the record is proxied (orange cloud)
3. **Worker not responding**: Check worker logs in Cloudflare dashboard
4. **Wrong environment detected**: Verify the hostname in your request