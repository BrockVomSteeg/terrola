/**
 * Pure, dependency-free photo helpers shared by client components AND server
 * routes. Intentionally NO `import "server-only"` and NO supabase import — this
 * module is safe to pull into a Client Component or a route handler alike.
 *
 * The "stable object name" (e.g. `<locationId>-<timestamp>.jpg`) is the durable
 * identity for a photo: it survives URL re-signing and reordering, so it is
 * what we use to (a) key per-photo framing offsets and (b) validate ownership.
 */

const PHOTO_BUCKET = "location-photos";

/**
 * Suffix appended to a photo's stable object name to form its thumbnail object.
 * A thumbnail lives alongside its original (e.g. `id-123.jpg` → `id-123.jpg.thumb`),
 * carries its real format in the storage content-type (WebP or JPEG), and is
 * derivable from the original with no DB column. The `.thumb` suffix is also how
 * the read path tells a thumbnail apart from a real photo.
 */
export const THUMB_SUFFIX = ".thumb";

/** The thumbnail storage object name for a given photo object name. */
export function thumbName(objectName: string): string {
  return objectName + THUMB_SUFFIX;
}

/** True if a storage object name is a thumbnail rather than a real photo. */
export function isThumbName(name: string | null | undefined): boolean {
  return typeof name === "string" && name.endsWith(THUMB_SUFFIX);
}

/**
 * Suffix for a photo's CARD-tier image (`<object>.card`) — a ~1152px sharp
 * derivative the map card renders so it is crisp at DPR 3 without pulling the
 * full ~2400px original. Lives alongside the original + its `.thumb`; derivable
 * with no DB column. The card image is the "sharp" target on the card surface
 * ONLY; the timeline keeps the tiny `.thumb`, the lightbox keeps the full image.
 */
export const CARD_SUFFIX = ".card";

/** The card-tier storage object name for a given photo object name. */
export function cardName(objectName: string): string {
  return objectName + CARD_SUFFIX;
}

/** True if a storage object name is a card-tier image rather than a real photo. */
export function isCardName(name: string | null | undefined): boolean {
  return typeof name === "string" && name.endsWith(CARD_SUFFIX);
}

/**
 * Every storage object name implied by a set of photo base names: each full
 * photo PLUS its `.thumb` and `.card` derivatives. The delete cleanup uses this
 * to purge ALL three tiers for the cover AND every photo, derived from the DB's
 * KNOWN photo set — so cleanup never depends solely on a (possibly incomplete or
 * transiently failing) live storage listing.
 *
 * Each input is normalized to its real photo name first (a trailing `.thumb` /
 * `.card` is stripped) so passing a derivative by mistake can never yield a
 * double-suffixed `x.jpg.thumb.thumb`. De-duplicated; order is not significant.
 */
export function photoDerivativeNames(baseNames: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const raw of baseNames) {
    if (!raw || typeof raw !== "string") continue;
    let base = raw;
    if (isThumbName(base)) base = base.slice(0, -THUMB_SUFFIX.length);
    else if (isCardName(base)) base = base.slice(0, -CARD_SUFFIX.length);
    if (!base) continue;
    out.add(base);
    out.add(thumbName(base));
    out.add(cardName(base));
  }
  return [...out];
}

/**
 * Extract the stable storage object name from a stored `photos` entry.
 *
 * Entries are normally signed URLs (`…/location-photos/<name>?token=…`) but a
 * older row or another caller may pass a bare object name. Returns null
 * if it cannot be parsed.
 */
export function photoFilename(entry: string | null | undefined): string | null {
  if (!entry || typeof entry !== "string") return null;
  const marker = `/${PHOTO_BUCKET}/`;
  if (entry.includes(marker)) {
    const after = entry.split(marker)[1];
    const name = after ? after.split("?")[0] : "";
    return name || null;
  }
  // Already a bare object name — strip any query string defensively.
  const name = entry.split("?")[0];
  return name || null;
}

// ───────────────────────────────────────────────────────────────────────────
// Signed-URL freshness. The server signs storage READ URLs with a long TTL and
// REUSES the same URL string until it nears expiry, so the browser HTTP cache
// (primed by the immutable `cache-control` set at upload) actually hits across
// polls AND sessions instead of re-downloading on every rotated `?token=`.
// Pure + dependency-free so the server signing layer and the unit suite share
// one definition.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Expiry (ms since epoch) embedded in a Supabase signed URL's `?token=` JWT.
 * The payload is only base64url-decoded — the signature is NOT verified here
 * (Supabase verifies it on the storage GET; we only need the timestamp).
 * Returns null for anything unparseable (no token, malformed JWT, missing
 * `exp`) — callers treat null as "not fresh, sign a new one".
 */
