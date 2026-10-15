"use client";

import { useEffect, useRef, useState } from "react";
import {
  clamp,
  clampScale,
  objectPositionFromOffset,
  MIN_PHOTO_SCALE,
  MAX_PHOTO_SCALE,
} from "@/lib/photos";

interface ReframeOverlayProps {
  /** Signed URL of the photo being reframed. */
  src: string;
  /**
   * Current normalized framing — pan fractions in [-1, 1] plus optional `scale`
   * zoom in [1, 3]. null = centered, no zoom.
   */
  initialOffset?: { x: number; y: number; scale?: number } | null;
  /**
   * Cover-only legacy pixel offset, used to seed the starting frame when this
   * photo has no normalized offset yet (so editing the cover begins from its
   * current framing rather than snapping to center).
   */
  initialLegacyPx?: { x: number; y: number } | null;
  fallbackEmoji: string;
  fallbackBg?: string;
  /**
   * width/height ratio of the preview frame, set by the caller to MATCH the
   * surface this photo will actually appear on (the card cover ≈ 2.1:1 for a
   * single-photo location, the strip ≈ 1.7:1 for multi). object-fit:cover crops
   * by aspect ratio, so matching it makes the editor true WYSIWYG with the card.
   * Defaults to the historical 1.65 if the caller doesn't pass one.
   */
  previewAspect?: number;
  saving?: boolean;
  /** A short message shown in the editor, such as a failed save. */
  error?: string | null;
  /** Commit — receives the chosen normalized pan + zoom. */
  onSave: (offset: { x: number; y: number; scale: number }) => void;
  onClose: () => void;
}

/**
 * Full-screen reframe editor: drag to pan, pinch / scroll / slider to zoom a
 * single photo within a fixed frame. The preview uses the SAME object-position +
 * scale-around-the-framing-point formula as the live FramedPhoto render, so what
 * you frame is exactly what the card / strip / timeline / map-card thumbnail will
 * show. Persists ONE normalized `{ x, y, scale }` per photo, keyed upstream by
 * the photo's stable storage object name.
 *
 * Coverage is automatic: on a cover-fit image, any scale ≥ 1 about an in-frame
 * origin still covers the frame for any pan in [-1, 1], so there is nothing to
 * drag "past the edge" — the pan only ever needs clamping to [-1, 1].
 */
