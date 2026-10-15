# Changelog

## 0.2.0 (2026-10-15)

- Licensed under MIT or Apache-2.0, at your option, as the Rust project does. Release 0.1.0
  stays MIT: [PR 50](../../../pull/50).
- Six more demo places in Kyoto, each with a free public domain photo taken there, so the map
  shows one busy area as well as places around the world (eighteen in all):
  [PR 53](../../../pull/53).
- A roadmap of ideas for later: [PR 51](../../../pull/51).
- The README picture shows the new demo, and the map opens with every pin in view:
  [PR 49](../../../pull/49).
- The live demo checks no longer pass a commit from one job to the next, which cleared three
  code scanning alerts: [PR 52](../../../pull/52).
- The public demo's speed limit, and what it does not cover: [PR 54](../../../pull/54),
  [PR 55](../../../pull/55).
- Patched versions of two packages the speed check tool uses: [PR 56](../../../pull/56).
- Dependency updates: [PR 2](../../../pull/2), [PR 3](../../../pull/3),
  [PR 38](../../../pull/38).

## 0.1.0 (2026-10-15)

The map and the access rules:

- The map application and the spec: [PR 1](../../../pull/1).
- Mode rules, a session key that fails closed, and a proxy that refuses unlisted paths: [PR 8](../../../pull/8), [PR 10](../../../pull/10).
- Login order and limits, and a keep-alive secret: [PR 9](../../../pull/9).
- A write token tied to the session: [PR 12](../../../pull/12).
- The Store contract and the demo's in-memory store: [PR 14](../../../pull/14).
- One data gate that every read, place write and photo write goes through: [PR 18](../../../pull/18), [PR 37](../../../pull/37), [PR 39](../../../pull/39).
- A storage failure is a failure, never an empty photo list: [PR 42](../../../pull/42).

The demo:

- The demo screen offers nothing it cannot do: [PR 21](../../../pull/21).
- Twelve demo pictures drawn in code: [PR 30](../../../pull/30), [PR 32](../../../pull/32). Replaced by twelve free public domain photos from around the world on a flat world map: [PR 44](../../../pull/44).
- A plain pin in the empty list and a neutral place name: [PR 24](../../../pull/24).
- The Mapbox wordmark and attribution stay visible: [PR 34](../../../pull/34), [PR 35](../../../pull/35).

Checks and the repository:

- Unit tests and gates on every pull request: [PR 7](../../../pull/7).
- A provenance gate, a cold clone job, and issue and pull request forms: [PR 40](../../../pull/40).
- Accessibility (axe) and speed (Lighthouse) checks on the live demo: [PR 43](../../../pull/43).
- Fonts kept in the repository, and a home screen icon: [PR 41](../../../pull/41).
- Cleanup of CI ignore lines and the browser suite wording: [PR 26](../../../pull/26), [PR 27](../../../pull/27).
- The example settings file: [PR 29](../../../pull/29).
- Colour contrast to WCAG AA and list rows that open from the keyboard:
  [PR 46](../../../pull/46).
- No package cache in the live demo checks, and the Mapbox licence notice:
  [PR 47](../../../pull/47).
- Fixes from the final sweep: every uploaded photo is redrawn so no location data is kept,
  exact photo names, and client fixes: [PR 48](../../../pull/48).

Docs:

- Spec and public face: [PR 6](../../../pull/6), [PR 23](../../../pull/23), [PR 28](../../../pull/28).
- Security, privacy, threat model, assets and contributing: [PR 17](../../../pull/17).
- The map description: [PR 25](../../../pull/25).
- The demo address, the pictures and the numbers: [PR 33](../../../pull/33), [PR 36](../../../pull/36).
- A fact check of the docs against the code: [PR 45](../../../pull/45).