export function signedUrlExpiryMs(
  url: string | null | undefined,
): number | null {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/[?&]token=([^&]+)/);
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/**
 * True when a signed URL still has MORE than `minRemainingMs` of its TTL left.
 * False for expired / near-expiry / unparseable URLs — so `false` always means
 * "sign a fresh one" and a malformed URL can never be served as fresh.
 */
export function isFreshSignedUrl(
  url: string | null | undefined,
  minRemainingMs: number,
  nowMs: number = Date.now(),
): boolean {
  const exp = signedUrlExpiryMs(url);
  return exp !== null && exp - nowMs > minRemainingMs;
}

/** Clamp a number into [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Per-photo zoom bounds for the reframe editor. 1 = no zoom (the plain cover
 * crop, the implicit value for every pan-only photo); MAX =
 * closest zoom-in. Shared by the client overlay, FramedPhoto, AND the PATCH
 * validator so all three agree on the allowed range.
 */
export const MIN_PHOTO_SCALE = 1;
export const MAX_PHOTO_SCALE = 3;

/**
 * Clamp a per-photo zoom into [MIN_PHOTO_SCALE, MAX_PHOTO_SCALE]. Absent or
 * non-finite → MIN (1 = no zoom), so a missing `scale` leaves a photo framed
 * with its pan-only crop (existing photos render unchanged).
 */
export function clampScale(scale: number | null | undefined): number {
  if (typeof scale !== "number" || !Number.isFinite(scale)) {
    return MIN_PHOTO_SCALE;
  }
  return Math.max(MIN_PHOTO_SCALE, Math.min(MAX_PHOTO_SCALE, scale));
}

/** Normalized per-photo framing: pan fractions in [-1, 1] plus optional zoom. */
export type PhotoOffset = { x: number; y: number; scale?: number };

/**
 * CSS `object-position` for a normalized framing offset in [-1, 1] per axis
 * (0 = centered). Resolution- and aspect-independent: the same offset crops to
 * the same relative point at any frame size. Shared by FramedPhoto (live
 * render) and ReframeOverlay (edit preview) so the two can never disagree.
 */
export function objectPositionFromOffset(
  offset?: { x: number; y: number } | null,
): string {
  if (!offset) return "center";
  const x = 50 + clamp(offset.x, -1, 1) * 50;
  const y = 50 + clamp(offset.y, -1, 1) * 50;
  return `${x}% ${y}%`;
}

/**
 * Resolve the normalized framing offset for a single photo from a
 * `photo_offsets` map, keyed by the photo's stable object name. Accepts either
 * a signed URL or a bare name. Returns null (centered) when absent or malformed.
 * `scale` is always resolved (defaulting to 1 = no zoom) so consumers never
 * have to re-default it; a pan-only `{x,y}` entry (no scale) reads as scale 1 and
 * thus renders with the plain cover crop.
 */
export function offsetForPhoto(
  photoUrlOrName: string | null | undefined,
  offsets?: Record<string, PhotoOffset> | null,
): { x: number; y: number; scale: number } | null {
  if (!offsets) return null;
  const name = photoFilename(photoUrlOrName);
  if (!name) return null;
  const o = offsets[name];
  if (!o || typeof o.x !== "number" || typeof o.y !== "number") return null;
  if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return null;
  return {
    x: clamp(o.x, -1, 1),
    y: clamp(o.y, -1, 1),
    scale: clampScale(o.scale),
  };
}

/**
 * Aspect ratio (width/height) of the card surface a photo actually lands on, so
 * the reframe editor frames the EXACT crop the card will show (object-fit:cover
 * crops by aspect ratio). A single-photo location renders its cover at height
 * 160px; a multi-photo location renders each strip slot at 200px (see
 * LocationCard). Card width is the responsive `.location-card` width: 340 on
 * desktop, 380 on tablet, viewport-32 on mobile. Clamped to a sane band so a
 * pathological viewport can't produce a degenerate frame. Shared by AdminPanel's
 * edit-mode reframe AND LocationCard's view-mode reframe so both are WYSIWYG.
 * Reads window.innerWidth — only call it client-side (both callers do).
 */
export function cardSurfaceAspect(photoCount: number): number {
  const coverH = photoCount > 1 ? 200 : 160;
  const vw =
    typeof window !== "undefined" && window.innerWidth
      ? window.innerWidth
      : 375;
  const cardW = vw >= 1024 ? 340 : vw >= 768 ? 380 : vw - 32;
  return Math.max(1, Math.min(3, cardW / coverH));
}

