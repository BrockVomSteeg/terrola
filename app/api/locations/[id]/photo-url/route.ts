import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { thumbName, cardName } from "@/lib/photos";
import { verifyCsrf } from "@/app/api/_lib/csrf";
import { checkRateLimit, RATE_LIMITS } from "@/app/api/_lib/rate-limit";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = "location-photos";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!verifyCsrf(request)) {
    return NextResponse.json(
      { error: "CSRF token missing or invalid" },
      { status: 403 },
    );
  }
  const rl = checkRateLimit(
    request,
    "photo-url:create",
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

  const filename = `${id}-${Date.now()}.jpg`;
  const { data, error } = await getSupabaseAdmin()
    .storage.from(BUCKET)
    .createSignedUploadUrl(filename);

  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to create upload URL" },
      { status: 500 },
    );
  }

  // A second signed upload URL for this photo's thumbnail (`<filename>.thumb`),
  // so the browser can PUT the small cover thumbnail it generates alongside the
  // original — no extra round-trip. Best-effort: if it fails, the client simply
  // skips the thumbnail (the full image is the fallback everywhere).
  const { data: thumbData } = await getSupabaseAdmin()
    .storage.from(BUCKET)
    .createSignedUploadUrl(thumbName(filename));

  // A third signed upload URL for this photo's card-tier image (`<filename>.card`),
  // the ~1152px sharp derivative the map card renders. Best-effort like the thumb:
  // a failure leaves no card image and the full photo is the fallback.
  const { data: cardData } = await getSupabaseAdmin()
    .storage.from(BUCKET)
    .createSignedUploadUrl(cardName(filename));

  return NextResponse.json({
    signedUrl: data.signedUrl,
    token: data.token,
    path: data.path,
    thumbSignedUrl: thumbData?.signedUrl ?? null,
    thumbToken: thumbData?.token ?? null,
    thumbPath: thumbData?.path ?? null,
    cardSignedUrl: cardData?.signedUrl ?? null,
    cardToken: cardData?.token ?? null,
    cardPath: cardData?.path ?? null,
  });
}
