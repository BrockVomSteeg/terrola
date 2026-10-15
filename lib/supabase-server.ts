import "server-only";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  photoFilename,
  thumbName,
  isThumbName,
  cardName,
  isCardName,
  signedUrlExpiryMs,
  isFreshSignedUrl,
} from "./photos";

let cached: SupabaseClient | null = null;

/**
 * Server-only Supabase admin client (service_role key, bypasses RLS).
 *
 * Hard guarded by `import "server-only"` — any accidental import from a
 * Client Component will fail the Next.js build before reaching production.
 *
 * The browser must NEVER receive this client; all data operations from the
 * frontend go through `/api/*` routes which use this client server-side.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase server credentials missing — SUPABASE_URL and SUPABASE_SERVICE_KEY required",
    );
  }

  cached = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return cached;
}

const PHOTO_BUCKET = "location-photos";

// ───────────────────────────────────────────────────────────────────────────
// Signed READ URLs — long TTL, REUSED until near expiry.
//
// Photo bytes are immutable per object name (names are `<id>-<timestamp>.*`,
// never reused; a re-upload mints a new name), and every upload PUT sets
// `cache-control: public, max-age=31536000, immutable`. The browser caches an
// image by its EXACT URL string, so that header only pays off if the server
// hands out the SAME signed URL on every read. Re-signing on every read would
// rotate `?token=` per request and defeat all HTTP caching, which drives
// storage egress.
//
// Reuse works in two layers:
//   1. DB-persisted URLs (`photo_url`, `photos[]`) are REUSED as-is while they
//     have >RESIGN_THRESHOLD_MS of TTL left — durable across serverless
//     instances. Rotated covers are persisted back compare-and-swap style.
//   2. A module-level cache keyed by object name covers everything else
//     (thumb/card derivatives have no DB column) — stable per warm instance.
//
// Security note: a leaked URL stays valid for up to 30 days. Accepted for this
// private bucket behind a cookie gated app: the API that exposes URLs is
// auth-gated and error reporting must not log signed-URL query strings.
// Deletion is unaffected (a deleted object 404s regardless of token validity).
// ───────────────────────────────────────────────────────────────────────────
const SIGNED_READ_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const RESIGN_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // re-sign when <3d left
const MISSING_DERIVATIVE_RETRY_MS = 6 * 60 * 60 * 1000; // negative-cache 6h

/** name → { url, expMs }. `url: ""` = known-missing derivative (negative). */
const signedUrlCache = new Map<string, { url: string; expMs: number }>();

/** Pull the stable storage object path out of a signed URL (`…/location-photos/<path>?token=…`). */
function storagePathFromSignedUrl(
  signedUrl: string | null | undefined,
): string | null {
  if (!signedUrl) return null;
  const afterBucket = signedUrl.split(`/${PHOTO_BUCKET}/`)[1];
  if (!afterBucket) return null;
  return afterBucket.split("?")[0] || null;
}

/**
 * Seed the reuse cache from SERVER-PERSISTED signed URLs (the `photo_url` /
 * `photos[]` columns, which only server code writes). Still-fresh URLs are
 * adopted so even a cold serverless instance serves the same strings it
 * persisted before. NEVER seed this from client-supplied input — a forged
 * URL planted here would be served to every subsequent reader.
 */
function seedSignedUrlCache(
  urls: ReadonlyArray<string | null | undefined>,
): void {
  const now = Date.now();
  for (const url of urls) {
    if (!url) continue;
    const name = storagePathFromSignedUrl(url);
    if (!name) continue;
    const expMs = signedUrlExpiryMs(url);
    if (expMs === null || expMs - now <= RESIGN_THRESHOLD_MS) continue;
    const existing = signedUrlCache.get(name);
    if (existing && existing.expMs >= expMs) continue;
    signedUrlCache.set(name, { url, expMs });
  }
}

/**
 * Resolve signed READ URLs for object names, cache-first: a name whose cached
 * URL still has >RESIGN_THRESHOLD_MS of TTL is returned as-is (byte-identical
 * string, zero signing calls); only the misses get ONE batched
 * `createSignedUrls` at the long TTL. Missing DERIVATIVES (`.thumb`/`.card`
 * that were never generated) are negative-cached briefly so they don't trigger
 * a signing attempt on every read; missing FULL photos are NOT negative-cached
 * (a just-uploaded object must never be suppressed by a transient race).
 * Returns only names that resolved — absent = missing/failed (caller falls
 * back). Never throws.
 */
