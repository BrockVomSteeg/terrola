"use client";

import { useEffect, useRef, useState } from "react";
import { offsetForPhoto, photoFilename } from "@/lib/photos";
import FramedPhoto from "./FramedPhoto";

interface PhotoEditGridProps {
  /** Signed URLs in current (authoritative) order. */
  photos: string[];
  offsets?: Record<string, { x: number; y: number; scale?: number }> | null;
  /** The persisted cover URL (photos[0]) — gets the legacy px fallback. */
  coverUrl?: string | null;
  legacyCoverPx?: { x: number; y: number } | null;
  uploading: boolean;
  pendingPreviewUrl?: string | null;
  canAddMore: boolean;
  fallbackEmoji: string;
  fallbackBg: string;
  onAdd: () => void;
  onRemove: (url: string) => void;
  /** Tap a thumbnail → open the reframe overlay for it. */
  onReframe: (url: string) => void;
  /** Drop after a drag-reorder → commit the new order as object names. */
  onReorder: (orderedFilenames: string[]) => void;
}

const THUMB = 60;
const LONG_PRESS_MS = 250;
const MOVE_CANCEL_PX = 10;
const ROW_H = THUMB + 8;

/**
 * Edit-mode photo grid with two gestures on each thumbnail:
 *   - tap            → reframe (open overlay),
 *   - long-press+drag → reorder.
 *
 * Touch-first, hand-rolled pointer DnD (no HTML5 draggable). `touch-action:
 * pan-y` lets the admin panel keep scrolling vertically; a horizontal/still
 * press is captured for the drag. A 250ms long-press (finger still) lifts the
 * thumb; moving >10px before that cancels to a scroll/tap. The lifted thumb is
 * a fixed-position clone that follows the finger; its slot shows a placeholder.
 */
