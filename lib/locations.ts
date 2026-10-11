/**
 * Pure, dependency-free location-safety helpers shared by client components AND
 * server routes. Intentionally NO `import "server-only"` and NO supabase import —
 * safe to pull into a Client Component or a route handler alike.
 *
 * Purpose: keep throwaway TEST rows and null-island ([0,0]) pins off the live map.
 * Write-tests create rows at `lat:0, lng:0` titled `__pw…__`; a crashed run can leave
 * them behind, and without these guards they render as a phantom cluster off west
 * Africa on a shared map.
 */

/**
 * Title prefix every local write-test uses for its throwaway rows (e.g.
 * `__pwzoom__`, `__pwcal__`). The render guard + sweep key off this — change it
 * here and in the specs together.
 */
export const TEST_LOCATION_TITLE_PREFIX = "__pw";

/**
 * Null island and its immediate surroundings — a ~55 km box of open ocean in the
 * Gulf of Guinea. No real pin is anywhere near here, so any pin
 * inside it is a leftover `[0,0]` throwaway (the coordinate tests deliberately use
 * to keep their pins "off-map"). Catches "at/near [0,0]".
 */
export function isNullIslandCoord(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) < 0.5 &&
    Math.abs(lng) < 0.5
  );
}

/** True when a row's title marks it as a local write-test throwaway. */
export function isTestLocation(loc: { title?: string | null }): boolean {
  return (
    typeof loc?.title === "string" &&
    loc.title.startsWith(TEST_LOCATION_TITLE_PREFIX)
  );
}

/** A row that should never reach the live map (test-tagged OR null-island). */
export function isPhantomLocation(loc: {
  title?: string | null;
  lat: number;
  lng: number;
}): boolean {
  return isTestLocation(loc) || isNullIslandCoord(loc.lat, loc.lng);
}

/**
 * Map-pin RENDER guard (client). A misconfigured `NODE_ENV` must never plot a test
 * pin, so test-tagged rows are dropped in EVERY environment, unconditionally.
 * Null-island coordinates are dropped only in production (kept in dev so the local
 * write-suite — whose `__pw` rows are already dropped by the test-tag rule — and a
 * developer can still inspect a raw `[0,0]` row if one ever existed).
 */
export function isHiddenFromMap(loc: {
  title?: string | null;
  lat: number;
  lng: number;
}): boolean {
  if (isTestLocation(loc)) return true;
  if (
    process.env.NODE_ENV === "production" &&
    isNullIslandCoord(loc.lat, loc.lng)
  )
    return true;
  return false;
}

/**
 * Authoritative server read-path filter. In PRODUCTION, drop every phantom row so
 * the live app never serves a test/null-island location on ANY surface (map,
 * sidebar, timeline). In dev/local it is a NO-OP so the local write-suite — which
 * runs against the dev server and selects its `__pw` rows from the sidebar — keeps
 * working. NODE_ENV is set to "production" by `next build`, so this is on for every
 * Vercel deploy with no env-var change required.
 */
export function filterLiveLocations<
  T extends { title?: string | null; lat: number; lng: number },
>(locations: T[]): T[] {
  if (process.env.NODE_ENV !== "production") return locations;
  return locations.filter((l) => !isPhantomLocation(l));
}