async function signObjectUrls(names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const misses: string[] = [];
  const now = Date.now();
  for (const name of Array.from(new Set(names))) {
    const hit = signedUrlCache.get(name);
    if (hit && hit.expMs - now > RESIGN_THRESHOLD_MS) {
      if (hit.url) out.set(name, hit.url);
      continue; // "" = known-missing derivative → stays absent from `out`
    }
    misses.push(name);
  }
  if (!misses.length) return out;
  try {
    const { data: signed, error } = await getSupabaseAdmin()
      .storage.from(PHOTO_BUCKET)
      .createSignedUrls(misses, SIGNED_READ_TTL_SECONDS);
    if (error || !signed) return out;
    // Unbounded-growth guard (names are finite in practice; belt only).
    if (signedUrlCache.size > 5000) signedUrlCache.clear();
    // The API returns results in input order; entries for missing objects have
    // a null signedUrl (and may omit `path`), so align by index when lengths
    // match and fall back to path-keying otherwise.
    const byIndex = signed.length === misses.length;
    const byPath = new Map<string, string>();
    signed.forEach((s) => {
      if (s.path && s.signedUrl) byPath.set(s.path, s.signedUrl);
    });
    misses.forEach((name, i) => {
      const url = byIndex ? (signed[i]?.signedUrl ?? null) : byPath.get(name);
      if (url) {
        const expMs =
          signedUrlExpiryMs(url) ?? now + SIGNED_READ_TTL_SECONDS * 1000;
        signedUrlCache.set(name, { url, expMs });
        out.set(name, url);
      } else if (isThumbName(name) || isCardName(name)) {
        signedUrlCache.set(name, {
          url: "",
          expMs: now + RESIGN_THRESHOLD_MS + MISSING_DERIVATIVE_RETRY_MS,
        });
      }
    });
  } catch {
    // Serve whatever the cache had; callers fall back for the rest.
  }
  return out;
}

/**
 * Fire-and-forget compare-and-swap: persist a re-signed cover URL back to its
 * row so the long-TTL token survives across serverless instances. The
 * `.eq("photo_url", previousUrl)` guard makes it a no-op if the cover changed
 * between our read and this write (never clobbers a concurrent edit — worst
 * case the fresh token simply isn't persisted and the next read re-signs).
 */
function persistRotatedCoverUrl(
  id: string,
  previousUrl: string,
  freshUrl: string,
): void {
  void getSupabaseAdmin()
    .from("locations")
    .update({ photo_url: freshUrl })
    .eq("id", id)
    .eq("photo_url", previousUrl)
    .then(
      ({ error }) => {
        if (error && process.env.NODE_ENV !== "production")
          console.warn("[app] cover URL persist failed:", error.message);
      },
      () => {},
    );
}

/**
 * Ensure each location's cover (`photo_url`) + its `.thumb`/`.card` derivative
 * URLs are valid AND stable: a still-fresh persisted URL is reused
 * byte-identical (browser cache hit); only covers within RESIGN_THRESHOLD_MS
 * of expiry (or short-TTL/unparseable URLs) are re-signed — then
 * persisted back CAS-style so the rotation is once per ~27 days per cover, not
 * once per read. Derivatives (no DB column) reuse via the instance cache.
 * A derivative that doesn't exist signs to "" and the client falls back to the
 * full cover. Falls back to the original rows on any storage error — never
 * throws into the response.
 */
export async function freshenCoverUrls<
  T extends {
    id: string;
    photo_url?: string | null;
    photo_thumb_url?: string | null;
    photo_card_url?: string | null;
  },
>(locations: T[]): Promise<T[]> {
  try {
    seedSignedUrlCache(locations.map((l) => l.photo_url));
    const coverPaths = Array.from(
      new Set(
        locations
          .map((l) => storagePathFromSignedUrl(l.photo_url))
          .filter((p): p is string => !!p),
      ),
    );
    if (coverPaths.length === 0) return locations;

    const urls = await signObjectUrls([
      ...coverPaths,
      ...coverPaths.map((p) => thumbName(p)),
      ...coverPaths.map((p) => cardName(p)),
    ]);

    return locations.map((l) => {
      const path = storagePathFromSignedUrl(l.photo_url);
      if (!path) return l;
      const fresh = urls.get(path);
      const freshThumb = urls.get(thumbName(path));
      const freshCard = urls.get(cardName(path));
      if (fresh && l.photo_url && fresh !== l.photo_url) {
        persistRotatedCoverUrl(l.id, l.photo_url, fresh);
      }
      return {
        ...l,
        ...(fresh ? { photo_url: fresh } : {}),
        photo_thumb_url: freshThumb ?? "",
        photo_card_url: freshCard ?? "",
      } as T;
    });
  } catch {
    return locations;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Photo read path — the `photos` column is the AUTHORITATIVE display order.
//
// Storage is consulted only for EXISTENCE: an object listed in `photos` that no
// longer exists is dropped; an object in storage not yet in `photos` is appended
// (alphabetically). There is deliberately NO global alphabetical re-sort:
// regenerating the list by filename on every read would make a reorder
// impossible to persist. The stored entries are signed URLs, but the stable
// object NAME (via `photoFilename`) is what orders + de-dupes them.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Storage object names for a location, in stable alphabetical order. Used ONLY
 * as the existence set and the append order — never as the display order.
 *
 * Throws when storage answers with an error. A failed listing must never read
 * as "no photos": a caller would save or show an empty photo list. Every caller
 * runs inside a store method, which answers a throw as `failed`.
 */
export async function listLocationPhotoFiles(id: string): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .storage.from(PHOTO_BUCKET)
    .list("", { search: id, limit: 200 });
  if (error) throw new Error("storage listing failed");
  if (!data?.length) return [];
  return (
    data
      // Real photos only — derivatives (`<object>.thumb`, `<object>.card`) live
      // in the same namespace but must never be treated as a photo in the
      // order/existence set.
      .filter(
        (f) =>
          f.name.startsWith(id + "-") &&
          !isThumbName(f.name) &&
          !isCardName(f.name),
      )
      .map((f) => f.name)
      .sort((a, b) => a.localeCompare(b))
  );
}

/**
 * Every storage object for a location INCLUDING thumbnails — used by the delete
 * cleanup so a removed location leaves no orphaned `.thumb` objects behind.
 *
 * Throws when storage answers with an error, like listLocationPhotoFiles. The
 * delete cleanup catches it, logs it and still removes the files it knows of.
 */
export async function listAllLocationObjects(id: string): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .storage.from(PHOTO_BUCKET)
    .list("", { search: id, limit: 200 });
  if (error) throw new Error("storage listing failed");
  if (!data?.length) return [];
  return data.filter((f) => f.name.startsWith(id + "-")).map((f) => f.name);
}

