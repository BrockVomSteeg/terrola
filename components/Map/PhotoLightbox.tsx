"use client";

import { useState, useEffect, useRef, useCallback } from "react";

const CropIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 2v14a2 2 0 0 0 2 2h14" />
    <path d="M18 22V8a2 2 0 0 0-2-2H2" />
  </svg>
);

interface PhotoLightboxProps {
  photos: string[];
  initialIndex: number;
  onClose: () => void;
  /**
   * Optional: open the reframe editor for the photo currently in view. When
   * provided, an explicit "Adjust framing" control is shown (touch + desktop).
   * The lightbox stays a full-photo viewer — this is only an entry point.
   */
  onReframe?: (photoUrl: string) => void;
}

export default function PhotoLightbox({
  photos,
  initialIndex,
  onClose,
  onReframe,
}: PhotoLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [visible, setVisible] = useState(false);
  const [isWide, setIsWide] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [touchOffset, setTouchOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);
  const [scale, setScale] = useState(1);
  const touchStartY = useRef<number | null>(null);
  const touchStartX = useRef<number | null>(null);
  const swipeAxisRef = useRef<"horizontal" | "vertical" | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const pinchStartDistance = useRef<number | null>(null);
  const pinchStartScale = useRef<number>(1);
  const lastTapTimeRef = useRef<number>(0);

  useEffect(() => {
    setIsWide(window.innerWidth > 768);
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => {
      cancelAnimationFrame(frame);
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= photos.length) return;
      setCurrentIndex(index);
      setScale(1);
    },
    [photos.length],
  );

  // Reset zoom whenever the active photo changes (incl. swipe nav)
  useEffect(() => {
    setScale(1);
  }, [currentIndex]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") goTo(currentIndex - 1);
      if (e.key === "ArrowRight") goTo(currentIndex + 1);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, currentIndex, goTo]);

  useEffect(() => {
    const el = lightboxRef.current;
    if (!el) return;
    const handler = (e: TouchEvent) => {
      // Pinch — two fingers
      if (e.touches.length >= 2 && pinchStartDistance.current !== null) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const next =
          pinchStartScale.current * (dist / pinchStartDistance.current);
        setScale(Math.min(4, Math.max(1, next)));
        e.preventDefault();
        return;
      }

      if (touchStartY.current === null || touchStartX.current === null) return;
      // When zoomed in, suppress pan/swipe gestures so user can release fingers
      if (scale > 1) return;

      const deltaY = e.touches[0].clientY - touchStartY.current;
      const deltaX = e.touches[0].clientX - touchStartX.current;

      if (swipeAxisRef.current === null) {
        if (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8) {
          swipeAxisRef.current =
            Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
        }
      }

      if (swipeAxisRef.current === "horizontal") {
        setTouchOffset(deltaX);
        e.preventDefault();
      } else if (swipeAxisRef.current === "vertical" && deltaY > 0) {
        setDragOffset(deltaY);
        e.preventDefault();
      }
    };
    el.addEventListener("touchmove", handler, { passive: false });
    return () => el.removeEventListener("touchmove", handler);
  }, [scale]);

  function handleTouchStart(e: React.TouchEvent) {
    if (e.touches.length >= 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDistance.current = Math.hypot(dx, dy) || 1;
      pinchStartScale.current = scale;
      // Cancel any in-progress single-finger swipe
      touchStartY.current = null;
      touchStartX.current = null;
      swipeAxisRef.current = null;
      setIsSwiping(false);
      return;
    }
    touchStartY.current = e.touches[0].clientY;
    touchStartX.current = e.touches[0].clientX;
    swipeAxisRef.current = null;
    setIsSwiping(true);
  }

  function handleTouchEnd(e: React.TouchEvent) {
    // End of pinch gesture
    if (pinchStartDistance.current !== null) {
      pinchStartDistance.current = null;
      // If a second finger is still down, keep waiting for full release
      if (e.touches.length > 0) return;
      setIsSwiping(false);
      return;
    }

    if (touchStartY.current === null || touchStartX.current === null) {
      setIsSwiping(false);
      return;
    }
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    const tapDist = Math.hypot(deltaX, deltaY);
    touchStartY.current = null;
    touchStartX.current = null;
    swipeAxisRef.current = null;

    // Double-tap: toggle zoom
    if (tapDist < 8) {
      const now = Date.now();
      if (now - lastTapTimeRef.current < 300) {
        setScale((prev) => (prev > 1 ? 1 : 2));
        lastTapTimeRef.current = 0;
        setTouchOffset(0);
        setDragOffset(0);
        setIsSwiping(false);
        return;
      }
      lastTapTimeRef.current = now;
    }

    // When zoomed in, ignore swipe gestures
    if (scale > 1) {
      setTouchOffset(0);
      setDragOffset(0);
      setIsSwiping(false);
      return;
    }

    if (Math.abs(deltaY) > Math.abs(deltaX) && deltaY > 80) {
      setIsDismissing(true);
      setIsSwiping(false);
      dismissTimerRef.current = setTimeout(() => onClose(), 380);
      return;
    }
    if (dragOffset > 0) setDragOffset(0);

    if (Math.abs(deltaX) > 40 && Math.abs(deltaX) > Math.abs(deltaY)) {
      const next = deltaX > 0 ? currentIndex - 1 : currentIndex + 1;
      if (next >= 0 && next < photos.length) {
        setCurrentIndex(next);
      }
    }
    setTouchOffset(0);
    setIsSwiping(false);
  }

  return (
    <div
      ref={lightboxRef}
      className="photo-lightbox"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        paddingTop: "env(safe-area-inset-top)",
        background: "rgba(250, 246, 240, 0.15)",
        backdropFilter: "blur(40px) brightness(0.15)",
        WebkitBackdropFilter: "blur(40px) brightness(0.15)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        transform: isDismissing
          ? "translateY(100vh)"
          : `translateY(${dragOffset}px)`,
        opacity: !visible
          ? 0
          : isDismissing
            ? 0
            : Math.max(0, 1 - dragOffset / 300),
        transition:
          dragOffset > 0 && !isDismissing
            ? "none"
            : "transform 380ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 380ms ease",
        willChange: "transform, opacity",
      }}
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Sliding photo strip */}
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          transform: `translateX(calc(${-currentIndex * 100}vw + ${touchOffset}px))`,
          transition: isSwiping
            ? "none"
            : "transform 350ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          willChange: "transform",
        }}
      >
        {photos.map((src, i) => {
          // Only the current photo and its immediate neighbours are given a
          // `src`, so only they download. Swiping/arrowing moves one photo at a
          // time, so the destination is ALWAYS already preloaded — and a 5-photo
          // lightbox does not fetch all ~5 full-resolution images (~2 MB
          // measured) the instant it opens, which would starve the photo you're looking
          // at. We gate the `src` attribute rather than `loading="lazy"` because
          // these photos are translated off-screen (not scrolled), so the lazy
          // heuristic doesn't reliably defer them on WebKit/Safari.
          const inWindow = Math.abs(i - currentIndex) <= 1;
          return (
            <div
              key={`${i}-${src}`}
              style={{
                width: "100vw",
                minWidth: "100vw",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={inWindow ? src : undefined}
                alt=""
                draggable={false}
                decoding="async"
                fetchPriority={i === currentIndex ? "high" : "auto"}
                style={{
                  maxWidth: "100vw",
                  maxHeight: "100vh",
                  objectFit: "contain",
                  WebkitUserSelect: "none",
                  userSelect: "none",
                  transform:
                    i === currentIndex ? `scale(${scale})` : "scale(1)",
                  transformOrigin: "center center",
                  transition:
                    i === currentIndex && scale === 1
                      ? "transform 0.2s ease"
                      : "none",
                  touchAction: "none",
                }}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          );
        })}
      </div>

      {/* Drag handle */}
      <div
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top, 0px) + 10px)",
          left: "50%",
          transform: "translateX(-50%)",
          width: "36px",
          height: "2px",
          background: "rgba(255, 220, 180, 0.35)",
          borderRadius: "2px",
          pointerEvents: "none",
        }}
      />

      {/* Close button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close"
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top, 0px) + 8px)",
          right: "16px",
          width: "56px",
          height: "56px",
          background: "rgba(255,255,255,0.35)",
          border: "none",
          borderRadius: "50%",
          color: "white",
          fontSize: "28px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
        }}
      >
        ×
      </button>

      {/* Adjust framing — explicit entry to the reframe editor (touch + desktop).
          Bottom-center, above the counter; stopPropagation so it never dismisses
          the lightbox. The lightbox itself stays a full-photo viewer. */}
      {onReframe && photos[currentIndex] && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onReframe(photos[currentIndex]);
          }}
          aria-label="Adjust framing"
          data-testid="lightbox-reframe"
          style={{
            position: "absolute",
            // Sit clearly ABOVE the photo counter (which renders at +24px on
            // multi-photo) so the two never overlap; single-photo has no counter.
            bottom: `calc(env(safe-area-inset-bottom, 0px) + ${
              photos.length > 1 ? 72 : 24
            }px)`,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: "7px",
            padding: "9px 16px",
            background: "rgba(255,255,255,0.92)",
            border: "none",
            borderRadius: "100px",
            color: "#4A3728",
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "12px",
            letterSpacing: "0.8px",
            fontWeight: 600,
            cursor: "pointer",
            boxShadow: "0 2px 14px rgba(0,0,0,0.25)",
            whiteSpace: "nowrap",
          }}
        >
          <CropIcon />
          Adjust framing
        </button>
      )}

      {/* Left nav — desktop only */}
      {isWide && currentIndex > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            goTo(currentIndex - 1);
          }}
          aria-label="Previous photo"
          style={{
            position: "absolute",
            left: "20px",
            top: "50%",
            transform: "translateY(-50%)",
            width: "44px",
            height: "44px",
            background: "rgba(255,255,255,0.12)",
            border: "none",
            borderRadius: "50%",
            color: "white",
            fontSize: "26px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ‹
        </button>
      )}

      {/* Right nav — desktop only */}
      {isWide && currentIndex < photos.length - 1 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            goTo(currentIndex + 1);
          }}
          aria-label="Next photo"
          style={{
            position: "absolute",
            right: "20px",
            top: "50%",
            transform: "translateY(-50%)",
            width: "44px",
            height: "44px",
            background: "rgba(255,255,255,0.12)",
            border: "none",
            borderRadius: "50%",
            color: "white",
            fontSize: "26px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ›
        </button>
      )}

      {/* Counter */}
      {photos.length > 1 && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(env(safe-area-inset-bottom, 0px) + 24px)",
            left: "50%",
            transform: "translateX(-50%)",
            color: "rgba(255,255,255,0.7)",
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "13px",
            letterSpacing: "1px",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {currentIndex + 1} / {photos.length}
        </div>
      )}
    </div>
  );
}
