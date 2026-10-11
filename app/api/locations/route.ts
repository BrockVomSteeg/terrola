import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, freshenCoverUrls } from "@/lib/supabase-server";
import { attachCoverLqip } from "@/lib/photos";
import { filterLiveLocations, isNullIslandCoord } from "@/lib/locations";
import { verifyCsrf } from "@/app/api/_lib/csrf";
import { checkRateLimit, RATE_LIMITS } from "@/app/api/_lib/rate-limit";
import type { CategoryKey, Location } from "@/types";

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

export async function GET() {
  const { data, error } = await getSupabaseAdmin()
    .from("locations")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[app] Supabase GET error:", error);
    return NextResponse.json(
      { error: "Failed to load locations" },
      { status: 500 },
    );
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
  const decorated = attachCoverLqip(freshened);

  // no-store: the list must reflect writes — especially DELETES — immediately on
  // EVERY client. A stale-while-revalidate CDN copy could serve a just-deleted
  // pin to OTHER devices for the whole revalidate window (a client-side ignore
  // list only protects the deleting session). `revalidateTag`/`revalidatePath`
  // do NOT purge a header-based CDN copy, so on-demand invalidation isn't
  // possible here — no-store is the correct, simplest guarantee. Cost is
  // negligible: a small table and a periodic client poll.
  return NextResponse.json(decorated, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest) {
  if (!verifyCsrf(request)) {
    return NextResponse.json(
      { error: "CSRF token missing or invalid" },
      { status: 403 },
    );
  }
  const rl = checkRateLimit(
    request,
    "locations:create",
    RATE_LIMITS.WRITE.limit,
    RATE_LIMITS.WRITE.windowMs,
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
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

  const { title, date_label, lat, lng, description, category } = body as {
    title?: string;
    date_label?: string;
    lat?: number;
    lng?: number;
    description?: string;
    category?: string;
  };

  // Required field validation
  if (!title || !date_label || lat === undefined || lng === undefined) {
    return NextResponse.json(
      { error: "title, date_label, lat, and lng are required" },
      { status: 400 },
    );
  }

  // Coordinate range validation
  if (typeof lat !== "number" || lat < -90 || lat > 90) {
    return NextResponse.json(
      { error: "lat must be between -90 and 90" },
      { status: 400 },
    );
  }
  if (typeof lng !== "number" || lng < -180 || lng > 180) {
    return NextResponse.json(
      { error: "lng must be between -180 and 180" },
      { status: 400 },
    );
  }

  // Never let the LIVE app create a null-island ([0,0]) pin — a real geocode never
  // returns it, so it's either a failed geocode or stray test data. Prod-gated so
  // the local write-suite (dev) can still create off-map `[0,0]` throwaways.
  if (process.env.NODE_ENV === "production" && isNullIslandCoord(lat, lng)) {
    return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  }

  // Sanitize
  const sanitizedTitle = String(title).trim().slice(0, 200);
  const sanitizedDateLabel = String(date_label).trim().slice(0, 50);
  const sanitizedDescription = description
    ? String(description).trim().slice(0, 1000)
    : "";
  const sanitizedCategory: CategoryKey =
    category && VALID_CATEGORIES.includes(category as CategoryKey)
      ? (category as CategoryKey)
      : "everyday";

  // Validate non-empty after sanitization
  if (!sanitizedTitle) {
    return NextResponse.json(
      { error: "title cannot be empty" },
      { status: 400 },
    );
  }
  if (!sanitizedDateLabel) {
    return NextResponse.json(
      { error: "date_label cannot be empty" },
      { status: 400 },
    );
  }

  const { data, error } = await getSupabaseAdmin()
    .from("locations")
    .insert({
      title: sanitizedTitle,
      date_label: sanitizedDateLabel,
      lat,
      lng,
      description: sanitizedDescription,
      category: sanitizedCategory,
      display_order: 0,
    })
    .select()
    .single();

  if (error) {
    console.error("[app] Supabase POST error:", error);
    return NextResponse.json(
      { error: "Failed to save location" },
      { status: 500 },
    );
  }

  return NextResponse.json(data, { status: 201 });
}
