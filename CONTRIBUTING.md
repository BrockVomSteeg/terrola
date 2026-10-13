# Contributing

## How the repository is organised

Work is split into lanes: access, tests, docs, ci and brand. [`LANES.json`](LANES.json) says
which files each lane owns, and which files are protected (the spec, the gates, the
workflows, the licence). The rules are in [`SPEC.md`](SPEC.md) and the lane table is in its
section 5.

- One lane, one branch (`lane/<name>`), one pull request.
- A pull request touches only the files its lane owns. The lane ownership gate fails it
  otherwise ([`scripts/gates/lane-ownership.mjs`](scripts/gates/lane-ownership.mjs)).
- Unit tests for a lane live under `tests/unit/<lane>/`.
- Protected files change only with the maintainer's review
  ([`CODEOWNERS`](CODEOWNERS)).

## What CI runs

On every pull request to `main` ([`.github/workflows/`](.github/workflows/)):

- `build` in [`build.yml`](.github/workflows/build.yml): type check and the Next.js build.
- `unit` in [`build.yml`](.github/workflows/build.yml): `npm test`, with no browser, no
  network and no env file.
- `gates` in [`build.yml`](.github/workflows/build.yml): the brand gate and the lane
  ownership gate.
- `check` in [`no-direct-supabase.yml`](.github/workflows/no-direct-supabase.yml): fails if
  Supabase is imported outside `app/api/*` and `lib/supabase-server.ts`.
- `lock` in [`lockfile.yml`](.github/workflows/lockfile.yml): runs when `package.json`
  changes and uploads the resolved lockfile.

## Run the unit tests on a fresh clone

```sh
npm ci --ignore-scripts
npm test
```

No env file and no Mapbox token are needed, and zero tests run counts as a failure
(SPEC R7 and R8; the `test` script is in [`package.json`](package.json)).

## Rules

- A new dependency needs the maintainer first. CI installs with `npm ci --ignore-scripts`.
- Never commit a secret or a real person's details. Use made up data.
- Public text (README, docs, UI strings) has no em dashes and no en dashes (SPEC R16).
- Report security problems privately: see [SECURITY.md](SECURITY.md).
