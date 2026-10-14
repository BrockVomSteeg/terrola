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
// The reads and the three location writes are here. The photo write handlers still
// call the database directly, after the proxy and the write token check; they move
// behind this store next.
//
// The four photo helpers below (storedPhotos, rebuildPhotos,
// maybePersistRefreshedPhotos, persistPhotos) were moved, unchanged, out of
// app/api/locations/[id]/photo/route.ts. The location writes were moved out of
// app/api/locations/route.ts (POST) and app/api/locations/[id]/route.ts (PATCH,
// DELETE).
import {
  getSupabaseAdmin,
  freshenCoverUrls,
  resolvePhotoOrder,
  signPhotoFiles,
  signThumbsForFiles,
  signCardsForFiles,
  seedPhotoUrlCache,
  listAllLocationObjects,
} from "@/lib/supabase-server";
import {
  attachCoverLqip,
  photoFilename,
  photoDerivativeNames,
} from "@/lib/photos";
import { filterLiveLocations } from "@/lib/locations";
import {
  ok,
  refused,
  type Credential,
  type Store,
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
const reads: Pick<Store, "listLocations" | "getLocation" | "listPhotos"> = {
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

// The location writes, as the route handlers did them before. The route has already
// checked the write token, the rate limit, the id and every field. A method never
// throws: a missing credential for the database or a network failure is answered as
// `failed`.
const locationWrites: Pick<
  Store,
  "createLocation" | "updateLocation" | "deleteLocation"
> = {
  async createLocation(input) {
    try {
      const { data, error } = await getSupabaseAdmin()
        .from("locations")
        .insert({
          title: input.title,
          date_label: input.date_label,
          lat: input.lat,
          lng: input.lng,
          description: input.description,
          category: input.category,
          display_order: 0,
        })
        .select()
        .single();

      if (error) {
        console.error("[app] Supabase POST error:", error);
        return refused("failed");
      }

      return ok(data as Location);
    } catch {
      return refused("failed");
    }
  },

  async updateLocation(id, patch) {
    try {
      const { photoOrder, ...fields } = patch;
      const updates: Record<string, unknown> = { ...fields };

      // Reorder: the route has checked that every name belongs to this location.
      // Reconcile against storage existence, then re-sign server-side and set
      // cover = photos[0].
      if (photoOrder !== undefined) {
        const order = await resolvePhotoOrder(id, photoOrder);
        const signed = await signPhotoFiles(order);
        // A storage list that failed reads as "no photos" (listLocationPhotoFiles),
        // and so does a signing step that failed for every photo. A reorder names
        // at least one photo, so an empty result here is a failure, never an order:
        // saving it would erase the location's photos.
        if (signed.length === 0) return refused("failed");
        updates.photos = signed;
        updates.photo_url = signed[0] ?? null;
      }

      const { data, error } = await getSupabaseAdmin()
        .from("locations")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error || !data) {
        if (error?.code === "PGRST116") {
          return refused("not_found");
        }
        if (process.env.NODE_ENV !== "production")
          console.error("[app] Supabase PATCH error:", error);
        return refused("failed");
      }

      return ok(data as Location);
    } catch {
      return refused("failed");
    }
  },

  async deleteLocation(id) {
    try {
      // Check if it exists first — and capture its photo set NOW (before the row is
      // gone) so storage cleanup can purge derivatives from the KNOWN set even if the
      // live storage listing later fails or returns incomplete.
      const { data: existing, error: fetchError } = await getSupabaseAdmin()
        .from("locations")
        .select("id, photos, photo_url")
        .eq("id", id)
        .single();

      if (fetchError || !existing) {
        return refused("not_found");
      }

      // The row deletion is AUTHORITATIVE and happens first — it can never be
      // blocked or reverted by a storage failure (legacy/odd path shapes included).
      const { error } = await getSupabaseAdmin()
        .from("locations")
        .delete()
        .eq("id", id);

      if (error) {
        if (process.env.NODE_ENV !== "production")
          console.error("[app] Supabase DELETE error:", error);
        return refused("failed");
      }

      // Best-effort storage cleanup — the row is already gone, so any failure here
      // (missing objects, legacy paths, a transient storage error) is non-fatal and
      // must NOT change the result. Purges EVERY tier — the full `<obj>`, its
      // `<obj>.thumb`, AND its `<obj>.card` — for the cover and all photos[], so no
      // derivative is ever orphaned in the bucket.
      try {
        // Derive the object set from the DB's KNOWN photos (cover + photos[]),
        // captured above before the delete. `existing.photos` holds signed URLs;
        // photoFilename() extracts each stable object name. This is robust to a
        // flaky/empty live listing — the known set is purged regardless.
        const known = [
          ...(Array.isArray(existing.photos) ? (existing.photos as unknown[]) : []),
          existing.photo_url,
        ]
          .map((entry) => photoFilename(entry as string | null))
          .filter((n): n is string => !!n && n.startsWith(id + "-"));
        const derived = photoDerivativeNames(known);

        // UNION with whatever is actually under this id's prefix in storage — catches
        // a photo whose bytes reached storage but whose registration never persisted
        // it into `photos[]`. Isolated in its own try so a listing failure still
        // removes the derived (known) set.
        let listed: string[] = [];
        try {
          listed = await listAllLocationObjects(id);
        } catch (listErr) {
          // Logged in ALL envs (not dev-gated like the route's other error logs):
          // a swallowed cleanup failure leaves orphaned objects behind, so it must
          // be observable in production.
          console.warn(
            "[app] storage list during delete cleanup failed (non-fatal, possible orphan):",
            listErr,
          );
        }

        // SAFETY: only ever remove objects under THIS location's `id-` prefix, so a
        // delete can never touch another location's storage objects.
        const toRemove = Array.from(new Set([...derived, ...listed])).filter((n) =>
          n.startsWith(id + "-"),
        );
        if (toRemove.length) {
          const { error: removeErr } = await getSupabaseAdmin()
            .storage.from("location-photos")
            .remove(toRemove);
          // Logged in ALL envs — a remove failure leaves orphaned objects behind.
          if (removeErr)
            console.warn(
              "[app] storage cleanup remove failed (non-fatal, possible orphan):",
              removeErr,
            );
        }
      } catch (cleanupErr) {
        // Logged in ALL envs — the row is already gone, so this is non-fatal, but a
        // silent failure here would leave orphaned objects unnoticed.
        console.warn(
          "[app] storage cleanup after delete failed (non-fatal, possible orphan):",
          cleanupErr,
        );
      }

      return ok({ id });
    } catch {
      return refused("failed");
    }
  },
};

// The photo writes still run in their own routes (photo/route.ts, photo-url/route.ts)
// and move behind this store next. No route calls these yet, so they refuse.
const photoWritesNotMovedYet = async () => refused<never>("unsupported");

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
): Promise<StoreResult<Store>> {
  const caller = await identify(credential, env);
  if (!caller) return refused("unauthorized");
  return ok(
    storeFor(caller, {
      ...reads,
      ...locationWrites,
      createPhotoUpload: photoWritesNotMovedYet,
      registerPhoto: photoWritesNotMovedYet,
      deletePhoto: photoWritesNotMovedYet,
      ping,
    }),
  );
}