/**
 * Merge one photo's chosen framing into a location's `photo_offsets` map, keyed
 * by the photo's stable storage object name. Stores the MINIMAL shape: a pan-only
 * (scale 1) framing stores as `{ x, y }` — byte-identical to the pan-only format,
 * so a photo that is only repositioned never carries a redundant `scale`; only a
 * real zoom (scale > 1) keeps `scale`. Returns null if the photo name can't be
 * parsed (caller should bail). Shared by both reframe entry points.
 */
export function mergePhotoOffset(
  existing: Record<string, PhotoOffset> | null | undefined,
  photoUrlOrName: string,
  offset: { x: number; y: number; scale: number },
): Record<string, PhotoOffset> | null {
  const fn = photoFilename(photoUrlOrName);
  if (!fn) return null;
  const entry: PhotoOffset =
    offset.scale > 1
      ? { x: offset.x, y: offset.y, scale: offset.scale }
      : { x: offset.x, y: offset.y };
  return { ...(existing ?? {}), [fn]: entry };
}

/**
 * Keep cover URLs STABLE across list polls. The list route re-signs every
 * location's cover on every read (a new `?token=` each time), and since it is
 * served `no-store`, every periodic poll is a real request — so a fresh token would
 * change `location.photo_url` every cycle and force every cover <img> to reload
 * (FramedPhoto resets its decode/fade state on any `src` change → a visible
 * flicker, plus a wasted re-fetch and unbounded prefetch-set growth).
 *
 * For each freshly-polled location whose cover resolves to the SAME stable
 * storage object NAME as the one already in state, reuse the prior signed URL so
 * the string — and thus the rendered `src` — is byte-identical and nothing
 * reloads. A genuine change (added / removed / reordered cover → a different
 * object name, or a location that had no cover and now has one) takes the fresh
 * URL. Covers stay valid for their full signing TTL from when they were first
 * received; only the unguessable token differs, never the underlying object.
 *
 * Pure and dependency-free (no React, no Supabase) so it is unit-checkable and
 * safe in either a Client Component or a server route.
 */
/**
 * Attach each location's cover LQIP placeholder inline (`cover_lqip`), looked up
 * from the per-photo `photo_lqips` map by the cover's stable object name. Used by
 * both the list route and the SSR map page so the placeholder is consistent.
 *
 * FULLY gated by BOTH halves of the flag so toggling it off truly turns it off
 * (no leftover LQIPs keep rendering from a prior enabled run):
 *   1. NEXT_PUBLIC_LQIP_ENABLED=1 — the feature flag (read here server-side,
 *      mirrors lib/image-resize's LQIP_ENABLED used on the write side), and
 *   2. the row actually has `photo_lqips` (the column exists + is populated).
 * Either condition false → the location is passed through unchanged (no-op).
 */
export function attachCoverLqip<
  T extends {
    photo_url?: string | null;
    photo_lqips?: Record<string, string> | null;
    cover_lqip?: string;
  },
>(locations: T[]): T[] {
  if (process.env.NEXT_PUBLIC_LQIP_ENABLED !== "1") return locations;
  return locations.map((l) => {
    const lqips = l.photo_lqips;
    if (!lqips) return l;
    const coverName = photoFilename(l.photo_url);
    const cover_lqip = coverName ? lqips[coverName] : undefined;
    return cover_lqip ? { ...l, cover_lqip } : l;
  });
}

export function stabilizeCoverUrls<
  T extends {
    id: string;
    photo_url?: string | null;
    photo_thumb_url?: string | null;
    photo_card_url?: string | null;
  },
>(prev: T[], fresh: T[]): T[] {
  if (!prev.length) return fresh;
  const priorById = new Map(prev.map((l) => [l.id, l]));
  return fresh.map((l) => {
    const prior = priorById.get(l.id);
    if (
      prior &&
      prior.photo_url &&
      l.photo_url &&
      photoFilename(prior.photo_url) === photoFilename(l.photo_url)
    ) {
      // Same underlying cover object → reuse the prior signed cover URL AND the
      // prior signed thumbnail / card-tier URLs. Each is re-signed (fresh token)
      // on every `no-store` poll, so without this the cover THUMBNAIL (and now
      // the `.card` image) would reload every cycle, the same flicker the
      // full cover would show. A reused prior URL wins; if the prior had none but
      // the fresh one does (a just-backfilled thumb/card), take the fresh one.
      return {
        ...l,
        photo_url: prior.photo_url,
        photo_thumb_url: prior.photo_thumb_url || l.photo_thumb_url,
        photo_card_url: prior.photo_card_url || l.photo_card_url,
      };
    }
    return l;
  });
}
