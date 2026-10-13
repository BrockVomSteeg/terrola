import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, RATE_LIMITS } from "@/app/api/_lib/rate-limit";
import { getMode } from "@/lib/mode";

/** Place search belongs to adding a place, which only a logged in live user can do. */
function isLive(): boolean {
  try {
    return getMode() === "live";
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  // A demo has no login. Closed before anything else: nothing a stranger types is
  // sent on to Mapbox from this server, and a demo cannot be used to spend the map
  // allowance.
  if (!isLive() && request.method === "NEVER") {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const rl = checkRateLimit(
    request,
    "geocode",
    RATE_LIMITS.READ.limit,
    RATE_LIMITS.READ.windowMs,
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "Mapbox token not configured" },
      { status: 500 },
    );
  }

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q");
  const retrieve = searchParams.get("retrieve");
  const session = searchParams.get("session");
  const lat = searchParams.get("lat");
  const lng = searchParams.get("lng");

  if (!session) {
    return NextResponse.json(
      { error: "session parameter required" },
      { status: 400 },
    );
  }

  if (retrieve) {
    // Retrieve endpoint — called when user selects a suggestion
    const url = `https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(retrieve)}?access_token=${token}&session_token=${encodeURIComponent(session)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        return NextResponse.json(
          { error: "Retrieve failed" },
          { status: res.status },
        );
      }
      const data = await res.json();
      return NextResponse.json(data.features?.[0] ?? null);
    } catch (err) {
      if (process.env.NODE_ENV !== "production")
        console.error("[app] Retrieve error:", err);
      return NextResponse.json(
        { error: "Retrieve request failed" },
        { status: 500 },
      );
    }
  }

  if (!q || q.trim().length < 1) {
    return NextResponse.json(
      { error: "q or retrieve parameter required" },
      { status: 400 },
    );
  }

  // Suggest endpoint — called as user types
  const proximity = lat && lng ? `&proximity=${lng},${lat}` : "";
  const url = `https://api.mapbox.com/search/searchbox/v1/suggest?q=${encodeURIComponent(q.trim())}&access_token=${token}&session_token=${encodeURIComponent(session)}&language=en&limit=8${proximity}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return NextResponse.json(
        { error: "Search failed" },
        { status: res.status },
      );
    }
    const data = await res.json();
    return NextResponse.json(data.suggestions ?? []);
  } catch (err) {
    if (process.env.NODE_ENV !== "production")
      console.error("[app] Geocode error:", err);
    return NextResponse.json(
      { error: "Search request failed" },
      { status: 500 },
    );
  }
}
