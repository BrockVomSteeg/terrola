# SPEC

Wave 1: the map only. This file says what "done" means. Every rule below is checked by a gate
(`scripts/gates/`) or by CI, never by the author of the change.

## 1. What this is

A private, shared map for a small group. Pin places, add photos and notes, see them on a warm,
hand-drawn style map. Self-hostable on Next.js, Supabase and Mapbox, with an open read-only demo
on made-up data. MIT licensed. A portfolio project.

## 2. Scope

In wave 1: map, pins, categories and filter, photo upload, reframe, lightbox, timeline, a
password gate for self-hosting, demo mode, an installable web app, tests a stranger can run,
docs, CI and security gates.

Out until wave 2: illustrated keepsake scenes, weather and tide facts, real user accounts,
native apps, payments, ads, third party error reporting or analytics.

## 3. Rules that always hold

| id | rule | checked by |
|----|------|------------|
| R1 | No secrets in the tree or history. | gitleaks, full history |
| R2 | No personal strings in tracked files, file names or commit messages. The pattern list lives outside git. | `scripts/gates/personal-strings.mjs` |
| R3 | Demo never touches real data: demo mode refuses to start when any live variable is present (`SUPABASE_SERVICE_KEY`, `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SITE_PASSWORD_HASH`, `SESSION_SECRET`). The check runs at build, at boot (`instrumentation.ts`) and per request. `/map` and every data route render per request, never from a build time copy. | unit tests on `lib/mode.ts`; build check that the prerender manifest has no `/map` |
| R4 | The public demo is read only: the proxy runs on every path except static files; in `demo-readonly` any method other than GET, HEAD or OPTIONS gets 403 `demo_read_only` first, including `/api/auth` and page paths (server actions). The fake store also refuses writes, as an error result and never a thrown error. GET handlers never write in demo. | `tests/unit/proxy-matrix` (every route, every method, every mode) |
| R17 | Data layer gate: every database or storage access goes through `getStore()`, which returns the fake store in demo mode and verifies the session cookie in live mode. The proxy is never the only gate. | spies proving no Supabase client and no network call exist in demo mode |
| R18 | Session key: `SESSION_SECRET` (32 or more characters) is the only signing key. Missing or short fails closed in every environment. The auth route checks the key before it checks the password. | `tests/unit/session-key` |
| R19 | Keep-alive needs a cron secret and returns no error text. | `tests/unit/keep-alive` |
| R5 | One identity: name, slug, tagline live in `lib/brand.ts`. Renaming is that file, `package.json` and `scripts/rename-project.mjs`. | `scripts/gates/brand.mjs` |
| R6 | Licences: production dependencies are MIT, ISC, BSD, Apache-2.0, 0BSD, BlueOak, CC0, CC-BY-4.0 data. LGPL only for an optional binary (sharp-libvips). MPL-2.0 and FSL-1.1 dev only. Mapbox GL JS is a named exception. `THIRD_PARTY_NOTICES.md` is generated. | `scripts/gates/licenses.mjs` |
| R7 | Supply chain: CI installs with `npm ci --ignore-scripts`; a lockfile diff lists every added package and a new dependency needs owner approval; actions pinned by SHA; workflows use least privilege; no `pull_request_target`. | CI |
| R8 | Cold clone: `git clone`, `npm ci`, `npm test` pass with no env file and no Mapbox token. Zero tests run is a failure. | `cold-clone` job |
| R9 | Provenance: every file in `public/` is listed in `docs/ASSETS.md` with source and licence. | `scripts/gates/provenance.mjs` |
| R10 | Ownership: every file has one owner lane (`LANES.json`). A lane PR touches only its files. Gates, workflows, `CLAUDE.md`, `SPEC.md`, `LANES.json` and `CODEOWNERS` change only with owner review. | `scripts/gates/lane-ownership.mjs`, CODEOWNERS |
| R11 | Mapbox terms: the logo and attribution are never hidden, dimmed or scaled below legible. | `scripts/gates/brand.mjs` |
| R12 | Privacy: no analytics, no session replay, no third party error reporting. `PRIVACY.md` names Mapbox and hosting logs. | review |
| R13 | Accessibility: text contrast meets WCAG AA. Lighthouse accessibility and best practices at least 90 on the demo, performance at least 70 on the mobile preset, reasons written in `docs/`. | Lighthouse job |
| R14 | First screen: a stranger sees a working map (demo) or a clear setup screen (no token). Never a bare error. | e2e |
| R15 | Instruction budget: auto-loaded instruction files together stay under 40,000 characters. | `scripts/gates/budget.mjs` |
| R16 | Public prose (README, docs, UI strings): no em dashes or en dashes. | `scripts/gates/prose.mjs` |

## 4. Modes

