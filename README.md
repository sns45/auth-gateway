# Authentication Gateway

One hosted sign in for many sites. Point a page at it with two lines, and every
tab that page opens stays in sync, on every device, without a reload.

## Adding a site

```html
<script src="https://auth.in8.sh/client.js"></script>
<script>
  authGateway.subscribe(function (session) {
    render(session ? session.user : null);
  });
</script>
```

That is the integration. No package to install, no session polling, no sync
code. `authGateway` also exposes `signIn(provider, {callbackURL})`,
`signOut()`, and `refresh()`.

Server side, validate a request by asking the gateway:

```js
const res = await fetch("https://auth.in8.sh/api/auth/get-session", {
  headers: { cookie: request.headers.get("cookie") ?? "" },
});
const session = await res.json(); // { user, session } or null
```

Two things to get right when the client is on Cloudflare too:

- Add the site's origin to `ALLOWED_ORIGINS`, or its browser calls are blocked.
- Call the gateway through a **service binding**, not over its public hostname.
  Same zone subrequests bypass Worker routes, so a plain `fetch` to
  `auth.in8.sh` from another Worker on the same zone reaches the zone origin
  instead of the gateway.

## How it works

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers, Hono |
| Auth | [Better Auth](https://better-auth.com) as a library, running in the worker |
| Sessions | Cloudflare D1 |
| Live sync | One Durable Object per user, WebSocket hibernation |
| Rate limits | Cloudflare KV |

Better Auth is a dependency, not a service. Nothing leaves your infrastructure:
the OAuth code exchange runs in your worker with your client secret, sessions
are rows in your D1, and cookies are signed with your `BETTER_AUTH_SECRET`. The
only third party in a sign in is the identity provider itself.

### Sessions are in D1, deliberately

They used to be in KV. KV is eventually consistent: a delete takes up to 60
seconds to reach every colo, and reads are additionally served from a per colo
edge cache. A revoked session kept authenticating elsewhere for up to a minute.

D1 sends every query to the primary instance unless the Sessions API is used,
so a delete is visible to the very next read. Two invariants keep it that way,
both pinned by tests in `tests/unit/session-revocation.test.ts`:

- **No `secondaryStorage`.** Better Auth checks it before the database and
  short circuits on a hit. Backed by KV, that serves revoked sessions from a
  stale colo, which is the exact bug this moved off KV to fix.
- **No `session.cookieCache`.** It keeps the session in a signed cookie, and a
  server cannot delete a cookie on someone else's device.

If D1 read replication is ever adopted, session reads must stay pinned to the
primary for the same reason.

### Live sync

Three mechanisms, because no single one covers every case:

| Mechanism | Covers | Why the others cannot |
|---|---|---|
| `BroadcastChannel` | same origin tabs, instantly | works while signed out, so it is what carries a **sign in** to other tabs |
| WebSocket to the user's Durable Object | another device revoking a session | reaches an idle tab; needs a session to address the hub, so it cannot cover sign in |
| refetch on `visibilitychange` | anything missed while hidden | backstop |

The Durable Object exists because the request that revokes a session and the
request holding a tab's connection run in different isolates, usually in
different colos, and neither can reach the other. A DO addressed by
`idFromName(userId)` is the one place both can find.

Its events carry no state, only `{type, reason, at}`. The hub is per user, so a
push reaches that user's tabs on **every** device, but signing out only ends
the session on the device that did it. Broadcasting "you are signed out" would
wrongly log out the others. Each tab re-verifies with `get-session` and reaches
its own conclusion, and no session identifier ever goes on the wire.

Hibernation is what makes this affordable: an idle connection costs nothing.
Holding the same connections on SSE would bill duration for as long as a tab is
open.

## Endpoints

| Path | Purpose |
|---|---|
| `/demo` | live integration example; open it in two tabs to see the sync |
| `/client.js` | the drop in browser client |
| `/api/auth/*` | Better Auth, passthrough |
| `/api/auth/reference` | OpenAPI spec, generated from the live config |
| `/api/auth/session-stream` | WebSocket, requires a session |
| `/health`, `/health/ready`, `/health/live`, `/health/detailed` | queries D1 for real; 503 when it is down |

The reference is generated rather than written, so it cannot drift from what
the gateway serves.

## Running it

```bash
bun install
bun run dev              # wrangler dev against config/wrangler.toml
bun test                 # vitest
bun run typecheck
```

### Configuration

Variables in `config/wrangler.toml`:

| Name | Purpose |
|---|---|
| `OAUTH_BASE_URL` | the gateway's own origin; OAuth callbacks are built from it |
| `ALLOWED_ORIGINS` | comma separated origins allowed to call with credentials |
| `FRONTEND_URL` | default post sign in destination |
| `GOOGLE_CLIENT_ID` | public by design, it appears in every OAuth redirect |
| `COOKIE_DOMAIN` | optional; defaults to the apex of the request hostname |
| `NODE_ENV`, `LOG_LEVEL` | |

Secrets, via `wrangler secret put` or Doppler:

| Name | Purpose |
|---|---|
| `BETTER_AUTH_SECRET` | signs session cookies; 32+ characters |
| `GOOGLE_CLIENT_SECRET` | OAuth code exchange |

The provider's Authorized redirect URI must be
`{OAUTH_BASE_URL}/api/auth/callback/google`. A test pins this, because a
mismatch fails every sign in and the fix lives in a console this repo cannot
see.

### Database

```bash
bun run db:schema         # regenerate the migration from the installed better-auth
bun run db:migrate        # apply to remote D1
bun run db:migrate:local  # apply to the local D1
```

Regenerate with `scripts/generate-auth-schema.mjs`. It calls the installed
library's own migration builder, so the DDL cannot disagree with the library
running in the worker. Better Auth's CLI (`npx auth@latest generate`) also
works and tracks the runtime; the script simply removes the version question
entirely. Do not use the older `@better-auth/cli`, which is deprecated and
frozen at 1.4.21, and emits a pre-1.7 schema with no `account.issuer` column.

## Testing

```bash
bun run test:unit
bun run test:integration
```

Integration tests boot the real app from `src/index.ts` with its full
middleware stack against real SQLite, rather than asserting against a mock
defined in the test file.

One gap worth knowing: the WebSocket upgrade is not exercised in CI. Node's
fetch forbids constructing a 101 response and workerd requires one, so the test
asserts the accept side effect and stops there. Hibernation, reconnect, and fan
out across two browsers are only verified on a real deployment. Closing this
properly means `@cloudflare/vitest-pool-workers`, which runs tests inside
workerd.

## Deploying

```bash
bunx wrangler deploy --config config/wrangler.staging.toml   # staging first
bunx wrangler deploy --config config/wrangler.toml           # production
```

Staging is a separate worker on workers.dev with its own D1, reachable at
`in8-auth-gateway-staging.notifyshantanu.workers.dev`. It exists because
`wrangler versions upload`, the usual way to preview without taking traffic,
is refused for any Worker carrying a Durable Object migration. Without a second
worker there is no way to prove the migration applies, or to exercise the
websocket path, before it reaches production.

Verify a deployment by opening `/demo` in two tabs and signing out of one.

Rolling back across the Durable Object migration is not a single command: an
earlier version without the `SessionHub` class needs a `deleted_classes`
migration. Prefer a forward fix.

Each environment needs `BETTER_AUTH_SECRET` and `GOOGLE_CLIENT_SECRET` set, and
its own callback URL registered with the OAuth provider.

## License

MIT
