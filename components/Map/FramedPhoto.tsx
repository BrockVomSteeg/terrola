"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  clamp,
  clampScale,
  objectPositionFromOffset,
  photoFilename,
} from "@/lib/photos";

interface FramedPhotoProps {
  /** Full-resolution signed URL. The last-resort fallback if a thumbnail / card
   * image can't load, and what the lightbox/reframe always use. May be absent
   * while the parent is fetching it (see `loading`). */
  src?: string | null;
  /**
   * Small thumbnail signed URL (~600px). On `sharpTarget="thumb"` surfaces
   * (timeline, edit grid) it is the rendered image itself; on a `"card"` surface
   * it is the INSTANT low-res placeholder shown under the sharp image. Empty/
   * absent → skipped (the sharp image / shimmer is shown directly).
   */
  thumbSrc?: string | null;
  /**
   * Card-tier signed URL (~1152px sharp derivative). The map card's sharp target
   * — crisp at DPR 3 without pulling the full ~2400px original. Used only when
   * `sharpTarget="card"`; falls back to `src` (full) when absent (un-backfilled).
   */
  cardSrc?: string | null;
  /**
   * Which image this surface should END on (the "sharp" target). The card uses
   * `"card"` (sharpens the cover to the ~1152px image with the thumb as an
   * instant placeholder); everything else uses the default `"thumb"` (the cheap
   * small image, byte behavior unchanged). The lightbox does not use FramedPhoto.
   */
  sharpTarget?: "thumb" | "card";
  /**
   * Tiny base64 LQIP data URI rendered instantly as a blurred placeholder while
   * the real image loads, then crossfaded out. Absent → the warm shimmer (or the
   * thumb placeholder, on a card) is shown instead. (Optional; absent
   * unless provided. The blur-up does NOT depend on it.)
   */
  lqip?: string | null;
  alt?: string;
  width: number | string;
  height: number | string;
  /** borderRadius */
  rounded?: number | string;
  /**
   * Normalized framing in [-1, 1] per axis (0 = centered), with an optional
   * `scale` zoom in [1, 3] (absent/1 = no zoom). Resolution independent — pan
   * maps to object-position and zoom to a transform around the same framing
   * point, so the same value crops identically at any frame size (and on a
   * thumbnail vs the card vs the full image). Omit to center. Beats `legacyOffsetPx`.
   */
  offset?: { x: number; y: number; scale?: number } | null;
  /**
   * Legacy COVER-only pixel offset (the `photo_offset_x/y` columns). Used ONLY
   * as a fallback when no normalized `offset` is present, so covers framed
   * with a pixel offset keep their framing instead of snapping back to center. Converted px → normalized fraction once the image
   * has decoded (it needs natural + frame dimensions); applied before the image
   * fades in, so there is no visible recenter.
   */
  legacyOffsetPx?: { x: number; y: number } | null;
  /**
   * True when the PARENT is still fetching this photo's signed URL (so every
   * source is temporarily absent). Distinguishes "loading" from "no photo":
   * while loading we show the placeholder/shimmer, NEVER the emoji. Ignored once
   * a URL exists.
   */
  loading?: boolean;
  /** Shown ONLY on a genuine load error or when there is truly no image. */
  fallbackEmoji: string;
  /** Background behind the image / emoji (e.g. a category bg tint). */
  fallbackBg?: string;
  /** loading="eager" + fetchPriority="high" for above-the-fold covers. */
  eager?: boolean;
  /** Merged over the base <img> style. */
  imgStyle?: CSSProperties;
  draggable?: boolean;
}

// Bounded retries of the SHARP image on a transient load error before giving up
// so a transient cellular error does not leave the icon stuck (a single onError
// would otherwise set errored=true permanently). Small, growing backoff.
const MAX_SHARP_RETRY = 2;

