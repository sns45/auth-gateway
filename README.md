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

That is the integration. No package to install and no sync code: the client
keeps itself current, including the session poll described below.
`authGateway` also exposes `signIn(provider, {callbackURL})`, `signOut()`, and
`refresh()`.

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
| Tab sync | `BroadcastChannel`, plus a session poll for everything else |
| Rate limits | Cloudflare KV |
| Plan | Workers Free. Nothing here requires Workers Paid |

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

### Keeping tabs in sync

Three mechanisms, because no single one covers every case:

| Mechanism | Covers | Why the others cannot |
|---|---|---|
| `BroadcastChannel` | same origin tabs, instantly | works while signed out, so it is what carries a **sign in** to other tabs |
| poll every 30 seconds | another device revoking a session | the only mechanism that crosses a device; `BroadcastChannel` cannot see one |
| refetch on `visibilitychange` | a tab the user comes back to | corrects at once, without waiting for the next tick |

No mechanism pushes state. Every one of them ends in the same place: refetch
`get-session` and trust the answer. That is what keeps a sign out on one device
from signing the others out, because the tab on the other device asks about its
own session and is told it is still valid.

#### Why a poll rather than a push

The request that revokes a session and a request holding a tab's connection run
in different isolates, usually in different colos, and neither can reach the
other. Bridging them needs a single addressable point both can find, which on
Workers means a Durable Object.

Durable Objects require Workers Paid. This gateway runs on the free plan, so a
tab asks rather than being told. The cost is bounded staleness in a tab nobody
is touching: up to the poll interval, instead of under a second. Nothing else
changes. Revocation is still immediate for every request that checks, because
D1 is the authority and every check reads it.

The interval is `SESSION_POLL_INTERVAL_MS` in `src/client/browser-client.ts`.
At 30 seconds one continuously visible tab spends 2,880 requests a day against
the free plan's 100,000 per day. Hidden tabs do not poll at all; they refetch
when they are shown again.

## Endpoints

| Path | Purpose |
|---|---|
| `/demo` | live integration example; open it in two tabs to see the sync |
| `/client.js` | the drop in browser client |
| `/api/auth/*` | Better Auth, passthrough |
| `/api/auth/administrator-session` | fresh session plus the configured platform administrator policy |
| `/api/auth/reference` | OpenAPI spec, generated from the live config |
| `/api/auth/agent/sign-in` | agent sign in, only while `AGENT_LOGIN_ENABLED` is `true`; see below |
| `/health`, `/health/ready`, `/health/live`, `/health/detailed` | queries D1 for real; 503 when it is down |

There is no websocket endpoint. Generic clients read `get-session`; platform
clients read `administrator-session` to require administrator access as well.

Every verified account whose exact email domain appears in `AUTH_ALLOWED_DOMAINS`
is an administrator. The pure `authorizeAdministratorEmail` function is exported
as `hono-auth-gateway/administrator-policy` for platform consumers to import from
a pinned gateway revision. Both edge and gateway use that same function. There
are no role tables, extra session claims, or authorization caches.

The administrator endpoint returns the same session and user shape as
`get-session`, with `Cache-Control: private, no-store`. Missing, invalid, or
revoked sessions return 401. Unverified or outside accounts, missing policy,
and malformed domain lists return 403. Policy accepts exact comma separated
domains, such as `prcpnt.com,lattiq.com`; wildcards and implicit subdomains are
not accepted. Generic sign in and session endpoints do not apply this policy.

The reference is generated rather than written, so it cannot drift from what
the gateway serves.

### Agent sign in

Optional, and off by default. It lets a coding agent sign in without a browser
so it can test and debug a site by itself.

- `POST /api/auth/agent/sign-in` with `Authorization: Bearer <AGENT_LOGIN_TOKEN>`
  sets the same session cookie Google sign in sets, for the one account named by
  `AGENT_LOGIN_EMAIL`.
- The route exists only when `AGENT_LOGIN_ENABLED` is exactly `true`, the token
  has at least 32 characters, and the email passes the administrator policy.
  Anything else returns 404.
- The body is ignored, and an address that already has a provider account is
  refused with 403, so the route never mints a session for a person.
