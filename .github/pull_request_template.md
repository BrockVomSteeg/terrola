## What this changes

<!-- A few lines: what and why. -->

## Checklist

The rules are in `CONTRIBUTING.md`.

- [ ] One lane, one branch (`lane/<name>`), one pull request.
- [ ] It touches only files its lane owns in `LANES.json`.
- [ ] New unit tests live under `tests/unit/<lane>/`.
- [ ] Protected files (the spec, the gates, the workflows, the licence) changed only with the maintainer's review.
- [ ] No new dependency, or the maintainer said yes first.
- [ ] No secret and no real person's details. Made up data only.
- [ ] Public text (README, docs, UI strings) has no em dashes and no en dashes.
- [ ] `npm ci --ignore-scripts` and `npm test` pass with no env file and no Mapbox token.

Security problems are reported privately, not here: see `SECURITY.md`.
