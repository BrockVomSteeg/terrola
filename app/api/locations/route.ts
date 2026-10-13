import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { isNullIslandCoord } from "@/lib/locations";
import { checkCsrf } from "@/app/api/_lib/csrf";
import { checkRateLimit, RATE_LIMITS } from "@/app/api/_lib/rate-limit";
import { storeError } from "@/app/api/_lib/store-response";
import { getStore } from "@/lib/demo/gate";
import { COOKIE_NAME } from "@/lib/session";
import type { CategoryKey } from "@/types";

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

export async function GET(request: NextRequest) {
  const store = await getStore({
    kind: "session",
    token: request.cookies.get(COOKIE_NAME)?.value,
  });
  if (!store.ok) return storeError(store.error.code, "Failed to load locations");
  const listed = await store.data.listLocations();
  if (!listed.ok) return storeError(listed.error.code, "Failed to load locations");

  // no-store: the list must reflect writes — especially DELETES — immediately on
  // EVERY client. A stale-while-revalidate CDN copy could serve a just-deleted
  // pin to OTHER devices for the whole revalidate window (a client-side ignore
  // list only protects the deleting session). `revalidateTag`/`revalidatePath`
  // do NOT purge a header-based CDN copy, so on-demand invalidation isn't
  // possible here — no-store is the correct, simplest guarantee. Cost is
  // negligible: a small table and a periodic client poll.
  return NextResponse.json(listed.data, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest) {
  if (!(await checkCsrf(request)).ok) {
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
