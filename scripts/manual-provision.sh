#!/bin/bash

# Manual provisioning steps for Cloudflare KV

echo "🚀 Manual KV Provisioning Steps"
echo "=============================="
echo ""
echo "Run these commands in your terminal:"
echo ""
echo "1. First, make sure you're logged in:"
echo "   wrangler login"
echo ""
echo "2. Create the main KV namespace:"
echo "   wrangler kv namespace create AUTH_STORE"
echo ""
echo "3. Create the preview namespace (for local dev):"
echo "   wrangler kv namespace create AUTH_STORE --preview"
echo ""
echo "4. List all namespaces to get the IDs:"
echo "   wrangler kv namespace list"
echo ""
echo "5. Update wrangler.toml with the actual IDs from step 2 and 3"
echo ""
echo "Example output from step 2:"
echo '  { binding = "AUTH_STORE", id = "abcd1234..." }'
echo ""
echo "Example output from step 3:"
echo '  { binding = "AUTH_STORE", preview_id = "efgh5678..." }'
echo ""
echo "=============================="