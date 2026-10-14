# Security

## Report a problem

Use GitHub's private vulnerability reporting on this repository: open the Security tab and
choose "Report a vulnerability". Please do not open a public issue for a security problem.

Only the `main` branch is supported. There are no released versions yet.

## How access works

Each claim below names the file that shows it. Tests live under
[`tests/unit/access/`](tests/unit/access/).

### Three modes

[`lib/mode.ts`](lib/mode.ts) is the only place that reads `DEMO_MODE`
([test](tests/unit/access/mode.spec.ts)).

| mode | data | login | writes |
|------|------|-------|--------|
| `live` | Supabase | one shared password | yes |
| `demo-readonly` | made up data in memory | none | refused |
| `demo-writable` | made up data in memory | none | let through by the proxy, but saving fails today |

`demo-writable` is refused on Vercel and anywhere outside the dev server and tests
([`lib/mode.ts`](lib/mode.ts), `assertRuntime`). Saving does not work in it yet: the write
handlers are not wired to the in memory store (see "The data gate").

### The demo never runs next to live settings

Demo mode refuses to start when any of these five variables is set:
`SUPABASE_SERVICE_KEY`, `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SITE_PASSWORD_HASH`,
`SESSION_SECRET` ([`lib/mode.ts`](lib/mode.ts), `LIVE_VARS`). The check runs:

- at boot: [`instrumentation.ts`](instrumentation.ts)
- on every request: the first step in [`proxy.ts`](proxy.ts), which answers 503 and names
  variables, never values
- at build: `buildCheck()` in [`lib/demo/gate.ts`](lib/demo/gate.ts) runs when that module is
  loaded. The map page, the keep-alive route and the three routes that read places and photos
  import it; the login, identity, place search and upload address routes do not
  ([test](tests/unit/access/gate.spec.ts), "the build check")

A separate script, [`scripts/check-env.mjs`](scripts/check-env.mjs), is not called by the
build script in [`package.json`](package.json).

### The proxy

[`proxy.ts`](proxy.ts) runs on every path except static files (the `matcher` at the bottom of
that file; [test](tests/unit/access/proxy-matrix.spec.ts)). It refuses whatever is not written
in [`app/api/_lib/routes.ts`](app/api/_lib/routes.ts): an unknown path gets 404, an unlisted
method 405. A test fails when a page or route file has no row in that list. Every refusal
carries `Cache-Control: no-store`.

The proxy is the first gate, not the only one (see "The data gate").

### The data gate

Every read goes through `getStore()` in [`lib/demo/gate.ts`](lib/demo/gate.ts): the map page
([`app/map/page.tsx`](app/map/page.tsx), rendered on every request), the list and single
location reads, the photo list read and the keep-alive ping. In a demo the gate returns the
in memory store and never opens the live one. In live mode it opens the Supabase store, which
checks the caller again: a valid session for data, the cron secret for the ping, and the
scheduler gets the ping and no data
([`app/api/_lib/live-access.ts`](app/api/_lib/live-access.ts),
[`live-store.ts`](app/api/_lib/live-store.ts); tests:
[`gate.spec.ts`](tests/unit/access/gate.spec.ts),
[`live-access.spec.ts`](tests/unit/access/live-access.spec.ts)). A refusal is mapped to a
status in one place with no error reason passed on
([`store-response.ts`](app/api/_lib/store-response.ts)).

This is half done. The write handlers (POST, PATCH, DELETE on the location and photo routes)
still call the database directly, after the proxy and the write token check. In
`demo-writable` there is no database to call, so a save answers with an error there and
nothing is kept.

A read in live mode can also write: when a stored photo link has under 3 days left, the read
signs a new one and saves it back to the same row
([`live-store.ts`](app/api/_lib/live-store.ts),
[`lib/supabase-server.ts`](lib/supabase-server.ts), `freshenCoverUrls`). It writes the two
photo link columns and nothing else.

### Place search is closed in a demo

`GET /api/geocode` answers 404 in every demo mode before anything else, so nothing a
visitor types is sent to Mapbox from the server
([`app/api/geocode/route.ts`](app/api/geocode/route.ts);
[test](tests/unit/access/demo-surface.spec.ts), "place search in a demo").

### The demo's screen

The map page tells the map when it is the read only demo. The map then shows no add button,
no edit panel, no polling, and the place card shows no edit, remove or reframe
([`app/map/page.tsx`](app/map/page.tsx),
[`components/Map/MapCanvas.tsx`](components/Map/MapCanvas.tsx),
[`components/Map/LocationCard.tsx`](components/Map/LocationCard.tsx),
[`components/UI/DemoBanner.tsx`](components/UI/DemoBanner.tsx);
[test](tests/unit/access/demo-surface.spec.ts), "the demo's screen"). The server refuses the
writes anyway; the screen only avoids offering what cannot work.

### The read only demo refuses every write

In `demo-readonly`, any method other than GET, HEAD or OPTIONS gets 403 `demo_read_only`
before the path is even looked up, including `/api/auth` ([`proxy.ts`](proxy.ts), step 2;
[test](tests/unit/access/proxy-matrix.spec.ts), "demo-readonly: no write gets through").
The in memory store also refuses writes, as a returned error and not a thrown one
([`lib/demo/memory-store.ts`](lib/demo/memory-store.ts),
[test](tests/unit/access/memory-store.spec.ts)). The demo store imports no database client
and makes no network call (same test file).

### Writes from another site are refused

