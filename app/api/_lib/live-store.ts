// The live store: the Supabase side of the Store contract (SPEC R17). It checks the
// caller itself before it hands anything out: a valid session for data, the cron
// secret for the ping (live-access.ts). The proxy has already checked; this is the
// second gate, so a request that slips past the proxy still reaches nothing.
//
// The gate never opens or calls this store in a demo. The module itself can still be
// loaded there, because the photo route imports two helpers from it for its write
// handlers; loading it connects to nothing (the database client is made on first
// use, and a demo has no credentials to make it with).
//
// Only the read half is here so far. The write handlers still call the database
// directly, after the proxy and the write token check; they move behind this store
// next.
//
// The four photo helpers below (storedPhotos, rebuildPhotos,
// maybePersistRefreshedPhotos, persistPhotos) were moved, unchanged, out of
// app/api/locations/[id]/photo/route.ts.
import {
  getSupabaseAdmin,
  freshenCoverUrls,
  resolvePhotoOrder,
  signPhotoFiles,
  signThumbsForFiles,
  signCardsForFiles,
  seedPhotoUrlCache,
} from "@/lib/supabase-server";
import { attachCoverLqip, photoFilename } from "@/lib/photos";
import { filterLiveLocations } from "@/lib/locations";
import {
  ok,
  refused,
  type Credential,
  type ReadStore,
  type StoreResult,
} from "@/lib/demo/store";
import type { Location } from "@/types";
import { identify, storeFor } from "./live-access";

type Env = Record<string, string | undefined>;

/** Read the persisted (signed-URL) `photos` array for a location. */
async function storedPhotos(id: string): Promise<string[] | null> {
  const { data } = await getSupabaseAdmin()
    .from("locations")
    .select("photos")
    .eq("id", id)
    .single();
  return (data?.photos as string[] | null) ?? null;
}

/**
 * Recompute the authoritative ordered+signed photo list for a location.
 * `ensureName` forces a just-uploaded object into the result even if the
 * storage list hasn't caught up yet (eventual-consistency guard). Also returns
 * the raw persisted `photos` array so callers can tell whether anything
 * actually changed. Still-fresh persisted URLs are REUSED byte-identical
 * (seeded into the signing cache) so an unchanged photo never rotates its
 * `?token=` — that stability is what lets the browser HTTP cache hit.
 */
export async function rebuildPhotos(
  id: string,
  ensureName?: string,
): Promise<{
  photo_url: string | null;
  photos: string[];
  thumbs: string[];
  cards: string[];
  stored: string[];
}> {
  const stored = (await storedPhotos(id)) ?? [];
  seedPhotoUrlCache(stored);
  const order = await resolvePhotoOrder(id, stored);
  if (ensureName && !order.includes(ensureName)) order.push(ensureName);
  const photos = await signPhotoFiles(order);
  // Sign thumbs + card-tier images for exactly the photos that signed
  // (signPhotoFiles drops any that fail), so thumbs[i] / cards[i] always
  // correspond to photos[i]. An entry is "" if that photo has no thumbnail /
  // card image yet — the client falls back to the full photo.
  const signedNames = photos
    .map((u) => photoFilename(u))
    .filter((n): n is string => !!n);
  const thumbs = await signThumbsForFiles(signedNames);
  const cards = await signCardsForFiles(signedNames);
  return { photo_url: photos[0] ?? null, photos, thumbs, cards, stored };
}

/**
 * Fire-and-forget persist from the READ path: when a GET had to re-sign
 * near-expiry URLs, write the refreshed strings back so the long-TTL tokens
 * survive across serverless instances instead of rotating again on the next
 * cold read.
 *
 * STRICTLY a pure re-sign: it persists ONLY when the rebuilt list references
 * EXACTLY the same photo set as the stored one (URL strings may differ, the
 * object names may not — in either direction). A read must never change photo
 * MEMBERSHIP in the DB: a transiently flaky storage LIST must not erase a
 * photo, and a stale LIST during a concurrent delete must not resurrect one.
 * Membership changes (uploads, deletes, self-heal appends) persist only
 * through the explicit write paths (POST/DELETE/PATCH).
 */
