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
7. A write started by another site is refused at the proxy in every mode, by `Sec-Fetch-Site`
   first and `Origin` second (`proxy.ts`). In live mode a write also needs a token tied to the
   session: an HMAC of the signed part of the session cookie, sent as `X-CSRF-Token` and
   recomputed by the server (`app/api/_lib/csrf.ts`). The demo has no session, so it has no
   token and sets no cookie. There the proxy check is the control, and the read only demo
   refuses every write anyway.
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

Keep-alive is checked at the proxy with the cron secret alone, before the signing key is
looked at. A deployment with a broken `SESSION_SECRET` still keeps its database awake
(`proxy.ts`, `tests/unit/access/proxy-matrix.spec.ts`).

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

## Amendments

- 2026-10-13: item 7 replaced. The earlier text issued a plain double submit cookie in every
  mode. OWASP marks that pattern as discouraged: a cookie planted by another site, with an
  equal header, would pass. The token is now tied to the session and the server recomputes it
  (`tests/unit/access/csrf.spec.ts`, "is refused when the header only equals a planted
  app_csrf cookie"). Also noted: the keep-alive check at the proxy does not depend on the
  session key.
- 2026-10-13: item 5 is half done. Reads go through `getStore()` (`lib/demo/gate.ts`); the
  write handlers still call the database directly after the proxy and token checks.