In every mode, a write (any method other than GET, HEAD, OPTIONS) that the browser marks as
started by another site gets 403 `cross_site`. The proxy reads `Sec-Fetch-Site` first and
falls back to `Origin` ([`proxy.ts`](proxy.ts), `isCrossSite`;
[test](tests/unit/access/proxy-matrix.spec.ts), "a write started by another site is
refused"). A request with neither header is not a browser page and passes this check.

### The session cookie

[`lib/session.ts`](lib/session.ts), [test](tests/unit/access/session-key.spec.ts):

- Signed with HMAC SHA 256 using `SESSION_SECRET` only, 32 or more characters. There is no
  fallback to the password hash. A missing or short secret fails closed in every
  environment, and the login route checks the key before the password.
- Name `__Host-app_session` and `Secure`, except under the dev server and tests, where the
  name is `app_session` and the cookie is not `Secure` because plain http cannot carry it.
- `HttpOnly`, `SameSite=Strict`, path `/`, 30 days.
- The token holds a short keyed fingerprint of the password hash, so changing the password
  ends every session at once ([`lib/session.ts`](lib/session.ts), `passwordFingerprint`;
  [test](tests/unit/access/csrf.spec.ts), "is refused after the password changed").

### The write token

In live mode a write also needs the header `X-CSRF-Token`. Its value is an HMAC of the signed
part of the session cookie. The server recomputes it and compares in constant time, so a
cookie planted by another site cannot make a valid one
([`app/api/_lib/csrf.ts`](app/api/_lib/csrf.ts);
[test](tests/unit/access/csrf.spec.ts)). The demo has no session, so it has no token and sets
no cookie.

### Login limits

[`app/api/_lib/login.ts`](app/api/_lib/login.ts), `LOGIN_LIMITS`
([test](tests/unit/access/login.spec.ts)):

- 5 attempts per client per 15 minutes. This applies only on Vercel, where the platform sets
  the client address header; elsewhere no address is trusted
  ([`rate-limit.ts`](app/api/_lib/rate-limit.ts), `trustedClientBucket`).
- 60 attempts per server instance for everyone together per 15 minutes. Past that, new logins
  get 429; existing sessions keep working.

The counters live in each server instance's memory. A cold start clears them and each
instance counts alone. This is a brake, not a lock. A hosted deployment should also use the
host's own firewall rate limit ([`rate-limit.ts`](app/api/_lib/rate-limit.ts), header
comment).

### Passwords over 72 bytes are refused

bcrypt reads 72 bytes and ignores the rest, so a longer password would be accepted on its
first 72 bytes alone. The login route refuses it with 400, counting bytes and not characters
([`app/api/_lib/login.ts`](app/api/_lib/login.ts), `PASSWORD_MAX_BYTES`;
[test](tests/unit/access/login.spec.ts)).

### Keep-alive

`GET /api/keep-alive` needs `Authorization: Bearer <CRON_SECRET>`, with a secret of at least
16 characters. A wrong or missing secret gets 401 with an empty body. The ping itself runs through the
data gate with the cron credential ([`app/api/keep-alive/route.ts`](app/api/keep-alive/route.ts)). A database failure
answers 500 with a fixed body and no error text
([`app/api/_lib/cron.ts`](app/api/_lib/cron.ts);
[test](tests/unit/access/keep-alive.spec.ts)). The proxy checks the secret before it looks
at the session key ([`proxy.ts`](proxy.ts), step 6).

### Response headers

Set for every path in [`next.config.ts`](next.config.ts): `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=()`.

The Content Security Policy is sent as `Content-Security-Policy-Report-Only`. Today it
reports and blocks nothing. It allows `'unsafe-inline'` for scripts and styles
([`next.config.ts`](next.config.ts), comment above `cspReportOnly`).

## Known limits

- **One shared password.** Anyone who has it can read and write, and can claim any member
  name. The member name is a label in the cookie, not an identity
  ([`app/api/identity/route.ts`](app/api/identity/route.ts), header comment).
- **30 day sessions.** A deliberate choice for a small private group. It is longer than OWASP
  suggests for office apps ([`lib/session.ts`](lib/session.ts), `COOKIE_MAX_AGE`).
- **A signed photo link works without the password.** Photos sit in a private bucket and the
  app hands out signed links that last up to 30 days. Anyone who gets such a link can open
  that photo until it runs out, with no session
  ([`lib/supabase-server.ts`](lib/supabase-server.ts), `SIGNED_READ_TTL_SECONDS`).
- **The server's database key bypasses row level security.** The table has row level security
  on with no policy, which shuts out every other client. The server itself uses the service
  key, so the checks in this file are the only thing between a request and the data
  ([`supabase/migrations/20260101000000_init.sql`](supabase/migrations/20260101000000_init.sql),
  [`lib/supabase-server.ts`](lib/supabase-server.ts)).
- **A live read can write a refreshed photo link.** See "The data gate".
- **No revocation of one session.** Clearing a cookie in a browser does not end a stolen
  copy. Changing the password ends all sessions.
- **Login limit in memory.** See "Login limits".
- **CSP is report only.** See "Response headers".
- **The store gate covers reads only.** The write handlers still call the database
  directly after the proxy and token checks (for example the `POST` in
  [`app/api/locations/route.ts`](app/api/locations/route.ts)). SPEC R17 is half done, and
  saving fails in `demo-writable`.
- **Data route limits trust a forgeable header.** `checkRateLimit` reads `x-forwarded-for`
  as sent by the caller ([`app/api/_lib/rate-limit.ts`](app/api/_lib/rate-limit.ts),
  `getIp`). The login limit does not. Treat the data route limits as light brakes.
- **Some gates named in SPEC do not exist yet.** [`scripts/gates/`](scripts/gates/) holds the
  brand, lane ownership and personal strings scripts; the others in SPEC section 3 are not
  written, and only the first two run in CI
  ([`.github/workflows/build.yml`](.github/workflows/build.yml)).
- **`scripts/check-env.mjs` is not part of the build.** See "The demo never runs next to
  live settings".
- **No audit log.** Nothing records who changed what.
