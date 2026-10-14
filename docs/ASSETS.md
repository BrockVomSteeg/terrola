# Assets

Every file under `public/`, as listed by `git ls-files public` on 2026-10-13. SPEC R9 asks for
source and licence for each one ([`SPEC.md`](../SPEC.md)).

| file | what it is | source | licence |
|------|------------|--------|---------|
| `public/demo/location-photos/00000000-0000-4000-8000-000000000001-1700000000000.svg` | Demo picture: custard tarts and a coffee on a table by a river. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/demo/location-photos/00000000-0000-4000-8000-000000000002-1700000000000.svg` | Demo picture: two guitars in a small room. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/demo/location-photos/00000000-0000-4000-8000-000000000003-1700000000000.svg` | Demo picture: a market stall with fruit and bread. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/demo/location-photos/00000000-0000-4000-8000-000000000004-1700000000000.svg` | Demo picture: a small beach between cliffs with wooden stairs. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/demo/location-photos/00000000-0000-4000-8000-000000000005-1700000000000.svg` | Demo picture: a path along a granite ridge. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/demo/location-photos/00000000-0000-4000-8000-000000000006-1700000000000.svg` | Demo picture: old stone columns between white houses. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/demo/location-photos/00000000-0000-4000-8000-000000000007-1700000000000.svg` | Demo picture: a long table by a harbour at dusk. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/demo/location-photos/00000000-0000-4000-8000-000000000008-1700000000000.svg` | Demo picture: a surfboard standing in the sand. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/demo/location-photos/00000000-0000-4000-8000-000000000009-1700000000000.svg` | Demo picture: a small stage on wide stone steps at dusk. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/demo/location-photos/00000000-0000-4000-8000-000000000010-1700000000000.svg` | Demo picture: a round stone well among foggy trees. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/demo/location-photos/00000000-0000-4000-8000-000000000011-1700000000000.svg` | Demo picture: a painted boat on a canal by striped houses. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/demo/location-photos/00000000-0000-4000-8000-000000000012-1700000000000.svg` | Demo picture: a table under a tree above terraced vineyards. A drawing made in code, 1200 by 900, not a photograph | made for this project | MIT, with the rest of the repository |
| `public/icon-192.png` | App icon, 192 by 192 pixels, a render of `icon-192.svg` | made for this project | MIT, with the rest of the repository |
| `public/icon-192.svg` | App icon, 192 by 192, vector (one square and three circles, drawn in code in the project's colours); the source of the PNG | made for this project | MIT, with the rest of the repository |
| `public/icon-512.png` | App icon, 512 by 512 pixels, a render of `icon-512.svg` | made for this project | MIT, with the rest of the repository |
| `public/icon-512.svg` | App icon, 512 by 512, vector; the source of the PNG | made for this project | MIT, with the rest of the repository |
| `public/manifest.json` | Web app manifest: name, colours, start page and the two PNG icons | Written in this repository, owned by the brand lane ([`LANES.json`](../LANES.json)) | MIT, the repository licence (SPEC section 1) |

The twelve demo pictures are named like an uploaded photo (the place's id, then 13 digits) so the
app handles them as it handles real ones. They show no person and hold no text. A test checks
that each is a plain drawing that loads nothing
([`memory-store.spec.ts`](../tests/unit/access/memory-store.spec.ts)).

## Outside `public/`

| file | what it is | source | licence |
|------|------------|--------|---------|
| `docs/demo.jpg` | Screenshot of the hosted demo, 1360 by 757, taken on 2026-10-13. Shown in the README | made for this project; the map in it is drawn by Mapbox | The app's own parts: MIT. The map: © Mapbox, © OpenStreetMap, shown with the Mapbox wordmark and attribution button in frame |