export default function PhotoEditGrid({
  photos,
  offsets,
  coverUrl,
  legacyCoverPx,
  uploading,
  pendingPreviewUrl,
  canAddMore,
  fallbackEmoji,
  fallbackBg,
  onAdd,
  onRemove,
  onReframe,
  onReorder,
}: PhotoEditGridProps) {
  // Working order during a drag (signed URLs). Empty when not dragging.
  const [order, setOrder] = useState<string[]>([]);
  const [dragUrl, setDragUrl] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  const orderRef = useRef<string[]>([]);
  const elRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const gRef = useRef<{
    url: string;
    startX: number;
    startY: number;
    pointerId: number;
    el: HTMLElement;
    timer: ReturnType<typeof setTimeout> | null;
    grabDX: number;
    grabDY: number;
    mode: "pending" | "dragging";
  } | null>(null);

  // Clear any pending long-press timer on unmount.
  useEffect(() => {
    return () => {
      if (gRef.current?.timer) clearTimeout(gRef.current.timer);
    };
  }, []);

  const renderOrder = dragUrl ? order : photos;
  const reorderable = photos.length > 1;

  function setWorkingOrder(next: string[]) {
    orderRef.current = next;
    setOrder(next);
  }

  function startDrag() {
    const g = gRef.current;
    if (!g) return;
    const r = elRefs.current.get(g.url)?.getBoundingClientRect();
    g.grabDX = r ? g.startX - r.left : THUMB / 2;
    g.grabDY = r ? g.startY - r.top : THUMB / 2;
    g.mode = "dragging";
    try {
      g.el.setPointerCapture(g.pointerId);
    } catch {
      /* noop */
    }
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(15);
    }
    setWorkingOrder([...photos]);
    setDragUrl(g.url);
    setPointer({ x: g.startX, y: g.startY });
  }

  function cleanupGesture() {
    const g = gRef.current;
    if (g?.timer) clearTimeout(g.timer);
    if (g) {
      try {
        g.el.releasePointerCapture(g.pointerId);
      } catch {
        /* noop */
      }
    }
    gRef.current = null;
  }

  function onPointerDown(url: string, e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (uploading) return;
    gRef.current = {
      url,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      el: e.currentTarget,
      timer: null,
      grabDX: 0,
      grabDY: 0,
      mode: "pending",
    };
    if (reorderable) {
      gRef.current.timer = setTimeout(startDrag, LONG_PRESS_MS);
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = gRef.current;
    if (!g || e.pointerId !== g.pointerId) return;

    if (g.mode === "pending") {
      const moved = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
      if (moved > MOVE_CANCEL_PX) cleanupGesture(); // scroll / not a long-press
      return;
    }

    // Dragging — suppress scroll and reorder live.
    e.preventDefault();
    const px = e.clientX;
    const py = e.clientY;
    setPointer({ x: px, y: py });

    const others = orderRef.current.filter((u) => u !== g.url);
    let target = 0;
    for (const u of others) {
      const el = elRefs.current.get(u);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // Count thumbs that come before the pointer in reading order.
      if (cy < py - ROW_H / 2 || (Math.abs(cy - py) <= ROW_H / 2 && cx < px)) {
        target++;
      }
    }
    const next = [...others.slice(0, target), g.url, ...others.slice(target)];
    // Only update if the order actually changed (avoids churn).
    if (next.join("\n") !== orderRef.current.join("\n")) {
      setWorkingOrder(next);
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const g = gRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    const wasDragging = g.mode === "dragging";
    const moved = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
    const url = g.url;
    cleanupGesture();

    if (wasDragging) {
      const finalOrder = orderRef.current;
      const before = photos.map((u) => photoFilename(u)).join(",");
      const after = finalOrder.map((u) => photoFilename(u)).join(",");
      setDragUrl(null);
      setPointer(null);
      setWorkingOrder([]);
      if (after !== before && finalOrder.length) {
        onReorder(
          finalOrder
            .map((u) => photoFilename(u))
            .filter((n): n is string => !!n),
        );
      }
    } else if (moved <= MOVE_CANCEL_PX) {
      // A clean tap → reframe.
      onReframe(url);
    }
  }

  function onPointerCancel(e: React.PointerEvent<HTMLDivElement>) {
    const g = gRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    cleanupGesture();
    if (dragUrl) {
      setDragUrl(null);
      setPointer(null);
      setWorkingOrder([]);
    }
  }

  function thumbOffset(url: string) {
    return offsetForPhoto(url, offsets);
  }
  function thumbLegacy(url: string) {
    return coverUrl && url === coverUrl ? (legacyCoverPx ?? null) : null;
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
      {renderOrder.map((url) => {
        const isDragged = url === dragUrl;
        return (
          <div
            key={url}
            data-testid="edit-photo-thumb"
            ref={(el) => {
              if (el) elRefs.current.set(url, el);
              else elRefs.current.delete(url);
            }}
            onPointerDown={(e) => onPointerDown(url, e)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            style={{
              position: "relative",
              width: `${THUMB}px`,
              height: `${THUMB}px`,
              flexShrink: 0,
              borderRadius: "8px",
              touchAction: isDragged ? "none" : "pan-y",
              cursor: reorderable ? "grab" : "pointer",
            }}
          >
            {isDragged ? (
              // Placeholder gap left behind by the lifted thumb.
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  borderRadius: "8px",
                  border: "1.5px dashed rgba(193,127,90,0.5)",
                  background: "rgba(193,127,90,0.08)",
                }}
              />
            ) : (
              <>
                <FramedPhoto
                  src={url}
                  alt=""
                  width="100%"
                  height="100%"
                  rounded="8px"
                  offset={thumbOffset(url)}
                  legacyOffsetPx={thumbLegacy(url)}
                  fallbackEmoji={fallbackEmoji}
                  fallbackBg={fallbackBg}
                />
                {!uploading && (
                  <button
                    onClick={() => onRemove(url)}
                    onPointerDown={(e) => e.stopPropagation()}
                    title="Remove photo"
                    aria-label="Remove photo"
                    style={removeBtnStyle}
                  >
                    ×
                  </button>
                )}
                {/* Crop badge — signals "tap to adjust framing". Visual only
                    (pointerEvents:none) so the tap-to-reframe / long-press-to-
                    reorder gestures on the thumb are untouched. */}
                <span aria-hidden style={cropBadgeStyle}>
                  <CropIcon />
                </span>
              </>
            )}
          </div>
        );
      })}

      {/* Pending upload preview */}
      {uploading && pendingPreviewUrl && (
        <div
          style={{
            position: "relative",
            width: `${THUMB}px`,
            height: `${THUMB}px`,
            flexShrink: 0,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pendingPreviewUrl}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              borderRadius: "8px",
              display: "block",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(250,246,240,0.7)",
              borderRadius: "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                width: "14px",
                height: "14px",
                border: "2px solid rgba(193,127,90,0.4)",
                borderTopColor: "#C17F5A",
                borderRadius: "50%",
                animation: "spin 0.6s linear infinite",
                display: "inline-block",
              }}
            />
          </div>
        </div>
      )}

      {/* Add tile */}
      {canAddMore && !uploading && !dragUrl && (
        <div
          onClick={onAdd}
          style={{
            width: `${THUMB}px`,
            height: `${THUMB}px`,
            flexShrink: 0,
            border: "1.5px dashed rgba(193,127,90,0.35)",
            borderRadius: "8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "#C0A898",
            fontSize: "20px",
          }}
        >
          +
        </div>
      )}

      {/* Lifted clone following the finger */}
      {dragUrl && pointer && (
        <div
          style={{
            position: "fixed",
            left: pointer.x - (gRef.current?.grabDX ?? THUMB / 2),
            top: pointer.y - (gRef.current?.grabDY ?? THUMB / 2),
            width: `${THUMB}px`,
            height: `${THUMB}px`,
            borderRadius: "8px",
            boxShadow: "0 8px 24px rgba(74,55,40,0.35)",
            transform: "scale(1.1)",
            pointerEvents: "none",
            zIndex: 1000,
            overflow: "hidden",
          }}
        >
          <FramedPhoto
            src={dragUrl}
            alt=""
            width="100%"
            height="100%"
            rounded="8px"
            offset={thumbOffset(dragUrl)}
            legacyOffsetPx={thumbLegacy(dragUrl)}
            fallbackEmoji={fallbackEmoji}
            fallbackBg={fallbackBg}
          />
        </div>
      )}
    </div>
  );
}

const CropIcon = () => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 2v14a2 2 0 0 0 2 2h14" />
    <path d="M18 22V8a2 2 0 0 0-2-2H2" />
  </svg>
);

const cropBadgeStyle: React.CSSProperties = {
  position: "absolute",
  bottom: "3px",
  left: "3px",
  width: "16px",
  height: "16px",
  borderRadius: "50%",
  background: "rgba(74,55,40,0.78)",
  color: "white",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  zIndex: 2,
};

const removeBtnStyle: React.CSSProperties = {
  position: "absolute",
  top: "-6px",
  right: "-6px",
  width: "18px",
  height: "18px",
  borderRadius: "50%",
  background: "#4A3728",
  color: "white",
  border: "none",
  cursor: "pointer",
  fontSize: "11px",
  lineHeight: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  zIndex: 2,
};
