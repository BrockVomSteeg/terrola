import { NextRequest, NextResponse } from "next/server";
import { checkCsrf } from "@/app/api/_lib/csrf";
import { checkRateLimit, RATE_LIMITS } from "@/app/api/_lib/rate-limit";
import { storeError } from "@/app/api/_lib/store-response";
import { getStore } from "@/lib/demo/gate";
import { COOKIE_NAME } from "@/lib/session";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
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

  // The write goes through the gate (SPEC R17): the demo store in a demo, which has
  // no file storage and answers 501, or the live store, which checks the session
  // itself, in live mode.
  const store = await getStore({
    kind: "session",
    token: request.cookies.get(COOKIE_NAME)?.value,
  });
  if (!store.ok)
    return storeError(store.error.code, "Failed to create upload URL", false);
  const upload = await store.data.createPhotoUpload(id);
  if (!upload.ok)
    return storeError(upload.error.code, "Failed to create upload URL", false);

  const u = upload.data;
  return NextResponse.json({
    signedUrl: u.signedUrl,
    token: u.token,
    path: u.path,
    thumbSignedUrl: u.thumbSignedUrl,
    thumbToken: u.thumbToken,
    thumbPath: u.thumbPath,
    cardSignedUrl: u.cardSignedUrl,
    cardToken: u.cardToken,
    cardPath: u.cardPath,
  });
}
