/**
 * Browser-only image helpers: make a small cover thumbnail and a tiny LQIP
 * placeholder from an image Blob/File. Used at upload time (the file is already
 * in the browser). Pure of React/Supabase — only Web APIs (createImageBitmap,
 * OffscreenCanvas / <canvas>). Every function fails SAFE: it returns null on
 * any error so a thumbnail/placeholder is always optional, never load-bearing.
 *
 * NOT marked "server-only" because it is imported by Client Components; it is
 * never imported by a server route. All entry points guard on browser APIs.
 */

// Cover thumbnail target. ~600px longest side at q0.72 turns a ~2400px/0.92
// cover (hundreds of KB) into tens of KB — ~30× fewer bytes for the map card
// and timeline, which never need the full resolution.
export const THUMB_MAX_PX = 600;
export const THUMB_QUALITY = 0.72;

// Card-tier image target. The map card renders ~360 CSS px wide at DPR 3
// (~1080 device px), so the 600px thumb upscaled ~1.8–2.7× and looked soft
// (worst on portraits). ~1152px longest side at q0.7 covers DPR-3 without
// upscaling, at ~80–150KB (vs the ~2400px full's several hundred KB to ~1MB) —
// the card is sharp AND snappy on cellular. Used ONLY by the card surface; the
// timeline keeps the tiny thumb and the lightbox keeps the full image.
export const CARD_MAX_PX = 1152;
export const CARD_QUALITY = 0.7;

// LQIP: a ~24px JPEG, base64-inlined into the list response. Renders instantly
// (no request) as a blurred placeholder; crossfades to the real image. Kept
// tiny so the list payload barely grows.
export const LQIP_MAX_PX = 24;
export const LQIP_QUALITY = 0.4;
export const LQIP_MAX_URI_LEN = 2000;

// Placeholder feature flag. OFF by default. The `photo_lqips` column is created
// by supabase/migrations/20260101000000_init.sql; the flag only gates the
// feature. While off, no LQIP is computed or written and FramedPhoto shows the shimmer.
export const LQIP_ENABLED = process.env.NEXT_PUBLIC_LQIP_ENABLED === "1";

let _webpEncode: boolean | null = null;
/** Whether this browser can ENCODE WebP via canvas (decode is broader). */
function canEncodeWebp(): boolean {
  if (_webpEncode !== null) return _webpEncode;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    _webpEncode = c.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    _webpEncode = false;
  }
  return _webpEncode;
}

async function decode(source: Blob): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap === "undefined") return null;
  try {
    // imageOrientation:"from-image" bakes in EXIF rotation (matches the upload
    // compressor) so a portrait iPhone photo isn't sideways in its thumbnail.
    return await createImageBitmap(source, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
}

async function encode(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  type: string,
  quality: number,
): Promise<Blob | null> {
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, w, h);
      return await canvas.convertToBlob({ type, quality });
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, quality),
    );
  } catch {
    return null;
  }
}

function fitted(bitmap: ImageBitmap, maxPx: number): { w: number; h: number } {
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  return {
    w: Math.max(1, Math.round(bitmap.width * scale)),
    h: Math.max(1, Math.round(bitmap.height * scale)),
  };
}

export interface ThumbResult {
  blob: Blob;
  /** The real content-type to set on upload (trusted from the produced blob). */
  contentType: string;
  width: number;
  height: number;
}

/**
 * Produce a ~600px cover thumbnail (WebP when the browser can encode it, else
 * JPEG). The actual decoded format never has to match what we requested — the
 * VIEWER falls back to the full image if a thumbnail can't be decoded — but we
 * set the content-type from the produced blob so it's labelled correctly.
 * Returns null on any failure (caller proceeds without a thumbnail).
 */
export async function makeThumbnail(
  source: Blob,
  maxPx = THUMB_MAX_PX,
): Promise<ThumbResult | null> {
  const bitmap = await decode(source);
  if (!bitmap) return null;
  try {
    const { w, h } = fitted(bitmap, maxPx);
    const wantWebp = canEncodeWebp();
    const blob = await encode(
      bitmap,
      w,
      h,
      wantWebp ? "image/webp" : "image/jpeg",
      THUMB_QUALITY,
    );
    if (!blob || blob.size === 0) return null;
    return {
      blob,
      contentType: blob.type || "image/jpeg",
      width: w,
      height: h,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Produce a ~1152px CARD-tier image (WebP when the browser can encode it, else
 * JPEG) — the sharp source the map card renders. Mirrors `makeThumbnail`; the
 * VIEWER falls back to the full image if a card image can't be decoded, but we
 * label the content-type from the produced blob. Returns null on any failure
 * (caller proceeds without a card image — the full image is the fallback).
 */
export async function makeCardImage(
  source: Blob,
  maxPx = CARD_MAX_PX,
): Promise<ThumbResult | null> {
  const bitmap = await decode(source);
  if (!bitmap) return null;
  try {
    const { w, h } = fitted(bitmap, maxPx);
    const wantWebp = canEncodeWebp();
    const blob = await encode(
      bitmap,
      w,
      h,
      wantWebp ? "image/webp" : "image/jpeg",
      CARD_QUALITY,
    );
    if (!blob || blob.size === 0) return null;
    return {
      blob,
      contentType: blob.type || "image/jpeg",
      width: w,
      height: h,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Produce a tiny base64 LQIP data URI (instant blurred placeholder). JPEG for
 * universal decode. Returns null on failure or if the URI is unexpectedly large.
 */
export async function makeLqip(
  source: Blob,
  maxPx = LQIP_MAX_PX,
): Promise<string | null> {
  const bitmap = await decode(source);
  if (!bitmap) return null;
  try {
    const { w, h } = fitted(bitmap, maxPx);
    const blob = await encode(bitmap, w, h, "image/jpeg", LQIP_QUALITY);
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const uri = `data:image/jpeg;base64,${btoa(bin)}`;
    return uri.length <= LQIP_MAX_URI_LEN ? uri : null;
  } finally {
    bitmap.close();
  }
}
