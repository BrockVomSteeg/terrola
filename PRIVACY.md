# Privacy

This describes what the code in this repository does. It is not legal advice, and it says
nothing about how the maintainer or anyone else runs a copy.

## The public demo

The demo stores nothing about visitors.

- Its data is eighteen made up visits to public places (twelve around the world, six in
  Kyoto), held in server memory
  ([`lib/demo/fixtures.ts`](lib/demo/fixtures.ts),
  [`lib/demo/memory-store.ts`](lib/demo/memory-store.ts);
  [test](tests/unit/access/memory-store.spec.ts), "is eighteen pins with fixed, distinct ids").
- Its pictures are eighteen real photographs of public places from Wikimedia Commons, each
  dedicated to the public domain (CC0 1.0), with their metadata removed. No person is the
  subject of any photo. They are kept as files in this repository and served by the app itself
  ([`public/demo/location-photos/`](public/demo/location-photos/),
  [`docs/ASSETS.md`](docs/ASSETS.md)).
- The read only demo accepts no writes, so a visitor cannot add anything
  ([`proxy.ts`](proxy.ts), step 2).
- It sets no cookie. A login attempt is refused: the proxy answers 403 to every write in the
  read only demo, and the login route itself answers 404 in any demo. The write token is never
  issued ([`proxy.ts`](proxy.ts), [`app/api/_lib/login.ts`](app/api/_lib/login.ts),
  [`app/api/_lib/csrf.ts`](app/api/_lib/csrf.ts);
  [test](tests/unit/access/csrf.spec.ts), "has no token to show").
- The browser keeps one setting for itself: the chosen map style, in `localStorage` under the
  key `app-map-style` ([`components/Map/MapCanvas.tsx`](components/Map/MapCanvas.tsx)). It is
  never sent to the server.

The demo never runs next to live settings, so it cannot reach anyone's real data
([`lib/mode.ts`](lib/mode.ts); see [SECURITY.md](SECURITY.md)).

## A self hosted live instance

A copy run in live mode stores, in the owner's own Supabase project:

- a table `public.locations`: title, date label, description, category, latitude, longitude,
  display order, creation time, photo links, photo framing and tiny blurred photo
  placeholders ([`supabase/migrations/20260101000000_init.sql`](supabase/migrations/20260101000000_init.sql));
- a private storage bucket `location-photos` that holds the uploaded photos and two smaller
  copies of each (same file). The bucket is not public; the app hands out signed links. A
  signed link lasts up to 30 days and opens that photo for anyone who has the link, without
  the password ([`lib/supabase-server.ts`](lib/supabase-server.ts),
  `SIGNED_READ_TTL_SECONDS`).

In the visitor's browser it sets:

- the session cookie, with a member label chosen from the `MEMBERS` list, which is not an
  identity ([`lib/session.ts`](lib/session.ts), [`lib/members.ts`](lib/members.ts));
- a cookie `app_csrf` that holds the write token
  ([`app/api/_lib/csrf.ts`](app/api/_lib/csrf.ts)).

Both last 30 days. The app keeps no list of visitors, no user accounts and no audit log.

## Third parties a browser talks to

- **Mapbox.** The map is drawn by Mapbox's library in the browser. The page's Content
  Security Policy allows that library to reach three Mapbox addresses: `api.mapbox.com`,
  `*.tiles.mapbox.com` and `events.mapbox.com`
  ([`next.config.ts`](next.config.ts), `connect-src`). This repository shows which addresses
  are allowed; what the library sends to each is Mapbox's to describe. In live mode the place
  search is sent to Mapbox by the server route
  [`app/api/geocode/route.ts`](app/api/geocode/route.ts), so what a member types in the
  search box reaches Mapbox. In a demo that route answers 404 first, so nothing typed is sent
  on ([test](tests/unit/access/demo-surface.spec.ts), "place search in a demo"). Mapbox's own policy:
  <https://www.mapbox.com/legal/privacy>.
- **The host.** A host such as Vercel keeps request logs (addresses and paths) by its own
  rules. Its policy: <https://vercel.com/legal/privacy-policy>.
- **Supabase,** in live mode only: the browser uploads photos straight to Supabase Storage
  and loads them from there ([`next.config.ts`](next.config.ts), `img-src` and
  `connect-src`). Supabase is the self hoster's own project.

This file does not describe what Mapbox or Vercel do with their data. Read their pages.

## What is not here

No analytics, no session replay, no third party error reporting (SPEC R12 in
[`SPEC.md`](SPEC.md)). Nothing in [`package.json`](package.json) adds such a service.
No automated gate checks this; it is checked by review.

## If you host a copy

You are responsible for your own Supabase project settings, your Mapbox token restrictions,
your host's logs and retention, who you give the password to, and telling your group what is
stored. The app gives you a private bucket and a table that is locked against every client
except the server, whose key bypasses that lock. It cannot make your project settings safe for
you.
