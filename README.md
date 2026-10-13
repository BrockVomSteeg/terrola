# Terrola

A private map of the places you share.

Terrola is a shared map for a small group. Pin places, add photos and notes, and see them on
a warm, hand drawn style map. You host it yourself on Next.js, Supabase and Mapbox.

DEMO_URL_TBD

PICTURE_TBD

The demo is open and read only, on made up data. It has no login and cannot change anything.

## What is checked

Each claim names the file that enforces it and the test or CI job that checks it. Tests are
under [`tests/unit/access/`](tests/unit/access/).

| claim | enforced in | tested in |
|-------|-------------|-----------|
| The demo never runs next to real credentials (five named variables) | [`lib/mode.ts`](lib/mode.ts), [`instrumentation.ts`](instrumentation.ts), [`proxy.ts`](proxy.ts), [`lib/demo/gate.ts`](lib/demo/gate.ts) | [`mode.spec.ts`](tests/unit/access/mode.spec.ts), [`gate.spec.ts`](tests/unit/access/gate.spec.ts) |
| The public demo refuses every write | [`proxy.ts`](proxy.ts), [`lib/demo/memory-store.ts`](lib/demo/memory-store.ts) | [`proxy-matrix.spec.ts`](tests/unit/access/proxy-matrix.spec.ts), [`memory-store.spec.ts`](tests/unit/access/memory-store.spec.ts) |
| Every path is refused unless it is listed | [`app/api/_lib/routes.ts`](app/api/_lib/routes.ts), [`proxy.ts`](proxy.ts) | [`proxy-matrix.spec.ts`](tests/unit/access/proxy-matrix.spec.ts) |
| Writes started by another site are refused | [`proxy.ts`](proxy.ts) | [`proxy-matrix.spec.ts`](tests/unit/access/proxy-matrix.spec.ts) |
| The session is signed with one key only and ends when the password changes | [`lib/session.ts`](lib/session.ts) | [`session-key.spec.ts`](tests/unit/access/session-key.spec.ts), [`csrf.spec.ts`](tests/unit/access/csrf.spec.ts) |
| A write needs a token tied to the session | [`app/api/_lib/csrf.ts`](app/api/_lib/csrf.ts) | [`csrf.spec.ts`](tests/unit/access/csrf.spec.ts) |
| Password guessing is slowed | [`app/api/_lib/login.ts`](app/api/_lib/login.ts), [`app/api/_lib/rate-limit.ts`](app/api/_lib/rate-limit.ts) | [`login.spec.ts`](tests/unit/access/login.spec.ts), [`rate-limit.spec.ts`](tests/unit/access/rate-limit.spec.ts) |
| Keep-alive needs a secret and returns no error text | [`app/api/_lib/cron.ts`](app/api/_lib/cron.ts) | [`keep-alive.spec.ts`](tests/unit/access/keep-alive.spec.ts) |
| The demo's data is made up and held in memory | [`lib/demo/fixtures.ts`](lib/demo/fixtures.ts), [`lib/demo/memory-store.ts`](lib/demo/memory-store.ts) | [`memory-store.spec.ts`](tests/unit/access/memory-store.spec.ts) |
| Reads go through one gate that checks the caller again | [`lib/demo/gate.ts`](lib/demo/gate.ts), [`app/api/_lib/live-access.ts`](app/api/_lib/live-access.ts) | [`gate.spec.ts`](tests/unit/access/gate.spec.ts), [`live-access.spec.ts`](tests/unit/access/live-access.spec.ts) |
| The demo screen offers no control that writes, and place search is closed | [`components/Map/MapCanvas.tsx`](components/Map/MapCanvas.tsx), [`app/api/geocode/route.ts`](app/api/geocode/route.ts) | [`demo-surface.spec.ts`](tests/unit/access/demo-surface.spec.ts) |
| A pull request touches only its own lane's files | [`LANES.json`](LANES.json), [`scripts/gates/lane-ownership.mjs`](scripts/gates/lane-ownership.mjs) | CI job `gates` in [`build.yml`](.github/workflows/build.yml) |

The tests fail when a rule is removed. PR 10, PR 12, PR 14 and PR 18 each have a proof run in
their description.

More detail: [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md),
[docs/threat-model.md](docs/threat-model.md),
[docs/adr/0001-access-control.md](docs/adr/0001-access-control.md).

## Numbers

Counted from the repository on 2026-10-13.

- 12 unit spec files under `tests/unit/access/` (count of `*.spec.ts` files).
- 5 CI jobs in 3 workflows under `.github/workflows/`: `build`, `unit` and `gates` in
  `build.yml`, `check` in `no-direct-supabase.yml`, `lock` in `lockfile.yml`.
- 3 gate scripts in `scripts/gates/` (brand, lane ownership, personal strings). Two of them
  run in CI today.
- The number of unit tests is not written here. The `unit` job prints it in every CI run.
- Lighthouse scores: not measured yet.

## Run it yourself

You need Node and npm. No env file and no Mapbox token are needed for the tests.

```sh
git clone <this repository>
cd terrola
npm ci --ignore-scripts
npm test
```

To try the app locally on made up data, start the dev server in the writable demo mode. Set
`NEXT_PUBLIC_MAPBOX_TOKEN` to your own Mapbox token to see the map tiles.

```sh
DEMO_MODE=writable npm run dev
```

The writable demo runs only under the dev server or `NODE_ENV=test`, and changes last until
the server stops. A hosted demo uses `DEMO_MODE=1`, which is read only.

For a live copy, create a Supabase project and run
[`supabase/migrations/20260101000000_init.sql`](supabase/migrations/20260101000000_init.sql).
The variable names live mode uses are `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
`SITE_PASSWORD_HASH`, `SESSION_SECRET` (32 or more characters), `CRON_SECRET`, `MEMBERS` and
`NEXT_PUBLIC_MAPBOX_TOKEN`. Read [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md)
before you share the password with anyone.

## Refused or deferred

From [`SPEC.md`](SPEC.md):

- **Analytics, session replay and third party error reporting.** Refused. SPEC rule R12
  forbids them, so [PRIVACY.md](PRIVACY.md) can say none is used.
- **Ads, payments, paid tiers and sponsor links.** Refused for now. They change the terms of
  the free hosting and map services the demo relies on.
- **Accounts per user.** Deferred to a later wave. Today there is one shared password.
- **Weather and tide facts, illustrated keepsake scenes, native apps.** Deferred to a later
  wave.

Known gaps, listed in [SECURITY.md](SECURITY.md):

- The data gate covers reads only. The write handlers still call the database directly after
  the proxy and the write token check.
- The Content Security Policy is report only.
- The data route rate limit trusts a header a caller can set. The login limit does not.
- Some gates named in `SPEC.md` are not written yet.

## How it was built

The code was written with an AI coding assistant (Claude Code), directed by the owner.
`SPEC.md`, `CLAUDE.md` and `LANES.json` are the rules it worked under. Every change went
through a pull request with CI, an independent review by a different model with fresh
context, and a proof run on a deliberately weakened copy to show the tests fail when a rule
is removed. This repository does not show a line by line review of the code by a human, and
this README does not claim one.

## Credits

Map data and tiles come from Mapbox. The app is built on Next.js, React, Supabase and
bcryptjs. The full dependency list is in [`package.json`](package.json).

## Licence

MIT. See [`LICENSE`](LICENSE).
