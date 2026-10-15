# Threat model

Written 2026-10-13 against `main`. Each line names the file that holds it and the test that
checks it. See also [SECURITY.md](../SECURITY.md) and
[ADR 0001](adr/0001-access-control.md).

## Assets

- The group's places, notes and photos in a live instance
  ([`supabase/migrations/20260101000000_init.sql`](../supabase/migrations/20260101000000_init.sql)).
- The shared password and its hash (`SITE_PASSWORD_HASH`).
- The signing key `SESSION_SECRET` and the Supabase service key `SUPABASE_SERVICE_KEY`, which
  bypasses row level security (same migration, header comment).
- The cron secret `CRON_SECRET`.
- The Mapbox token and its usage allowance (SPEC section 9, [`SPEC.md`](../SPEC.md)).

## Actors

1. A stranger on the demo.
2. A stranger on a live instance, with no password.
3. A group member who has the password.
4. Another website that a member visits.
5. The host's scheduler.

## Attack surface

Every page and route, from [`app/api/_lib/routes.ts`](../app/api/_lib/routes.ts). `public`
skips only the login check. `session` needs a valid session cookie in live mode. `cron` needs
the cron secret in live mode. In the demo modes there is no login, so the mode decides.
Anything not listed gets 404, and an unlisted method gets 405
([`proxy.ts`](../proxy.ts)).

| path | methods | rule |
|------|---------|------|
| `/` | GET | public |
| `/map` | GET | session |
| `/api/auth` | POST | public |
| `/api/geocode` | GET | session (404 in every demo mode) |
| `/api/identity` | POST, DELETE | session |
| `/api/keep-alive` | GET | cron |
| `/api/locations` | GET, POST | session |
| `/api/locations/[id]` | GET, PATCH, DELETE | session |
| `/api/locations/[id]/photo` | GET, POST, DELETE | session |
| `/api/locations/[id]/photo-url` | POST | session |

Test: [`proxy-matrix.spec.ts`](../tests/unit/access/proxy-matrix.spec.ts) walks `app/` and
fails when a file has no row or a row lists the wrong methods.

## What each actor can and cannot do

### 1. A stranger on the demo

Can: read the made up places. Cannot: write anything, and the screen offers no write control
([`demo-surface.spec.ts`](../tests/unit/access/demo-surface.spec.ts)). Every method other than GET, HEAD and
OPTIONS gets 403 `demo_read_only`, on any path
([`proxy.ts`](../proxy.ts); [`proxy-matrix.spec.ts`](../tests/unit/access/proxy-matrix.spec.ts),
"demo-readonly: no write gets through"). The store also refuses
([`memory-store.ts`](../lib/demo/memory-store.ts);
[`memory-store.spec.ts`](../tests/unit/access/memory-store.spec.ts)). Cannot log in: the
proxy answers 403 `demo_read_only` to the login request like any other write, and the login
route itself answers 404 in any demo ([`login.ts`](../app/api/_lib/login.ts);
[`login.spec.ts`](../tests/unit/access/login.spec.ts)). Cannot reach real data, because the
demo refuses to run next to any of the five live variables
([`mode.ts`](../lib/mode.ts); [`mode.spec.ts`](../tests/unit/access/mode.spec.ts)).
Cannot use place search: it answers 404 in a demo, so typed text is not sent to Mapbox.
Can use up the Mapbox allowance by loading the map; the token restriction and usage alert
are the owner's job (SPEC section 9).

### 2. A stranger on a live instance

Can: open the login page and try passwords. Cannot: read or write data without a session (reads are checked again at the data gate, [`gate.ts`](../lib/demo/gate.ts)); the
proxy answers 401 JSON for API paths and redirects pages to `/`
([`proxy.ts`](../proxy.ts); [`proxy-matrix.spec.ts`](../tests/unit/access/proxy-matrix.spec.ts),
"live: with no credential nothing but the two public rows gets through"). Cannot forge a
session without `SESSION_SECRET` ([`session.ts`](../lib/session.ts);
[`session-key.spec.ts`](../tests/unit/access/session-key.spec.ts)). Guessing passwords is
slowed to 5 tries per client per 15 minutes on Vercel and 60 per instance for everyone, in
memory ([`login.ts`](../app/api/_lib/login.ts);
[`login.spec.ts`](../tests/unit/access/login.spec.ts)). That slows a guesser; it does not stop
one who spreads attempts over instances or time. A long, random shared password is the real
defence. If `SESSION_SECRET` is missing or short, API routes answer 503 and pages go to the login
page, except keep-alive ([`proxy.ts`](../proxy.ts), step 6). Can open a photo with no
password if they get hold of one of its signed links, for as long as the link lasts (up to 30
days; [`supabase-server.ts`](../lib/supabase-server.ts), `SIGNED_READ_TTL_SECONDS`).

