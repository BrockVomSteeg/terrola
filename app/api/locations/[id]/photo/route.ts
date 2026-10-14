export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { checkCsrf } from "@/app/api/_lib/csrf";
import { checkRateLimit, RATE_LIMITS } from "@/app/api/_lib/rate-limit";
import { storeError } from "@/app/api/_lib/store-response";
import { getStore } from "@/lib/demo/gate";
import { COOKIE_NAME } from "@/lib/session";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!store.ok) return storeError(store.error.code, "Failed to load photos");
  const listed = await store.data.listPhotos(id);
  if (!listed.ok) return storeError(listed.error.code, "Failed to load photos");
  // no-store: a card opened on another device within a CDN revalidate window
  // could show a stale photo order (after a reorder). URLs stay valid because
  // still-fresh signed URLs are reused and near-expiry ones re-signed at read.
  // `thumbs` are the small per-photo placeholders the card renders first;
  // `cards` are the ~1152px sharp images the card crossfades to.
  return NextResponse.json(listed.data, {
    headers: { "Cache-Control": "no-store" },
  });
}

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
    "photo:write",
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

  // JSON body only: the file was uploaded directly to Supabase Storage by the
  // browser. The older upload through the server (multipart) is gone.
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json(
      { error: "Send JSON with the uploaded path" },
      { status: 415 },
    );
  }

  const body = await request.json().catch(() => null);
  const path: unknown = body?.path;
  // IDOR guard: the object MUST be in this location's namespace.
  if (typeof path !== "string" || !path.startsWith(id + "-")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // The write goes through the gate (SPEC R17): the demo store in a demo, the live
  // store, which checks the session itself, in live mode.
  const store = await getStore({
    kind: "session",
    token: request.cookies.get(COOKIE_NAME)?.value,
  });
  if (!store.ok)
    return storeError(store.error.code, "Failed to save photo URL", false);
  const registered = await store.data.registerPhoto(id, path);
  if (!registered.ok)
    return storeError(registered.error.code, "Failed to save photo URL", false);

  const { photo_url, photos, thumbs, cards } = registered.data;
  return NextResponse.json({ photo_url, photos, thumbs, cards });
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
    "photo:delete",
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

  const rawFilename = request.nextUrl.searchParams.get("filename");

  // No filename (or an empty one) means "the cover", which the store is told as
  // undefined. A given name is cleaned here and may come out as "", which names
  // nothing: it never turns into "the cover". The store removes a name only when
  // it is in this location's namespace (IDOR guard).
  let safeName: string | undefined;
  if (rawFilename) {
    // Strip query string in case caller passed a signed URL's filename portion
    const filename = rawFilename.split("?")[0];
    safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "");
  }

  // The write goes through the gate (SPEC R17): the demo store in a demo, the live
  // store, which checks the session itself, in live mode.
  const store = await getStore({
    kind: "session",
    token: request.cookies.get(COOKIE_NAME)?.value,
  });
  if (!store.ok)
    return storeError(store.error.code, "Failed to update photo", false);
  const changed = await store.data.deletePhoto(id, safeName);
  if (!changed.ok)
    return storeError(changed.error.code, "Failed to update photo", false);

  const { photos, photo_url, thumbs, cards } = changed.data;
  return NextResponse.json({ photos, photo_url, thumbs, cards });
}