export default function ReframeOverlay({
  src,
  initialOffset,
  initialLegacyPx,
  fallbackEmoji,
  fallbackBg = "#EDE0D0",
  previewAspect = 1.65,
  saving = false,
  error = null,
  onSave,
  onClose,
}: ReframeOverlayProps) {
  const [offset, setOffset] = useState<{ x: number; y: number }>(
    initialOffset ? { x: initialOffset.x, y: initialOffset.y } : { x: 0, y: 0 },
  );
  const [scale, setScale] = useState<number>(clampScale(initialOffset?.scale));
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const [visible, setVisible] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);
  // Live zoom, mirrored into a ref so pointer/wheel handlers (which may run from
  // a stale closure) always read the current value.
  const scaleRef = useRef(scale);
  // All active pointers on the frame (for pinch); and the in-flight pinch.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ startDist: number; baseScale: number } | null>(
    null,
  );
  // Whether we already seeded the offset from a legacy px value (once per mount).
  const seededRef = useRef(false);

  function applyScale(next: number) {
    const s = clampScale(next);
    scaleRef.current = s;
    setScale(s);
  }

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  // Escape closes the editor, like the lightbox. It listens in the capture
  // phase and stops the key there, so the place card under it stays open.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!saving) onClose();
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose, saving]);

  // Scroll-wheel zoom (desktop). Attached natively as non-passive so we can
  // preventDefault — React's onWheel is passive and would warn.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Wheel up (deltaY < 0) zooms in; gentle, proportional to the gesture.
      applyScale(scaleRef.current - e.deltaY * 0.0015);
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, []);

  // Pannable overflow on each axis (px) at the CURRENT zoom: the rendered frame
  // vs the image's natural size under object-fit: cover, magnified by the zoom.
  // Drag deltas divide by this so a 1px drag pans 1px on screen at any zoom.
  function panBounds(): { maxX: number; maxY: number } | null {
    const img = imgRef.current;
    const frame = frameRef.current;
    if (!img || !frame) return null;
    const cw = frame.clientWidth;
    const ch = frame.clientHeight;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!cw || !ch || !iw || !ih) return null;
    const cover = Math.max(cw / iw, ch / ih);
    const s = scaleRef.current;
    return {
      maxX: Math.max(0, (iw * cover * s - cw) / 2),
      maxY: Math.max(0, (ih * cover * s - ch) / 2),
    };
  }

  function handleImgLoad() {
    setLoaded(true);
    // Seed from legacy px only when there is no normalized offset to start from.
    if (
      !seededRef.current &&
      !initialOffset &&
      initialLegacyPx &&
      (initialLegacyPx.x !== 0 || initialLegacyPx.y !== 0)
    ) {
      seededRef.current = true;
      const b = panBounds();
      if (b) {
        setOffset({
          x: b.maxX ? clamp(-initialLegacyPx.x / b.maxX, -1, 1) : 0,
          y: b.maxY ? clamp(-initialLegacyPx.y / b.maxY, -1, 1) : 0,
        });
      }
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!loaded || errored) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture may fail on some browsers */
    }
    if (pointersRef.current.size >= 2) {
      // Second finger down → start a pinch and abandon any single-finger drag.
      dragRef.current = null;
      const [a, b] = [...pointersRef.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      pinchRef.current = { startDist: dist, baseScale: scaleRef.current };
    } else {
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        baseX: offset.x,
        baseY: offset.y,
      };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Pinch-to-zoom (two fingers) takes priority over pan.
    if (pinchRef.current && pointersRef.current.size >= 2) {
      e.preventDefault();
      const [a, b] = [...pointersRef.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      applyScale(
        pinchRef.current.baseScale * (dist / pinchRef.current.startDist),
      );
      return;
    }

    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const b = panBounds();
    if (!b) return;
    e.preventDefault();
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // Dragging the image right (dx>0) reveals more of its left → a lower
    // object-position fraction; hence the subtraction.
    setOffset({
      x: b.maxX ? clamp(d.baseX - dx / b.maxX, -1, 1) : 0,
      y: b.maxY ? clamp(d.baseY - dy / b.maxY, -1, 1) : 0,
    });
  }

  function endPointer(e: React.PointerEvent) {
    pointersRef.current.delete(e.pointerId);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (dragRef.current && e.pointerId === dragRef.current.pointerId) {
      // Don't auto-resume drag from a finger left over after a pinch — that would
      // jump the frame; a fresh press starts a clean drag.
      dragRef.current = null;
    }
  }

  // Responsive frame width; its aspect ratio is `previewAspect` (passed by the
  // caller to match the exact surface this photo lands on), so the crop you see
  // here is the crop the card shows.
  const frameWidth = "min(420px, calc(100vw - 48px))";
  const objectPosition = objectPositionFromOffset(offset);
  const canZoom = loaded && !errored;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reframe photo"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "rgba(40,28,20,0.55)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "18px",
        padding: "24px",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.2s ease",
      }}
      onClick={(e) => {
        // Backdrop click closes; interactions inside the panel stopPropagation.
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <p
        style={{
          fontFamily: "var(--font-quicksand), sans-serif",
          fontSize: "12px",
          letterSpacing: "1.5px",
          textTransform: "uppercase",
          color: "rgba(255,248,240,0.85)",
          margin: 0,
          textAlign: "center",
        }}
      >
        Drag to reposition · pinch or scroll to zoom
      </p>

      {error && (
        <p
          role="alert"
          style={{
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "13px",
            color: "#FFF8F0",
            background: "rgba(194,58,75,0.85)",
            borderRadius: "100px",
            padding: "6px 16px",
            margin: 0,
            textAlign: "center",
          }}
        >
          {error}
        </p>
      )}

      <div
        ref={frameRef}
        data-testid="reframe-frame"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        style={{
          position: "relative",
          width: frameWidth,
          aspectRatio: `${previewAspect} / 1`,
          borderRadius: "14px",
          overflow: "hidden",
          background: fallbackBg,
          boxShadow: "0 12px 48px rgba(0,0,0,0.4)",
          touchAction: "none",
          cursor: canZoom ? "grab" : "default",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {errored ? (
          <span style={{ fontSize: "48px", lineHeight: 1 }}>
            {fallbackEmoji}
          </span>
        ) : (
          <>
            <div
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "linear-gradient(90deg, #EDE0D0 0%, #F5EDE0 50%, #EDE0D0 100%)",
                backgroundSize: "200% 100%",
                animation: "shimmer 1.5s infinite",
                opacity: loaded ? 0 : 1,
                transition: "opacity 0.3s ease",
              }}
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={src}
              alt=""
              draggable={false}
              onLoad={handleImgLoad}
              onError={() => setErrored(true)}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                // SAME formula as FramedPhoto: pan via object-position, zoom via
                // a scale about that same framing point → exact WYSIWYG.
                objectPosition,
                transform: scale > 1 ? `scale(${scale})` : undefined,
                transformOrigin: scale > 1 ? objectPosition : undefined,
                display: "block",
                opacity: loaded ? 1 : 0,
                transition: "opacity 0.3s ease",
                WebkitUserSelect: "none",
                userSelect: "none",
                pointerEvents: "none",
              }}
            />
          </>
        )}
      </div>

      {/* Zoom slider — also reflects pinch/scroll changes (controlled). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          width: frameWidth,
          maxWidth: "100%",
        }}
      >
        <span
          aria-hidden
          style={{
            color: "rgba(255,248,240,0.85)",
            fontSize: "16px",
            width: "14px",
            textAlign: "center",
          }}
        >
          −
        </span>
        <input
          type="range"
          aria-label="Zoom"
          data-testid="reframe-zoom"
          min={MIN_PHOTO_SCALE}
          max={MAX_PHOTO_SCALE}
          step={0.01}
          value={scale}
          disabled={saving || !canZoom}
          onChange={(e) => applyScale(parseFloat(e.target.value))}
          style={{
            flex: 1,
            accentColor: "#C17F5A",
            cursor: saving || !canZoom ? "not-allowed" : "pointer",
          }}
        />
        <span
          aria-hidden
          style={{
            color: "rgba(255,248,240,0.85)",
            fontSize: "16px",
            width: "14px",
            textAlign: "center",
          }}
        >
          ＋
        </span>
      </div>

      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
        <button
          onClick={() => {
            setOffset({ x: 0, y: 0 });
            applyScale(1);
          }}
          disabled={saving}
          style={pillButton("transparent", "rgba(255,248,240,0.9)")}
        >
          Reset
        </button>
        <button
          onClick={onClose}
          disabled={saving}
          style={pillButton("transparent", "rgba(255,248,240,0.9)")}
        >
          Cancel
        </button>
        <button
          onClick={() => onSave({ x: offset.x, y: offset.y, scale })}
          disabled={saving || errored}
          data-testid="reframe-save"
          style={pillButton("#C17F5A", "white", saving || errored)}
        >
          {saving ? "Saving…" : "Save framing"}
        </button>
      </div>
    </div>
  );
}

function pillButton(
  bg: string,
  color: string,
  disabled = false,
): React.CSSProperties {
  return {
    padding: "9px 18px",
    background: bg,
    color,
    border: bg === "transparent" ? "1px solid rgba(255,248,240,0.4)" : "none",
    borderRadius: "100px",
    fontFamily: "var(--font-quicksand), sans-serif",
    fontSize: "11px",
    letterSpacing: "1.5px",
    textTransform: "uppercase",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}
