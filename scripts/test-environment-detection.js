#!/usr/bin/env node

/**
 * Test Environment Detection Logic
 */

console.log('🧪 Testing Environment Detection');
console.log('================================\n');

// Test cases
const testCases = [
  { hostname: 'auth.example.com', expected: 'production', prefix: 'prod' },
  { hostname: 'auth-staging.example.com', expected: 'staging', prefix: 'staging' },
  { hostname: 'localhost', expected: 'development', prefix: 'dev' },
  { hostname: 'localhost:8787', expected: 'development', prefix: 'dev' },
  { hostname: '127.0.0.1:8787', expected: 'development', prefix: 'dev' },
  { hostname: 'some-other-domain.com', expected: 'development', prefix: 'dev' },
];

// Environment detection logic (same as in middleware)
function detectEnvironment(hostname) {
  if (hostname === 'auth.example.com') {
    return { env: 'production', prefix: 'prod', logLevel: 'warn' };
  } else if (hostname === 'auth-staging.example.com') {
    return { env: 'staging', prefix: 'staging', logLevel: 'info' };
  } else {
    return { env: 'development', prefix: 'dev', logLevel: 'debug' };
  }
}

// Run tests
console.log('📋 Test Results:\n');
let passed = 0;
let failed = 0;

testCases.forEach(({ hostname, expected, prefix }) => {
  const result = detectEnvironment(hostname);
  const isCorrect = result.env === expected && result.prefix === prefix;
  
  if (isCorrect) {
    console.log(`✅ ${hostname}`);
    console.log(`   → Environment: ${result.env}`);
    console.log(`   → KV Prefix: ${result.prefix}:`);
    console.log(`   → Log Level: ${result.logLevel}`);
    passed++;
  } else {
    console.log(`❌ ${hostname}`);
    console.log(`   Expected: ${expected} (${prefix}:)`);
    console.log(`   Got: ${result.env} (${result.prefix}:)`);
    failed++;
  }
  console.log('');
});

// Summary
console.log('📊 Summary:');
console.log(`   Total Tests: ${testCases.length}`);
console.log(`   Passed: ${passed}`);
console.log(`   Failed: ${failed}`);
console.log('');

// Example KV keys
console.log('🔑 Example KV Keys by Environment:\n');
console.log('Production (auth.example.com):');
console.log('   Sessions: prod:sessions:{sessionId}');
console.log('   Rate Limit: prod:ratelimit:anonymous:{ip}');
console.log('');
console.log('Staging (auth-staging.example.com):');
console.log('   Sessions: staging:sessions:{sessionId}');
console.log('   Rate Limit: staging:ratelimit:anonymous:{ip}');
console.log('');
console.log('Development (localhost):');
console.log('   Sessions: dev:sessions:{sessionId}');
console.log('   Rate Limit: dev:ratelimit:anonymous:{ip}');
console.log('');

// Exit with appropriate code
process.exit(failed > 0 ? 1 : 0);