function maybePersistRefreshedPhotos(
  id: string,
  stored: string[],
  photo_url: string | null,
  photos: string[],
): void {
  if (!photos.length) return;
  const changed =
    photos.length !== stored.length || photos.some((u, i) => u !== stored[i]);
  if (!changed) return;
  const storedNames = new Set(
    stored.map((e) => photoFilename(e)).filter((n): n is string => !!n),
  );
  const rebuiltNames = new Set(
    photos.map((u) => photoFilename(u)).filter((n): n is string => !!n),
  );
  if (storedNames.size !== rebuiltNames.size) return; // membership changed → skip
  for (const name of rebuiltNames) {
    if (!storedNames.has(name)) return; // membership changed → skip
  }
  void getSupabaseAdmin()
    .from("locations")
    .update({ photo_url, photos })
    .eq("id", id)
    .then(
      ({ error }) => {
        if (error && process.env.NODE_ENV !== "production")
          console.warn(
            "[app] photo URL refresh persist failed:",
            error.message,
          );
      },
      () => {},
    );
}

/** Persist photo_url + photos with one retry (DB transient-error tolerance). */
export async function persistPhotos(
  id: string,
  photo_url: string | null,
  photos: string[],
): Promise<boolean> {
  const { error } = await getSupabaseAdmin()
    .from("locations")
    .update({ photo_url, photos })
    .eq("id", id);
  if (!error) return true;
  await new Promise((r) => setTimeout(r, 1000));
  const { error: retryError } = await getSupabaseAdmin()
    .from("locations")
    .update({ photo_url, photos })
    .eq("id", id);
  return !retryError;
}

// The reads, as the route handlers did them before. A method never throws: a missing
// credential for the database or a network failure is answered as `failed`.
const reads: Pick<ReadStore, "listLocations" | "getLocation" | "listPhotos"> = {
  async listLocations() {
    try {
      const { data, error } = await getSupabaseAdmin()
        .from("locations")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("[app] Supabase GET error:", error);
        return refused("failed");
      }

      // Keep test/null-island rows off the LIVE app (production only): a crashed local
      // write-test can leave an orphaned `[0,0]` `__pw...__` row in the database, and
      // this is the authoritative guarantee the live app never serves it on ANY
      // surface. No-op in dev so the local write-suite still sees its own rows.
      const live = filterLiveLocations((data ?? []) as Location[]);

      // Ensure cover URLs are valid AND stable: a still-fresh persisted signed URL
      // is reused byte-identical (browser cache hit across polls and sessions);
      // only near-expiry covers are re-signed (long TTL) and persisted back. Also
      // attaches each cover's `photo_thumb_url`/`photo_card_url` derivatives.
      const freshened = await freshenCoverUrls(live);

      // Attach the cover's LQIP placeholder inline (zero extra requests). GATED:
      // a no-op until the `photo_lqips` column exists (see attachCoverLqip).
      return ok(attachCoverLqip(freshened));
    } catch {
      return refused("failed");
    }
  },

  async getLocation(id) {
    try {
      const { data, error } = await getSupabaseAdmin()
        .from("locations")
        .select("*")
        .eq("id", id)
        .single();

      if (error || !data) {
        if (error?.code === "PGRST116") return refused("not_found");
        if (process.env.NODE_ENV !== "production")
          console.error("[app] Supabase GET-by-id error:", error);
        return refused("failed");
      }
      return ok(data as Location);
    } catch {
      return refused("failed");
    }
  },

  async listPhotos(id) {
    try {
      const { photo_url, photos, thumbs, cards, stored } = await rebuildPhotos(id);
      // If the read had to re-sign (near-expiry) or self-healed an unregistered
      // upload, persist the refreshed URLs so the long-TTL tokens survive across
      // serverless instances (additive-safe; see maybePersistRefreshedPhotos).
      maybePersistRefreshedPhotos(id, stored, photo_url, photos);
      return ok({ photos, thumbs, cards });
    } catch {
      return refused("failed");
    }
  },
};

/** Touches the database. Reports only whether that worked, never why not. */
async function ping(): Promise<StoreResult<null>> {
  try {
    const { error } = await getSupabaseAdmin()
      .from("locations")
      .select("id", { count: "exact", head: true });
    return error ? refused("failed") : ok(null);
  } catch {
    return refused("failed");
  }
}

/**
 * The live store for one caller, or `unauthorized`. Who the caller is and what it may
 * use is decided in live-access.ts. Nothing touches the database before that.
 */
export async function openLiveStore(
  credential: Credential,
  env: Env = process.env,
): Promise<StoreResult<ReadStore>> {
  const caller = await identify(credential, env);
  if (!caller) return refused("unauthorized");
  return ok(storeFor(caller, { ...reads, ping }));
}