| mode | data | login | writes |
|------|------|-------|--------|
| `live` | Supabase | shared password (`SITE_PASSWORD_HASH`) | yes |
| `demo-readonly` | in-memory fixtures | none | refused (R4) |
| `demo-writable` | in-memory fixtures | none | yes, local and CI only |

`lib/mode.ts` is the only place that reads `DEMO_MODE`. The fake store and the login bypass
both ask it; there is no second switch. `demo-writable` is allowed only under the dev server
or `NODE_ENV=test`. See `docs/adr/0001-access-control.md`.

## 5. Lanes (after the first commit)

| lane | owns | done when |
|------|------|-----------|
| access | `proxy.ts`, `instrumentation.ts`, `scripts/check-env.mjs`, `lib/session.ts`, `lib/identity.ts`, `lib/auth.ts`, `lib/members.ts`, `lib/mode.ts`, `lib/supabase-server.ts`, `lib/demo/**`, `public/demo/**`, `app/api/**`, `app/page.tsx`, `app/map/page.tsx`, `components/UI/DemoBanner.tsx`, `components/UI/PasswordGate.tsx`, write controls in `components/Map/**`, `types/**`, `supabase/**` | R3, R4, R14. A stranger opens the demo and sees a populated map with no login. |
| tests | `tests/**`, `playwright*.config.ts`, `scripts/run-tests.mjs` | R8. Two tiers: offline unit, and demo e2e with `api.mapbox.com` stubbed. |
| docs | `README.md`, `SECURITY.md`, `PRIVACY.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, `docs/**` | A stranger can run it in five minutes from the README. |
| ci | `.github/**`, `package.json`, `package-lock.json`, `vercel.json`, `next.config.ts`, `tsconfig.json`, lint config, `scripts/gates/**` | R1, R6, R7, R10, R15 run in CI. Lint exists. |
| brand | `lib/brand.ts`, `app/layout.tsx`, `app/globals.css`, `app/global-error.tsx`, `public/manifest.json`, `public/icon*`, `lib/constants.ts` | R5, R11, R13, R16. |

Only the `ci` lane edits `package.json` and `package-lock.json`. Dependabot is paused for npm
during the build wave.

## 6. Merge protocol

One lane, one branch (`lane/<name>`), one PR at a time per lane. A PR merges (squash) only when
the required checks are green on its head commit and an independent reviewer (a different model
from the author, fresh context) has no open blocker. The orchestrator verifies check results by
tool call; a report without a commit SHA and a run URL does not count. Merge order: access,
brand, tests, docs, ci. Rebase on `main` before merge.

## 7. Publishing

The working repository stays private. Publishing means pushing one squashed snapshot to a new
public repository after every gate is green and PR text, workflow logs and artifacts have been
scanned. The owner decides when.

## 8. Autonomy

See `CLAUDE.md`. The owner approved the contract on 2026-10-11. A demo login bypass and any
change to session or password handling are auth design changes and need owner approval first.

## 9. Public face

Owner guidance, 2026-10-11. No gate checks this section; the independent review in section 6 does.

Purpose: a free, open source portfolio project on the owner's public GitHub profile that shows
careful, tested work: production practices, each with evidence. There is no money model for now.
Ads, payments, paid tiers and sponsor links need the owner first (`CLAUDE.md`).

- Shape: the public repository (section 7) is the front door. No separate website. The demo is
  open and read only, on made up data. Hosting is free on Vercel Hobby; Mapbox is metered past its
  free allowance, so the owner restricts its token to the demo address and sets a usage alert. A
  custom domain is optional and the owner's call.
- A visitor can verify within 30 seconds that it works (the demo), that its tests and security
  checks are visible and pass in CI, and how it was built (plan first, checks as code, AI agents
  directed, independent review).
- README order: the one line pitch (`tagline` in `lib/brand.ts`), then the demo link, then a
  picture or short screen video, a proof table (each claim and the file or check that shows it),
  numbers, run it yourself, what was refused and why (features and dependencies, for example
  analytics, ads and accounts), how it was built, credits, licence. A claim with no proof does
  not go in.
- Numbers: counted by the docs lane from CI output (test count, number of gates, the R13
  Lighthouse scores). No workflow writes `README.md` (R10). Proof links point to files in the
  repository or, after publishing, to the public repository's own checks.
- Picture or video: made from the demo (made up data) by a CI Playwright run or by the owner,
  never from a live instance. It lives under `docs/` (docs lane); anything under `public/` is
  listed in `docs/ASSETS.md` (R9).
- Footer line: if the README links to the owner's other work, the owner supplies the exact line.
  Plain text in `README.md` only, never in the demo UI, `lib/brand.ts` or the manifest.
- Licence: MIT. Only the owner changes `LICENSE`, and only before the public snapshot is pushed.
