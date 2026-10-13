export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { thumbName, cardName } from "@/lib/photos";
import { checkCsrf } from "@/app/api/_lib/csrf";
import { checkRateLimit, RATE_LIMITS } from "@/app/api/_lib/rate-limit";
import { persistPhotos, rebuildPhotos } from "@/app/api/_lib/live-store";
import { storeError } from "@/app/api/_lib/store-response";
import { getStore } from "@/lib/demo/gate";
import { COOKIE_NAME } from "@/lib/session";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;
const BUCKET = "location-photos";

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

  // JSON body: file was uploaded directly to Supabase Storage by the browser.
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => null);
    const path: unknown = body?.path;
    // IDOR guard: the object MUST be in this location's namespace.
    if (typeof path !== "string" || !path.startsWith(id + "-")) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }
    try {
      // Give storage a moment to make the just-PUT object listable.
      await new Promise((r) => setTimeout(r, 300));
      const ensureName = path.split("/").pop() ?? path;
      const { photo_url, photos, thumbs, cards } = await rebuildPhotos(
        id,
        ensureName,
      );
      const ok = await persistPhotos(id, photo_url, photos);
      if (!ok) {
        return NextResponse.json(
          { error: "Failed to save photo URL" },
          { status: 500 },
        );
      }
      return NextResponse.json({ photo_url, photos, thumbs, cards });
    } catch {
      return NextResponse.json({ error: "list_failed" }, { status: 500 });
    }
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json(
      { error: "Request too large or malformed" },
      { status: 413 },
    );
  }

  const file = formData.get("photo");
  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: "photo field required" },
      { status: 400 },
    );
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: "Only JPEG, PNG, and WebP images allowed" },
      { status: 415 },
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "Image must be under 10MB" },
      { status: 413 },
    );
  }

  const ext =
    file.type === "image/jpeg"
      ? "jpg"
      : file.type === "image/png"
        ? "png"
        : file.type === "image/webp"
          ? "webp"
          : "heic";

  const filename = `${id}-${Date.now()}.${ext}`;
  const arrayBuffer = await file.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);

  const { error: uploadError } = await getSupabaseAdmin()
    .storage.from(BUCKET)
    .upload(filename, buffer, {
      contentType: file.type,
      upsert: true,
      // Photo bytes are immutable per object name → cache 1 year (server-side multipart
      // upload path; the direct browser→Storage path sets the same on its PUT).
      cacheControl: "31536000",
    });

  if (uploadError) {
    if (process.env.NODE_ENV !== "production")
      console.error("[app] Storage upload error:", uploadError);
    return NextResponse.json(
      { error: "Failed to upload photo" },
      { status: 500 },
    );
  }

  const { photo_url, photos, thumbs, cards } = await rebuildPhotos(
    id,
    filename,
  );
  const ok = await persistPhotos(id, photo_url, photos);
  if (!ok) {
    if (process.env.NODE_ENV !== "production")
      console.error("[app] DB update error after upload");
    return NextResponse.json(
      { error: "Failed to save photo URL" },
      { status: 500 },
    );
  }

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

  if (rawFilename) {
    // Strip query string in case caller passed a signed URL's filename portion
    const filename = rawFilename.split("?")[0];
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "");
    // IDOR guard: only objects in this location's namespace are removable.
    // Remove the photo AND its `.thumb` + `.card` siblings (missing-object
    // removal is a harmless no-op in Supabase Storage).
    if (safeName && safeName.startsWith(id + "-")) {
      await getSupabaseAdmin()
        .storage.from(BUCKET)
        .remove([safeName, thumbName(safeName), cardName(safeName)]);
    }
  } else {
    // Backward compat: remove file referenced by photo_url in DB
    const { data: existing } = await getSupabaseAdmin()
      .from("locations")
      .select("photo_url")
      .eq("id", id)
      .single();

    if (existing?.photo_url) {
      // Extract just the filename from whatever URL format (signed or public)
      const urlPath = existing.photo_url.split("?")[0];
      const storageName = urlPath.split(`/${BUCKET}/`)[1];
      if (storageName) {
        await getSupabaseAdmin()
          .storage.from(BUCKET)
          .remove([storageName, thumbName(storageName), cardName(storageName)]);
      }
    }
  }

  // Removed object is gone from storage → resolvePhotoOrder drops it. The
  // removed photo's orphaned `.thumb` + `.card` are cleaned up above (best-effort).
  const { photo_url, photos, thumbs, cards } = await rebuildPhotos(id);
  const ok = await persistPhotos(id, photo_url, photos);
  if (!ok) {
    return NextResponse.json(
      { error: "Failed to update photo" },
      { status: 500 },
    );
  }

  return NextResponse.json({ photos, photo_url, thumbs, cards });
}
