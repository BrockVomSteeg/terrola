# ADR 0001: who can see and change what

Status: accepted. The owner approved the direction; an independent review required the
changes listed here.

## Decision

1. One mode switch, `DEMO_MODE`, read only by `lib/mode.ts`. Modes: `live`, `demo-readonly`,
   `demo-writable`.
2. Demo mode refuses to start when any live variable is present. The check runs at build, at
   boot and per request.
3. The map page and every data route render per request. Nothing is baked in at build time.
4. The proxy runs on every path except static files. In `demo-readonly` it refuses every method
   except GET, HEAD and OPTIONS before anything else. A public list only skips the login check.
5. Every database or storage access goes through `getStore()`. In demo mode it returns an
   in-memory store that refuses writes as an error result. In live mode it verifies the session
   cookie first. The proxy is not the only gate.
6. The session is signed with `SESSION_SECRET` only (32 or more characters). There is no
   fallback to the password hash. Missing or short fails closed everywhere, and the auth route
   checks the key before the password.
7. A CSRF cookie is issued in demo mode too. CSRF checks are never skipped.
8. Keep-alive requires `CRON_SECRET` and returns no error text.
9. `demo-writable` runs only under the dev server or `NODE_ENV=test`.

## Why

The shared password is the only real gate in live mode. A hash is not a secret in practice (it
ends up in logs and screenshots), so it must not sign sessions. A demo that opens the map to
strangers is safe only if it can never be started next to real data and can never write.
Checking at the data layer as well as at the proxy means a new route that forgets the proxy
still cannot reach real data.

## Consequences

A deployment with a 16 to 31 character `SESSION_SECRET` must set a longer one, and everyone
logs in once more after the key change. Self-hosters can try the app with no secrets at all by
starting the dev server with `DEMO_MODE=writable`.

## Tests that keep this true

- A table test of `lib/mode.ts`: every `DEMO_MODE` value, every live variable, and writable on
  production.
- The proxy called directly for every route and page, with all methods, in all three modes.
- Matcher coverage checked with `unstable_doesMiddlewareMatch`.
- Spies proving no Supabase client and no network call run in demo mode.
- GET and HEAD return 200 in `demo-readonly`.
- A build check that the prerender manifest has no `/map` entry.
- The misconfiguration response names `SESSION_SECRET` and contains no value.
- Key dependent specs fail in CI instead of skipping.