### 3. A group member with the password

Can: read and write all places and photos, and claim any member name
([`identity/route.ts`](../app/api/identity/route.ts)). This is by design: there is one shared
password. Cannot: use a password longer than 72
bytes ([`login.ts`](../app/api/_lib/login.ts)). Can keep a session for 30 days; it ends at
once if the password changes ([`session.ts`](../lib/session.ts)).

### 4. Another website the member visits

Can: try to make the member's browser send a write. Cannot: succeed. The session cookie is
`SameSite=Strict` ([`session.ts`](../lib/session.ts)). The proxy refuses a write marked
cross site by `Sec-Fetch-Site`, then `Origin`, in every mode
([`proxy.ts`](../proxy.ts); [`proxy-matrix.spec.ts`](../tests/unit/access/proxy-matrix.spec.ts),
"a write started by another site is refused"). A write also needs the session bound token,
and a planted cookie with an equal header does not pass
([`csrf.spec.ts`](../tests/unit/access/csrf.spec.ts), "is refused when the header only equals
a planted app_csrf cookie"). The `__Host-` prefix stops a sibling subdomain from planting the
session cookie in production ([`session.ts`](../lib/session.ts)). Embedding the app in a
frame is blocked by `X-Frame-Options: DENY` ([`next.config.ts`](../next.config.ts)). Script
injection is not blocked by the Content Security Policy today, because it is report only and
allows `'unsafe-inline'` ([`next.config.ts`](../next.config.ts)).

### 5. The host's scheduler

Can: call `GET /api/keep-alive` with `Authorization: Bearer <CRON_SECRET>`; this does a head
only count on `locations` ([`keep-alive/route.ts`](../app/api/keep-alive/route.ts)). Cannot:
open any other route with that secret, and a session does not open keep-alive
([`proxy-matrix.spec.ts`](../tests/unit/access/proxy-matrix.spec.ts), "live: a session does
not open keep-alive, and the cron secret opens nothing else"). Through the data gate the scheduler gets the ping and no data
([`live-access.spec.ts`](../tests/unit/access/live-access.spec.ts)). Anyone without the secret gets
401 with an empty body and no error text
([`cron.ts`](../app/api/_lib/cron.ts); [`keep-alive.spec.ts`](../tests/unit/access/keep-alive.spec.ts)).
A secret under 16 characters counts as no secret.

## Known gaps

- The data gate (SPEC R17, [`lib/demo/gate.ts`](../lib/demo/gate.ts)) now covers reads and
  writes. No route file under `app/api/` imports the database client, so a new route that
  forgot the proxy would still meet the store's own check.
- A failed storage listing can read as "no photos".
- A signed photo link works without a session for up to 30 days, and a live read can save a
  refreshed link back to its row ([`live-store.ts`](../app/api/_lib/live-store.ts)).
- The server's database key bypasses row level security, so the checks in the app are the only
  gate in front of the data
  ([`supabase-server.ts`](../lib/supabase-server.ts)).
- Some gates named in SPEC do not exist yet ([`scripts/gates/`](../scripts/gates/)).
- No audit log. No revocation of a single stolen session.
- `checkRateLimit` on data routes reads `x-forwarded-for`, which a caller can set
  ([`rate-limit.ts`](../app/api/_lib/rate-limit.ts), `getIp`). The login limit does not.

## Non goals

- Per user accounts and permissions. There is one shared password.
- Protection against someone who has the shared password.
- End to end encryption. The server and the Supabase project can read the data.
- Defending a self hoster's own Supabase project settings, Mapbox token restrictions or host
  settings.
- Defending against a compromised member device or browser.
- Stopping a determined password guesser who spreads attempts across instances and time.
