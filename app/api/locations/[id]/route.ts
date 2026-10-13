import { NextRequest, NextResponse } from "next/server";
import {
  getSupabaseAdmin,
  resolvePhotoOrder,
  signPhotoFiles,
  listAllLocationObjects,
} from "@/lib/supabase-server";
import {
  photoFilename,
  photoDerivativeNames,
  MIN_PHOTO_SCALE,
  MAX_PHOTO_SCALE,
} from "@/lib/photos";
import { checkCsrf } from "@/app/api/_lib/csrf";
import { checkRateLimit, RATE_LIMITS } from "@/app/api/_lib/rate-limit";
import { storeError } from "@/app/api/_lib/store-response";
import { getStore } from "@/lib/demo/gate";
import { COOKIE_NAME } from "@/lib/session";
import type { CategoryKey } from "@/types";

// Max distinct photos a location can hold (matches the 10-photo upload cap,
// with slack). Guards the reorder + offsets payloads against bloat.
const MAX_PHOTOS = 100;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CATEGORIES: CategoryKey[] = [
  "food",
  "nightout",
  "everyday",
  "beach",
  "adventure",
  "trip",
  "celebration",
  "milestone",
  "concert",
];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_REGEX.test(id)) {
    return NextResponse.json({ error: "Invalid id format" }, { status: 400 });
  }

  const store = await getStore({
    kind: "session",
    token: request.cookies.get(COOKIE_NAME)?.value,
  });
  if (!store.ok) return storeError(store.error.code, "Failed to load location");
  const found = await store.data.getLocation(id);
  if (!found.ok) return storeError(found.error.code, "Failed to load location");

  // no-store: same staleness class as the list — a CDN copy could serve a
  // just-edited/deleted row to other devices for the SWR window. Fresh-on-read.
  return NextResponse.json(found.data, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await checkCsrf(request)).ok) {
    return NextResponse.json(
      { error: "CSRF token missing or invalid" },
      { status: 403 },
    );
  }
  const rl = checkRateLimit(
    request,
    "locations:update",
    RATE_LIMITS.WRITE.limit,
    RATE_LIMITS.WRITE.windowMs,
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const { id } = await params;

  if (!UUID_REGEX.test(id)) {
    return NextResponse.json({ error: "Invalid id format" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const {
    title,
    date_label,
    description,
    category,
    lat,
    lng,
    photo_offset_x,
    photo_offset_y,
    photo_offsets,
    photo_lqips,
    photos,
  } = body as {
    title?: string;
    date_label?: string;
    description?: string;
    category?: string;
    lat?: number;
    lng?: number;
    photo_offset_x?: number;
    photo_offset_y?: number;
    photo_offsets?: unknown;
    photo_lqips?: unknown;
    photos?: unknown;
  };

  const updates: Record<string, unknown> = {};

  if (title !== undefined) {
    const sanitized = String(title).trim().slice(0, 200);
    if (!sanitized)
      return NextResponse.json(
        { error: "title cannot be empty" },
        { status: 400 },
      );
    updates.title = sanitized;
  }

  if (date_label !== undefined) {
    const sanitized = String(date_label).trim().slice(0, 50);
    if (!sanitized)
      return NextResponse.json(
        { error: "date_label cannot be empty" },
        { status: 400 },
      );
    updates.date_label = sanitized;
  }

  if (description !== undefined) {
    updates.description = String(description).trim().slice(0, 1000);
  }

  if (category !== undefined) {
    if (!VALID_CATEGORIES.includes(category as CategoryKey)) {
      return NextResponse.json({ error: "Invalid category" }, { status: 400 });
    }
    updates.category = category;
  }

  if (lat !== undefined) {
    if (typeof lat !== "number" || lat < -90 || lat > 90) {
      return NextResponse.json(
        { error: "lat must be between -90 and 90" },
        { status: 400 },
      );
    }
    updates.lat = lat;
  }

  if (lng !== undefined) {
    if (typeof lng !== "number" || lng < -180 || lng > 180) {
      return NextResponse.json(
        { error: "lng must be between -180 and 180" },
        { status: 400 },
      );
    }
    updates.lng = lng;
  }

  if (photo_offset_x !== undefined) {
    if (
      typeof photo_offset_x !== "number" ||
      !Number.isFinite(photo_offset_x) ||
      photo_offset_x < -500 ||
      photo_offset_x > 500
    ) {
      return NextResponse.json(
        {
          error: "photo_offset_x must be a finite number between -500 and 500",
        },
        { status: 400 },
      );
    }
    updates.photo_offset_x = photo_offset_x;
  }

  if (photo_offset_y !== undefined) {
    if (
      typeof photo_offset_y !== "number" ||
      !Number.isFinite(photo_offset_y) ||
      photo_offset_y < -500 ||
      photo_offset_y > 500
    ) {
      return NextResponse.json(
        {
          error: "photo_offset_y must be a finite number between -500 and 500",
        },
        { status: 400 },
      );
    }
    updates.photo_offset_y = photo_offset_y;
  }

  // Per-photo NORMALIZED framing offsets — keyed by stable storage object name,
  // values fractions in [-1, 1]. Strict shape; keys must belong to THIS location
  // (the `id-` prefix also blocks prototype-pollution keys like __proto__).
  if (photo_offsets !== undefined) {
    if (
      typeof photo_offsets !== "object" ||
      photo_offsets === null ||
      Array.isArray(photo_offsets)
    ) {
      return NextResponse.json(
        { error: "photo_offsets must be an object" },
        { status: 400 },
      );
    }
    const entries = Object.entries(photo_offsets as Record<string, unknown>);
    if (entries.length > MAX_PHOTOS) {
      return NextResponse.json(
        { error: "photo_offsets too large" },
        { status: 400 },
      );
    }
    const clean: Record<string, { x: number; y: number; scale?: number }> = {};
    for (const [key, val] of entries) {
      if (
        typeof key !== "string" ||
        key.length === 0 ||
        key.length > 256 ||
        !key.startsWith(id + "-")
      ) {
        return NextResponse.json(
          { error: "Invalid photo_offsets key" },
          { status: 400 },
        );
      }
      if (typeof val !== "object" || val === null || Array.isArray(val)) {
        return NextResponse.json(
          { error: "Invalid photo_offsets value" },
          { status: 400 },
        );
      }
      const v = val as Record<string, unknown>;
      // Accept exactly { x, y } (legacy, pan-only) or { x, y, scale }. Any other
      // shape — a missing axis, an unexpected extra key — is rejected, so the
      // stored map can only ever hold these two shapes.
      const keys = Object.keys(v);
      if (
        !("x" in v) ||
        !("y" in v) ||
        keys.length < 2 ||
        keys.length > 3 ||
        (keys.length === 3 && !("scale" in v))
      ) {
        return NextResponse.json(
          { error: "photo_offsets value must be { x, y } or { x, y, scale }" },
          { status: 400 },
        );
      }
      const { x, y } = v;
      if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < -1 ||
        x > 1 ||
        y < -1 ||
        y > 1
      ) {
        return NextResponse.json(
          { error: "photo_offsets x/y must be numbers in [-1, 1]" },
          { status: 400 },
        );
      }
      let scale: number | undefined;
      if ("scale" in v) {
        const s = v.scale;
        if (
          typeof s !== "number" ||
          !Number.isFinite(s) ||
          s < MIN_PHOTO_SCALE ||
          s > MAX_PHOTO_SCALE
        ) {
          return NextResponse.json(
            {
              error: `photo_offsets scale must be a number in [${MIN_PHOTO_SCALE}, ${MAX_PHOTO_SCALE}]`,
            },
            { status: 400 },
          );
        }
        scale = s;
      }
      // Normalize to the minimal shape: an absent OR explicit scale of 1 (no
      // zoom) stores as { x, y } — byte-identical to the legacy pan-only format —
      // so the stored map only ever holds { x, y } or { x, y, scale>1 }, and an
      // unzoomed photo is never rewritten to carry a redundant scale: 1 (even if
      // a direct API caller sends one).
      clean[key] =
        scale === undefined || scale === MIN_PHOTO_SCALE
          ? { x, y }
          : { x, y, scale };
    }
    updates.photo_offsets = clean;
  }

  // Per-photo LQIP placeholders — keyed by stable storage object name, values
  // short base64 JPEG data URIs. Same key discipline as photo_offsets (the
  // `id-` prefix blocks prototype-pollution keys). The init migration creates
  // the `photo_lqips` column; NEXT_PUBLIC_LQIP_ENABLED=1 only gates the feature
  // (the client sends this field only when it is set).
  if (photo_lqips !== undefined) {
    if (
      typeof photo_lqips !== "object" ||
      photo_lqips === null ||
      Array.isArray(photo_lqips)
    ) {
      return NextResponse.json(
        { error: "photo_lqips must be an object" },
        { status: 400 },
      );
    }
    const entries = Object.entries(photo_lqips as Record<string, unknown>);
    if (entries.length > MAX_PHOTOS) {
      return NextResponse.json(
        { error: "photo_lqips too large" },
        { status: 400 },
      );
    }
    const clean: Record<string, string> = {};
    for (const [key, val] of entries) {
      if (
        typeof key !== "string" ||
        key.length === 0 ||
        key.length > 256 ||
        !key.startsWith(id + "-")
      ) {
        return NextResponse.json(
          { error: "Invalid photo_lqips key" },
          { status: 400 },
        );
      }
      if (
        typeof val !== "string" ||
        !val.startsWith("data:image/") ||
        val.length > 4000
      ) {
        return NextResponse.json(
          { error: "photo_lqips value must be a small data: URI" },
          { status: 400 },
        );
      }
      clean[key] = val;
    }
    updates.photo_lqips = clean;
  }

  // Reorder: client sends the desired order as storage object names (or signed
  // URLs). Validate ownership (IDOR), reconcile against storage existence, then
  // re-sign server-side and set cover = photos[0].
  if (photos !== undefined) {
    // A reorder must list the existing photos; an empty array is never a valid
    // reorder (and must not become a backdoor to clear a location's photos).
    if (
      !Array.isArray(photos) ||
      photos.length === 0 ||
      photos.length > MAX_PHOTOS
    ) {
      return NextResponse.json(
        { error: "photos must be a non-empty array" },
        { status: 400 },
      );
    }
    const requested: string[] = [];
    for (const p of photos) {
      if (typeof p !== "string") {
        return NextResponse.json(
          { error: "photos entries must be strings" },
          { status: 400 },
        );
      }
      const name = photoFilename(p);
      if (!name || !name.startsWith(id + "-")) {
        return NextResponse.json(
          { error: "photo does not belong to this location" },
          { status: 403 },
        );
      }
      requested.push(name);
    }
    const order = await resolvePhotoOrder(id, requested);
    const signed = await signPhotoFiles(order);
    updates.photos = signed;
    updates.photo_url = signed[0] ?? null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 },
    );
  }

  const { data, error } = await getSupabaseAdmin()
    .from("locations")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error || !data) {
    if (error?.code === "PGRST116") {
      return NextResponse.json(
        { error: "Location not found" },
        { status: 404 },
      );
    }
    if (process.env.NODE_ENV !== "production")
      console.error("[app] Supabase PATCH error:", error);
    return NextResponse.json(
      { error: "Failed to update location" },
      { status: 500 },
    );
  }

  return NextResponse.json(data);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await checkCsrf(request)).ok) {
    return NextResponse.json(
      { error: "CSRF token missing or invalid" },
      { status: 403 },
    );
  }
  const rl = checkRateLimit(
    request,
    "locations:delete",
    RATE_LIMITS.WRITE.limit,
    RATE_LIMITS.WRITE.windowMs,
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const { id } = await params;

  if (!UUID_REGEX.test(id)) {
    return NextResponse.json({ error: "Invalid id format" }, { status: 400 });
  }

  // Check if it exists first — and capture its photo set NOW (before the row is
  // gone) so storage cleanup can purge derivatives from the KNOWN set even if the
  // live storage listing later fails or returns incomplete.
  const { data: existing, error: fetchError } = await getSupabaseAdmin()
    .from("locations")
    .select("id, photos, photo_url")
    .eq("id", id)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
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
    return NextResponse.json(
      { error: "Failed to delete location" },
      { status: 500 },
    );
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

  return NextResponse.json({ success: true });
}
