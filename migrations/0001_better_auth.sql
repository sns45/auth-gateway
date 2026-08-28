-- Better Auth core schema on D1.
--
-- Generated: node scripts/generate-auth-schema.mjs > migrations/0001_better_auth.sql
-- Regenerate rather than hand editing. Do NOT use `@better-auth/cli generate`:
-- it bundles its own copy of the schema and drifted behind the runtime,
-- omitting account.issuer, which fails at insert time instead of migrate time.
--
-- Sessions live here and nowhere else. D1 sends every query to the primary
-- instance unless the Sessions API (`withSession`) is used, so deleting a
-- session row is visible to the very next read. The predecessor kept sessions
-- in Cloudflare KV, where a delete took up to 60 seconds to reach every colo
-- and a revoked session kept authenticating in the meantime.
--
-- Two things must stay true or that window reopens:
--   - no KV secondaryStorage in front of this (see src/auth.ts)
--   - no D1 read replication without pinning session reads to the primary

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "issuer" text not null, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create unique index "account_issuer_accountId_uidx" on "account" ("issuer", "accountId");