/**
 * One image, cropped to a fixed frame, with a real best-in-class blur-up:
 *
 *   1. INSTANT placeholder — a blurred LQIP (0 network) if provided, else the
 *      small thumb (on a card), else a warm shimmer. NEVER the emoji.
 *   2. SHARP — the per-surface target (the ~1152px card image on a card; the
 *      thumb on the timeline/grid) crossfades in on load.
 *   3. ERROR — only after the sharp image hard-fails AND there is no thumb/LQIP
 *      placeholder to keep showing, OR there is genuinely no image: THEN the
 *      category emoji (never a broken-image glyph, never a transient flash).
 *
 * Layers share one object-position + zoom transform so they crop identically.
 * Keyed on the displayed object's STABLE name (token-independent), so a re-sign
 * of the same object with a fresh `?token=` never re-fetches or re-fades.
 */
export default function FramedPhoto({
  src,
  thumbSrc,
  cardSrc,
  sharpTarget = "thumb",
  lqip,
  alt = "",
  width,
  height,
  rounded = 0,
  offset,
  legacyOffsetPx,
  loading = false,
  fallbackEmoji,
  fallbackBg = "transparent",
  eager = false,
  imgStyle,
  draggable = false,
}: FramedPhotoProps) {
  // Normalize empties to null so "" (an un-backfilled derivative) is absent.
  const normFull = src && src.length ? src : null;
  const normThumb = thumbSrc && thumbSrc.length ? thumbSrc : null;
  const normCard = cardSrc && cardSrc.length ? cardSrc : null;

  // Resolve the two layers for this surface:
  //  - sharpUrl: the image we END on. Card: card → full → thumb. Thumb: thumb → full.
  //  - placeholderUrl: an instant low-res layer shown UNDER the sharp (card only),
  //    and only when it is a DIFFERENT object than the sharp (no double-render).
  const sharpUrl =
    sharpTarget === "card"
      ? (normCard ?? normFull ?? normThumb)
      : (normThumb ?? normFull);
  const placeholderUrl =
    sharpTarget === "card" && normThumb && normThumb !== sharpUrl
      ? normThumb
      : null;

  // Reset key = the STABLE object name of the sharp source (else the placeholder).
  // Token-INDEPENDENT, so a re-sign of the same object does NOT reset load state
  // (that re-downloaded the same bytes + re-faded every poll / card-open). It DOES
  // change when the photo changes OR when a card image is backfilled for a cover
  // that had been showing the full image (key `<obj>` → `<obj>.card`) → adopt it.
  const displayKey = photoFilename(sharpUrl ?? placeholderUrl);
  const displayKeyRef = useRef<string | null>(displayKey);

  // The URLs actually in the <img>s — held in state so a token-only re-sign of an
  // unchanged object keeps the byte-identical string (no reload), while a real
  // source change re-inits them via the reset effect below.
  const [sharpSrc, setSharpSrc] = useState<string | null>(sharpUrl);
  const [placeholderSrc, setPlaceholderSrc] = useState<string | null>(
    placeholderUrl,
  );
  const triedFullRef = useRef(false);

  const [sharpLoaded, setSharpLoaded] = useState(false);
  const [sharpErrored, setSharpErrored] = useState(false);
  const [sharpAttempt, setSharpAttempt] = useState(0);
  const [placeholderLoaded, setPlaceholderLoaded] = useState(false);
  const [placeholderErrored, setPlaceholderErrored] = useState(false);
  const [showSpinner, setShowSpinner] = useState(false);
  // Pending sharp-retry timer, so a displayKey change / unmount can cancel it
  // (otherwise it fires ~400–1600ms later and bumps the NEW photo's attempt).
  const sharpRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether this image is in/near the viewport. Eager images are always "near"
  // (they fetch immediately). For a LAZY image an IntersectionObserver flips this
  // true as it approaches view, so the spinner is shown ONLY for an image the
  // browser is actually fetching — never a perpetual spinner on a below-the-fold
  // lazy image the browser is intentionally deferring (#100 stuck-spinner class).
  const [nearViewport, setNearViewport] = useState(eager);
  // Normalized offset derived from a legacy pixel offset (cover fallback only).
  const [legacyNorm, setLegacyNorm] = useState<{ x: number; y: number } | null>(
    null,
  );
  const sharpImgRef = useRef<HTMLImageElement>(null);
  const placeholderImgRef = useRef<HTMLImageElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // A normalized offset always wins; the legacy conversion is only consulted
  // when no normalized offset is supplied for this photo.
  const hasNormalized = !!offset;
  const legacyPx =
    !hasNormalized &&
    legacyOffsetPx &&
    (legacyOffsetPx.x !== 0 || legacyOffsetPx.y !== 0)
      ? legacyOffsetPx
      : null;

  // Re-init both layers ONLY when the displayed object changes — NOT when a parent
  // merely re-signs the same object with a fresh token (that reset the load state
  // → a redundant re-download of the SAME bytes + a visible re-fade every poll /
  // card-open). A token is not a new photo, so the loaded image is kept untouched.
  useEffect(() => {
    if (displayKeyRef.current === displayKey && (sharpSrc || placeholderSrc))
      return;
    displayKeyRef.current = displayKey;
    triedFullRef.current = false;
    // Cancel a pending retry from the PREVIOUS photo so it can't bump this one.
    if (sharpRetryTimerRef.current !== null) {
      clearTimeout(sharpRetryTimerRef.current);
      sharpRetryTimerRef.current = null;
    }
    setSharpAttempt(0);
    setSharpSrc(sharpUrl);
    setPlaceholderSrc(placeholderUrl);
    setSharpLoaded(false);
    setSharpErrored(false);
    setPlaceholderLoaded(false);
    setPlaceholderErrored(false);
    setLegacyNorm(null);
    // Re-arm the viewport gate for the NEW source: a lazy slot whose photo
    // changed while off-screen must re-observe. Eager → stays near.
    setNearViewport(eager);
    // sharpUrl/placeholderUrl are intentionally NOT deps: a token-only re-sign
    // keeps the same displayKey and must not re-run this. Only a real source change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayKey]);

  // Cancel any pending sharp-retry timer on unmount.
  useEffect(
    () => () => {
      if (sharpRetryTimerRef.current !== null)
        clearTimeout(sharpRetryTimerRef.current);
    },
    [],
  );

  // Observe a LAZY image's approach to the viewport so the spinner is gated to
  // images actually being fetched. Eager images skip this (always near). Once
  // near, stay near (no flapping). Fails open: no IntersectionObserver → treat
  // as near so behavior is unchanged on unsupported engines.
  useEffect(() => {
    if (eager || nearViewport) return;
    const el = wrapperRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNearViewport(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [eager, nearViewport]);

  // Convert a legacy pixel pan into the equivalent normalized object-position
  // fraction, using the given (loaded) image's natural dimensions. A positive
  // legacy pan shifted the image right/down (revealing more of the left/top),
  // which is a NEGATIVE object-position fraction — hence the sign flip.
  function computeLegacyNorm(img: HTMLImageElement | null) {
    if (!legacyPx || !img) return;
    const cw = img.parentElement?.clientWidth ?? 0;
    const ch = img.parentElement?.clientHeight ?? 0;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!cw || !ch || !iw || !ih) return;
    const scale = Math.max(cw / iw, ch / ih);
    const maxX = Math.max(0, (iw * scale - cw) / 2);
    const maxY = Math.max(0, (ih * scale - ch) / 2);
    const nx = maxX ? clamp(-legacyPx.x / maxX, -1, 1) : 0;
    const ny = maxY ? clamp(-legacyPx.y / maxY, -1, 1) : 0;
    setLegacyNorm({ x: nx, y: ny });
  }

  // (Re)decode the SHARP image whenever its source — or a retry attempt — changes.
  // img.decode() gives a flash-free fade; onLoad/onError remain the source of
  // truth for browsers that reject decode() (Safari on cross-origin images).
  useEffect(() => {
    setSharpLoaded(false);
    setSharpErrored(false);
    if (!sharpSrc) return;
    const img = sharpImgRef.current;
    if (!img) return;
    if (img.complete && img.naturalWidth > 0) {
      computeLegacyNorm(img);
      setSharpLoaded(true);
      return;
    }
    let cancelled = false;
    img
      .decode?.()
      .then(() => {
        if (!cancelled) {
          computeLegacyNorm(img);
          setSharpLoaded(true);
        }
      })
      .catch(() => {
        /* onLoad / onError will resolve the state */
      });
    return () => {
      cancelled = true;
    };
    // legacyPx excluded — recomputed in the same load path; sharpSrc/attempt are
    // the triggers that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharpSrc, sharpAttempt]);

  // Catch a placeholder thumb that was already cached/complete before its onLoad
  // could attach (the common case after the map prefetch warms it).
  useEffect(() => {
    setPlaceholderLoaded(false);
    setPlaceholderErrored(false);
    if (!placeholderSrc) return;
    const img = placeholderImgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      computeLegacyNorm(img);
      setPlaceholderLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeholderSrc]);

  // ── State machine ─────────────────────────────────────────────────────────
  const anyRasterLoaded = sharpLoaded || placeholderLoaded;
  // A real fetch is in flight (the sharp image), or the parent is still signing.
  const isLoading =
    (!!sharpSrc && !sharpLoaded && !sharpErrored) ||
    (!sharpSrc && !placeholderSrc && loading);
  // A usable placeholder thumb is one that exists AND hasn't itself failed to
  // load — a present-but-errored placeholder shows nothing, so it must not
  // suppress the emoji (else a failed thumb + failed sharp = a blank card).
  const placeholderUsable = !!placeholderSrc && !placeholderErrored;
  // The category emoji shows ONLY when there is genuinely nothing to ever show:
  // no LQIP, no usable placeholder thumb, the sharp image not loaded, and either
  // no source at all (and not still loading) OR the sharp hard-errored with no
  // placeholder to fall back to. Never while a thumb/LQIP is visible.
  const showEmoji =
    !lqip &&
    !placeholderUsable &&
    !sharpLoaded &&
    (sharpErrored || (!sharpSrc && !loading));

  // Delay the spinner ~150ms so a fast load shows only the placeholder.
  useEffect(() => {
    if (!isLoading) {
      setShowSpinner(false);
      return;
    }
    const t = setTimeout(() => setShowSpinner(true), 150);
    return () => clearTimeout(t);
  }, [isLoading]);

  const resolved = offset ?? legacyNorm;
  const objectPosition = objectPositionFromOffset(resolved);
  // Per-photo zoom: magnify around the SAME framing point used for pan. Identity
  // at scale 1 → the transform is omitted entirely and the render is unchanged.
  const userScale = clampScale(offset?.scale);
  const zoomTransform = userScale > 1 ? `scale(${userScale})` : undefined;

  function handleSharpError() {
    // 1) Fall from a derivative (card/thumb) to the full image once.
    if (!triedFullRef.current && normFull && sharpSrc !== normFull) {
      triedFullRef.current = true;
      setSharpSrc(normFull);
      return;
    }
    // 2) Bounded retry of the current sharp src — transient cellular blips used
    //    to stick the cover on the category emoji forever (no retry). Re-mount
    //    the <img> (via its key) to force a fresh fetch after a small backoff.
    if (sharpAttempt < MAX_SHARP_RETRY) {
      const next = sharpAttempt + 1;
      // Tracked so a displayKey change / unmount cancels it (it would otherwise
      // bump the NEXT photo's attempt counter from this photo's stale closure).
      sharpRetryTimerRef.current = setTimeout(
        () => setSharpAttempt(next),
        400 * next,
      );
      return;
    }
    // 3) Give up on the sharp layer. A loaded thumb placeholder stays visible —
    //    the emoji only shows when there is genuinely nothing to display.
    setSharpErrored(true);
  }

  // A spinner only when nothing else is on screen (no LQIP, no thumb yet) AND the
  // image is actually being fetched near the viewport.
  const spinnerVisible =
    showSpinner && isLoading && nearViewport && !lqip && !placeholderLoaded;

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "relative",
        width,
        height,
        overflow: "hidden",
        borderRadius: rounded,
        background: fallbackBg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {showEmoji ? (
        // Inherits the call site's font-size so the emoji scales to the frame.
        <span data-testid="framed-emoji" style={{ lineHeight: 1 }}>
          {fallbackEmoji}
        </span>
      ) : (
        <>
          {lqip ? (
            // Instant blurred placeholder — decoded from an inline data URI, so
            // no network request. Fades out once any real raster (thumb or sharp)
            // is on screen. Slightly upscaled to hide blurred edges.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              aria-hidden
              data-testid="framed-lqip"
              src={lqip}
              alt=""
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition,
                filter: "blur(12px)",
                transform: `scale(${1.1 * userScale})`,
                transformOrigin: objectPosition,
                opacity: anyRasterLoaded ? 0 : 1,
                transition: "opacity 0.4s ease",
                pointerEvents: "none",
              }}
            />
          ) : (
            // warm shimmer behind the image until something has decoded
            <div
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "linear-gradient(90deg, #EDE0D0 0%, #F5EDE0 50%, #EDE0D0 100%)",
                backgroundSize: "200% 100%",
                animation: "shimmer 1.5s infinite",
                opacity: anyRasterLoaded ? 0 : 1,
                transition: "opacity 0.3s ease",
                pointerEvents: "none",
              }}
            />
          )}

          {/* Low-res thumb placeholder (card surfaces) — paints fast (often
              already warmed by the map prefetch), fades out when the sharp card
              image arrives, and STAYS if the sharp image errors (no emoji). */}
          {placeholderSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={placeholderImgRef}
              aria-hidden
              data-testid="framed-placeholder"
              src={placeholderSrc}
              alt=""
              loading={eager ? "eager" : "lazy"}
              decoding="async"
              {...(eager ? { fetchPriority: "high" as const } : {})}
              onLoad={(e) => {
                computeLegacyNorm(e.currentTarget);
                setPlaceholderLoaded(true);
              }}
              onError={() => setPlaceholderErrored(true)}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition,
                transform: zoomTransform,
                transformOrigin: zoomTransform ? objectPosition : undefined,
                opacity: sharpLoaded ? 0 : placeholderLoaded ? 1 : 0,
                transition: "opacity 0.3s ease",
                pointerEvents: "none",
              }}
            />
          )}

          {/* subtle spinner — only when nothing else is on screen yet (no LQIP,
              no loaded thumb) and the image is actually being fetched. */}
          {spinnerVisible && (
            <span
              aria-hidden
              data-testid="framed-spinner"
              style={{
                position: "absolute",
                width: "min(40%, 22px)",
                aspectRatio: "1 / 1",
                border: "2px solid rgba(193,127,90,0.25)",
                borderTopColor: "#C17F5A",
                borderRadius: "50%",
                animation: "spin 0.7s linear infinite",
                pointerEvents: "none",
              }}
            />
          )}

          {/* The SHARP image. Never mounted with an empty src. The `key` includes
              the retry attempt so a bounded retry re-mounts → re-fetches. */}
          {sharpSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`sharp-${sharpAttempt}`}
              ref={sharpImgRef}
              src={sharpSrc}
              alt={alt}
              loading={eager ? "eager" : "lazy"}
              decoding="async"
              {...(eager ? { fetchPriority: "high" as const } : {})}
              draggable={draggable}
              onLoad={(e) => {
                computeLegacyNorm(e.currentTarget);
                setSharpLoaded(true);
              }}
              onError={handleSharpError}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition,
                transform: zoomTransform,
                transformOrigin: zoomTransform ? objectPosition : undefined,
                display: "block",
                opacity: sharpLoaded ? 1 : 0,
                transition: "opacity 0.3s ease",
                ...imgStyle,
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