- Agent sessions are stored with `userAgent` set to `auth-gateway agent-login`.
  On every auth request the gateway deletes an agent session that is over an
  hour old, or any agent session while agent sign in is off, never slides one
  forward, and lets one only read the session or sign out (403 elsewhere). This holds whatever cookies the client keeps, and whatever
  `AGENT_LOGIN_EMAIL` is now.
- Turning the flag off is therefore enough: new sign ins 404 and issued
  sessions are refused on their next request. Deleting rows by that
  `userAgent` is optional cleanup.
- Send the site's origin in an `Origin` header. Better Auth refuses a
  credentialed POST without one outside tests.
- The code lives in `src/agent-login.ts`.

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
| `AUTH_ALLOWED_DOMAINS` | optional exact domains for administrator access; used only by `administrator-session` |
| `FRONTEND_URL` | default post sign in destination |
| `GOOGLE_CLIENT_ID` | public by design, it appears in every OAuth redirect |
| `COOKIE_DOMAIN` | optional explicit domain matching the base host or its parent; omit for a cookie restricted to the base host |
| `NODE_ENV`, `LOG_LEVEL` | |
| `AGENT_LOGIN_ENABLED` | optional; `true` turns on agent sign in, anything else leaves it off |
| `AGENT_LOGIN_EMAIL` | the single account agent sign in creates and signs in |

Secrets, via `wrangler secret put` or Doppler:

| Name | Purpose |
|---|---|
| `BETTER_AUTH_SECRET` | signs session cookies; 32+ characters |
| `GOOGLE_CLIENT_SECRET` | OAuth code exchange |
| `AGENT_LOGIN_TOKEN` | optional bearer token for agent sign in; 32+ characters |

The provider's Authorized redirect URI must be
`{OAUTH_BASE_URL}/api/auth/callback/google`. A test pins this, because a
mismatch fails every sign in and the fix lives in a console this repo cannot
see.

Cookie and origin policy is resolved once per request in `src/config/auth.ts`.
HTTPS always uses `Secure` and the `__Secure-better-auth` cookie prefix, including
local HTTPS. HTTP uses the same policy with secure cookies disabled. `NODE_ENV`
does not select cookie attributes, allowed origins, or a weaker security stack.
An empty `COOKIE_DOMAIN` disables cross subdomain cookies. A configured domain
must match the base hostname or a parent domain. Sign in and sign out use the
same cookie name, domain, path, and security attributes.

`ALLOWED_ORIGINS` accepts exact HTTP or HTTPS origins, separated by commas.
Whitespace, trailing slashes, default ports, and duplicate entries are normalized.
Paths and wildcards are rejected. The base origin is also trusted, as it is by
Better Auth itself. CORS and CSRF use this same list. Localhost receives no
implicit exception. Configure every browser origin explicitly.

Existing deployments with an explicit valid cookie domain and HTTPS retain
their cookie names and attributes. Deployments that previously omitted the
domain switch to cookies restricted to the base host. Local HTTP cookies do
not migrate to the new HTTPS host; sign in again after restarting local services.

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

One gap worth knowing: these run on Node, not on workerd, so a runtime
difference between the two can still only be found on a deployment. The known
one is documented at the top of `tests/integration/auth-contract.test.ts`.
Closing this properly means `@cloudflare/vitest-pool-workers`, which runs tests
inside workerd.

## Deploying

```bash
bunx wrangler deploy --config config/wrangler.staging.toml   # staging first
bunx wrangler deploy --config config/wrangler.toml           # production
```

Staging is a separate worker on workers.dev with its own D1, reachable at
`in8-auth-gateway-staging.notifyshantanu.workers.dev`. It exists so a real
sign in, against a real migrated database, can be exercised before anything
reaches production. `wrangler versions upload` previews the code without taking
traffic, but it does not prove a migrated database and a live OAuth callback
work together.

Verify a deployment by opening `/demo` in two tabs and signing out of one. The
second tab follows within the poll interval rather than instantly, so give it
up to 30 seconds, or switch away and back to correct it at once.

Rollback is an ordinary redeploy of an earlier version. Nothing here declares a
Durable Object, so there is no migration to reverse and no `deleted_classes`
step.

Each environment needs `BETTER_AUTH_SECRET` and `GOOGLE_CLIENT_SECRET` set, and
its own callback URL registered with the OAuth provider.

## License

MIT