/**
 * Sign the THUMBNAIL read URL for each given photo object name, preserving the
 * input order. A thumbnail that doesn't exist (un-backfilled) yields "" at its
 * index, so `thumbs[i]` always lines up with `photos[i]`; the client falls back
 * to the full photo for any empty entry. Cache-first (see signObjectUrls) so an
 * unchanged thumbnail keeps its byte-identical URL across reads.
 */
export async function signThumbsForFiles(
  filenames: string[],
): Promise<string[]> {
  if (!filenames.length) return [];
  const urls = await signObjectUrls(filenames.map((n) => thumbName(n)));
  return filenames.map((n) => urls.get(thumbName(n)) ?? "");
}

/**
 * Sign the CARD-TIER read URL for each given photo object name, preserving the
 * input order. A card image that doesn't exist (un-backfilled) yields "" at its
 * index, so `cards[i]` always lines up with `photos[i]`; the client falls back
 * to the full photo for any empty entry. Mirrors `signThumbsForFiles`.
 */
export async function signCardsForFiles(
  filenames: string[],
): Promise<string[]> {
  if (!filenames.length) return [];
  const urls = await signObjectUrls(filenames.map((n) => cardName(n)));
  return filenames.map((n) => urls.get(cardName(n)) ?? "");
}

/**
 * Resolve the authoritative ordered list of storage object names: honor the
 * persisted order, drop objects that no longer exist, append new ones (alpha).
 */
export async function resolvePhotoOrder(
  id: string,
  storedPhotos: string[] | null | undefined,
): Promise<string[]> {
  const existing = await listLocationPhotoFiles(id);
  const existingSet = new Set(existing);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const entry of storedPhotos ?? []) {
    const name = photoFilename(entry);
    if (name && existingSet.has(name) && !seen.has(name)) {
      ordered.push(name);
      seen.add(name);
    }
  }
  for (const name of existing) {
    if (!seen.has(name)) {
      ordered.push(name);
      seen.add(name);
    }
  }
  return ordered;
}

/**
 * Sign an ordered list of object names into READ URLs (long TTL, reused until
 * near expiry — see signObjectUrls), preserving order. Objects that fail to
 * sign are dropped. Callers that hold the row's persisted `photos[]` should
 * `seedPhotoUrlCache` first so unchanged photos keep byte-identical URLs.
 */
export async function signPhotoFiles(filenames: string[]): Promise<string[]> {
  if (!filenames.length) return [];
  const urls = await signObjectUrls(filenames);
  return filenames
    .map((name) => urls.get(name))
    .filter((u): u is string => !!u);
}

/**
 * Seed the signed-URL reuse cache from a row's SERVER-PERSISTED `photos[]` /
 * `photo_url` values (still-fresh entries only). Callers on the photo read
 * path use this before signing so unchanged photos are served the exact URL
 * strings already persisted — the browser cache then hits instead of
 * re-downloading. NEVER call this with client-supplied strings.
 */
export function seedPhotoUrlCache(
  urls: ReadonlyArray<string | null | undefined>,
): void {
  seedSignedUrlCache(urls);
}

/**
 * Canonical photo read: resolve authoritative order from the persisted `photos`
 * column reconciled with storage, then sign in order. Returns ordered signed
 * READ URLs (reusing the still-fresh persisted URLs via the seed above).
 */
export async function orderedSignedPhotos(
  id: string,
  storedPhotos: string[] | null | undefined,
): Promise<string[]> {
  seedSignedUrlCache(storedPhotos ?? []);
  const order = await resolvePhotoOrder(id, storedPhotos);
  return signPhotoFiles(order);
}
