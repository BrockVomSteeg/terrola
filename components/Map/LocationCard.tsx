"use client";

import { useEffect, useState, useRef } from "react";
import { CATEGORIES } from "@/lib/constants";
import {
  offsetForPhoto,
  photoFilename,
  cardSurfaceAspect,
  mergePhotoOffset,
} from "@/lib/photos";
import { api } from "@/lib/api-client";
import type { Location } from "@/types";
import FramedPhoto from "./FramedPhoto";
import PhotoLightbox from "./PhotoLightbox";
import ReframeOverlay from "./ReframeOverlay";

interface LocationCardProps {
  location: Location;
  onClose: () => void;
  onEdit: (location: Location) => void;
  onDelete: (location: Location) => void;
  /** Persist a reframe done from the lightbox back into app state (map + list). */
  onLocationUpdated?: (location: Location) => void;
  /** The public demo: no edit, no remove, no reframe. */
  readOnly?: boolean;
}

const PencilIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const TrashIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14H6L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4h6v2" />
  </svg>
);

export default function LocationCard({
  location,
  onClose,
  onEdit,
  onDelete,
  onLocationUpdated,
  readOnly = false,
}: LocationCardProps) {
  const [visible, setVisible] = useState(false);
  const [activePhotoIndex, setActivePhotoIndex] = useState(0);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(
    null,
  );
  // View-mode reframe (opened from the lightbox). Reuses ReframeOverlay +
  // photo_offsets exactly like the edit-mode path, so the result renders
  // identically on the card / timeline / edit grid.
  const [reframePhotoUrl, setReframePhotoUrl] = useState<string | null>(null);
  const [reframeSaving, setReframeSaving] = useState(false);
  const [reframeAspect, setReframeAspect] = useState(1.65);
  // Fresh signed URLs (full + thumbnail), tagged with the location they belong
  // to so a previous pin's photos can never flash when you tap a different pin.
  const [fetched, setFetched] = useState<{
    id: string;
    urls: string[];
    thumbs: string[];
    cards: string[];
  }>({
    id: "",
    urls: [],
    thumbs: [],
    cards: [],
  });
  const stripRef = useRef<HTMLDivElement>(null);
  const pointerDownX = useRef<number | null>(null);
  const pointerDownY = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef<number | null>(null);
  const dragStartX = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);
  const [isDismissing, setIsDismissing] = useState(false);

  const cat = CATEGORIES[location.category] ?? CATEGORIES.everyday;

  // Legacy cover pixel offset, kept ONLY as a read fallback for a cover framed
  // with a pixel offset. Reframing happens in the edit overlay and writes a
  // normalized `photo_offsets[<objectName>]`.
  const legacyCoverPx = {
    x: location.photo_offset_x ?? 0,
    y: location.photo_offset_y ?? 0,
  };

  // Normalized framing offset for a photo by its stable object name. The cover
  // (index 0) additionally falls back to the legacy pixel offset, applied
  // inside FramedPhoto via the `legacyOffsetPx` prop.
  function offsetFor(url: string | undefined) {
    return offsetForPhoto(url, location.photo_offsets);
  }

  // Fetch fresh signed URLs on mount and whenever photo_url changes (poll sync).
  // We mark the fetch resolved on BOTH success and failure, so the loading slots
  // always settle: a failed or empty refetch must never leave a slot spinning.
  // A failed read is not "no photos": the card keeps the photos it already has for
  // this place. Only a first read that fails settles to the cover fallback below.
  useEffect(() => {
    const id = location.id;
    if (!id) return;
    let cancelled = false;
    fetch(`/api/locations/${id}/photo`)
      .then((r) => {
        if (!r.ok) throw new Error(`photo list failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled)
          setFetched({
            id,
            urls: data.photos ?? [],
            thumbs: data.thumbs ?? [],
            cards: data.cards ?? [],
          });
      })
      .catch(() => {
        if (!cancelled)
          setFetched((prev) =>
            prev.id === id ? prev : { id, urls: [], thumbs: [], cards: [] },
          );
      });
    return () => {
      cancelled = true;
    };
  }, [location.id, location.photo_url]);

  // Has the fresh refetch for THIS location resolved (success OR failure)?
  const resolved = fetched.id === location.id;
  const freshList = resolved ? fetched.urls : [];

  // The URLs we actually render. Once resolved we trust the fresh set (falling
  // back to the freshened cover URL if the refetch came back empty but a cover
  // exists). We NEVER render the stored `location.photos` URLs — they may be
  // expired and 403, which would flash the emoji.
  const resolvedList: string[] = resolved
    ? freshList.length
      ? freshList
      : location.photo_url
        ? [location.photo_url]
        : []
    : [];

  // Thumbnails aligned to resolvedList (thumbs[i] ↔ photos[i]). Empty entries
  // mean "no thumbnail yet" — FramedPhoto falls back to the full URL.
  const freshThumbs = resolved ? fetched.thumbs : [];
  const resolvedThumbs: string[] = resolved
    ? freshList.length
      ? freshThumbs
      : location.photo_thumb_url
        ? [location.photo_thumb_url]
        : []
    : [];

  // Card-tier images aligned to resolvedList (cards[i] ↔ photos[i]). Empty
  // entries mean "no card image yet" — FramedPhoto falls back to the full URL.
  const freshCards = resolved ? fetched.cards : [];
  const resolvedCards: string[] = resolved
    ? freshList.length
      ? freshCards
      : location.photo_card_url
        ? [location.photo_card_url]
        : []
    : [];

  // Photo count. Exact once resolved; while pending, the stored count so the
  // strip doesn't reflow when the fresh set lands.
  const knownCount = resolved
    ? resolvedList.length
    : location.photos?.length || (location.photo_url ? 1 : 0);

  // One render slot per photo. While pending, slot 0 starts from the freshened
  // cover thumbnail/URL (loads instantly) and the rest show a loading state —
  // never the emoji. Once resolved, every slot is settled (no infinite spinner).
  // `lqip` applies only to slot 0 (the cover) — it's the only one shipped inline.
  type Slot = {
    src: string | null;
    thumb: string | null;
    card: string | null;
    loading: boolean;
    lqip: string | null;
  };
  const slots: Slot[] = Array.from({ length: knownCount }, (_, i) => {
    const lqip = i === 0 ? (location.cover_lqip ?? null) : null;
    if (resolved)
      return {
        src: resolvedList[i] ?? null,
        thumb: resolvedThumbs[i] ?? null,
        card: resolvedCards[i] ?? null,
        loading: false,
        lqip,
      };
    if (i === 0 && location.photo_url)
      return {
        src: location.photo_url,
        thumb: location.photo_thumb_url ?? null,
        card: location.photo_card_url ?? null,
        loading: false,
        lqip,
      };
    return { src: null, thumb: null, card: null, loading: true, lqip };
  });

  // Real URLs for the lightbox (it opens on tap, by which point these exist).
  const lightboxPhotos: string[] = resolvedList.length
    ? resolvedList
    : location.photo_url
      ? [location.photo_url]
      : [];

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    // Slack before the card starts following the finger: only ENGAGE the
    // swipe-to-dismiss once the gesture has clearly moved DOWN past this
    // dead-zone AND is dominantly vertical. Without it the card slid on the
    // first downward pixel, so an incidental touch (or a near-horizontal photo
    // swipe) made the whole card "move around." Subtracting the dead-zone keeps
    // the follow continuous (no jump at engage).
    const DISMISS_DEADZONE = 8;
    const handler = (e: TouchEvent) => {
      if (dragStartY.current === null || dragStartX.current === null) return;
      const deltaY = e.touches[0].clientY - dragStartY.current;
      const deltaX = e.touches[0].clientX - dragStartX.current;
      if (deltaY > DISMISS_DEADZONE && Math.abs(deltaY) > Math.abs(deltaX)) {
        setDragY(deltaY - DISMISS_DEADZONE);
        e.preventDefault();
      }
    };
    el.addEventListener("touchmove", handler, { passive: false });
    return () => el.removeEventListener("touchmove", handler);
  }, []);

  // Reset strip position when location changes. (Fresh URLs invalidate on their
  // own since they're tagged with the location id.)
  useEffect(() => {
    setActivePhotoIndex(0);
    setSelectedPhotoIndex(null);
    setReframePhotoUrl(null);
  }, [location.id]);

  // Keep the reframe preview aspect matched to the card surface (WYSIWYG) —
  // recomputed when the editor opens and on resize/rotate, all client-side.
  useEffect(() => {
    if (!reframePhotoUrl) return;
    const update = () => setReframeAspect(cardSurfaceAspect(knownCount));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [reframePhotoUrl, knownCount]);

  // Enter or Space on a focused photo opens it, like a click (docs/accessibility.md).
  // The photos stay divs with a button role: they hold FramedPhoto's divs, which a
  // real button may not contain.
  function openPhotoOnKey(
    e: React.KeyboardEvent<HTMLDivElement>,
    index: number,
  ) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    setSelectedPhotoIndex(index);
  }

  function handleStripScroll(e: React.UIEvent<HTMLDivElement>) {
    const { scrollLeft, clientWidth } = e.currentTarget;
    if (clientWidth > 0)
      setActivePhotoIndex(Math.round(scrollLeft / clientWidth));
  }

  // Persist a reframe done from the lightbox — same PATCH + photo_offsets shape
  // as the edit-mode path, so it renders identically everywhere. Keeps the
  // overlay open on failure so the user can retry.
  async function handleReframeSave(offset: {
    x: number;
    y: number;
    scale: number;
  }) {
    if (!reframePhotoUrl) return;
    const newOffsets = mergePhotoOffset(
      location.photo_offsets,
      reframePhotoUrl,
      offset,
    );
    if (!newOffsets) {
      setReframePhotoUrl(null);
      return;
    }
    setReframeSaving(true);
    try {
      const updated = await api.setPhotoOffsets(location.id, newOffsets);
      onLocationUpdated?.(updated);
      setReframePhotoUrl(null);
    } catch {
      // Leave the overlay open so the chosen framing isn't lost on a transient
      // failure; the user can hit Save again.
    } finally {
      setReframeSaving(false);
    }
  }

  return (
    <>
      <div
        ref={cardRef}
        style={{
          position: "fixed",
          // The same safe area term as the map's bottom left corner, so the Mapbox
          // controls keep their room under the card (MapCanvas.tsx).
          bottom: "calc(32px + env(safe-area-inset-bottom, 0px))",
          left: "max(336px, env(safe-area-inset-left, 0px) + 336px)",
          width: "340px",
          opacity: !visible ? 0 : isDismissing ? 0 : 1,
          transform: !visible
            ? "translateY(20px)"
            : isDismissing
              ? "translateY(100vh)"
              : `translateY(${dragY}px)`,
          transition:
            dragY > 0 && !isDismissing
              ? "none"
              : "opacity 0.25s ease-out, transform 0.25s ease-out",
          zIndex: 30,
        }}
        className="location-card"
        onTouchStart={(e) => {
          dragStartY.current = e.touches[0].clientY;
          dragStartX.current = e.touches[0].clientX;
        }}
        onTouchEnd={() => {
          dragStartY.current = null;
          dragStartX.current = null;
          if (dragY > 60) {
            setIsDismissing(true);
            setTimeout(() => onClose(), 250);
          } else {
            setDragY(0);
          }
        }}
      >
        <div
          style={{
            background: "#FAF6F0",
            borderRadius: "16px",
            border: "1px solid rgba(193,127,90,0.2)",
            boxShadow: "0 4px 32px rgba(74,55,40,0.12)",
            overflow: "hidden",
            position: "relative",
          }}
        >
          {/* Drag handle — signals swipe-down-to-dismiss */}
          <div
            style={{
              position: "absolute",
              top: "6px",
              left: "50%",
              transform: "translateX(-50%)",
              width: "32px",
              height: "3px",
              background: "rgba(139,94,60,0.3)",
              borderRadius: "2px",
              zIndex: 5,
              pointerEvents: "none",
            }}
          />
          {/* Multi-photo strip */}
          {knownCount > 1 && (
            <div>
              <div
                ref={stripRef}
                className="photo-strip"
                style={{
                  display: "flex",
                  overflowX: "scroll",
                  WebkitOverflowScrolling: "touch",
                  height: "200px",
                }}
                onScroll={handleStripScroll}
                onPointerDown={(e) => {
                  pointerDownX.current = e.clientX;
                  pointerDownY.current = e.clientY;
                }}
                onPointerUp={(e) => {
                  if (pointerDownX.current === null) return;
                  const dx = Math.abs(e.clientX - pointerDownX.current);
                  const dy = Math.abs(e.clientY - pointerDownY.current!);
                  pointerDownX.current = null;
                  pointerDownY.current = null;
                  const strip = stripRef.current;
                  if (!strip) return;
                  if (dx <= 8 && dy <= 8) {
                    const index = Math.round(
                      strip.scrollLeft / strip.clientWidth,
                    );
                    setSelectedPhotoIndex(index);
                  }
                }}
              >
                {slots.map((slot, i) => (
                  <div
                    key={i}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open photo ${i + 1} of ${knownCount}`}
                    className="photo-open"
                    onKeyDown={(e) => openPhotoOnKey(e, i)}
                    style={{
                      position: "relative",
                      width: "100%",
                      minWidth: "100%",
                      height: "200px",
                      flexShrink: 0,
                      scrollSnapAlign: "start",
                      overflow: "hidden",
                      cursor: "pointer",
                    }}
                  >
                    <FramedPhoto
                      src={slot.src}
                      thumbSrc={slot.thumb}
                      cardSrc={slot.card}
                      // Only the visible slot sharpens to the ~1152px card image;
                      // off-screen slots stay on the cheap thumb until swiped to
                      // (mirrors the lightbox current±1 idea — no over-fetch).
                      sharpTarget={i === activePhotoIndex ? "card" : "thumb"}
                      lqip={slot.lqip}
                      loading={slot.loading}
                      alt={location.title}
                      width="100%"
                      height="200px"
                      offset={offsetFor(slot.src ?? undefined)}
                      legacyOffsetPx={i === 0 ? legacyCoverPx : null}
                      fallbackEmoji={cat.emoji}
                      fallbackBg={cat.bg}
                      eager={i === 0}
                    />
                  </div>
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  gap: "5px",
                  padding: "6px 0 2px",
                }}
              >
                {slots.map((_, i) => (
                  <div
                    key={i}
                    style={{
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      background:
                        i === activePhotoIndex ? "#C17F5A" : "transparent",
                      border: "1.5px solid #C17F5A",
                      transition: "background 0.2s",
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Single photo — tap to open lightbox */}
          {knownCount === 1 && (
            <div
              role="button"
              tabIndex={0}
              aria-label={`Open photo of ${location.title}`}
              className="photo-open"
              onClick={() => setSelectedPhotoIndex(0)}
              onKeyDown={(e) => openPhotoOnKey(e, 0)}
              style={{
                position: "relative",
                height: "160px",
                cursor: "pointer",
              }}
            >
              <FramedPhoto
                src={slots[0].src}
                thumbSrc={slots[0].thumb}
                cardSrc={slots[0].card}
                // The single cover always sharpens to the ~1152px card image
                // (crisp at DPR 3), with the thumb as the instant placeholder.
                sharpTarget="card"
                lqip={slots[0].lqip}
                loading={slots[0].loading}
                alt={location.title}
                width="100%"
                height="160px"
                rounded="12px 12px 0 0"
                offset={offsetFor(slots[0].src ?? undefined)}
                legacyOffsetPx={legacyCoverPx}
                fallbackEmoji={cat.emoji}
                fallbackBg={cat.bg}
                eager
              />
            </div>
          )}

          <div style={{ padding: "20px 24px", position: "relative" }}>
            {/* Close button */}
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                position: "absolute",
                top: "10px",
                right: "10px",
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: "18px",
                color: "#786459",
                lineHeight: 1,
                padding: "2px 6px",
              }}
            >
              &times;
            </button>

            {/* Category pill */}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "3px 10px",
                borderRadius: "100px",
                background: cat.bg,
                color: cat.color,
                fontFamily: "var(--font-quicksand), sans-serif",
                fontSize: "10px",
                letterSpacing: "1.5px",
                textTransform: "uppercase",
                fontWeight: 500,
              }}
            >
              {cat.emoji} {cat.label}
            </span>

            {/* Title */}
            <h2
              style={{
                fontFamily: "var(--font-cormorant), serif",
                fontSize: "26px",
                fontWeight: 400,
                color: "#4A3728",
                margin: "8px 0 4px",
                lineHeight: 1.2,
                paddingRight: "24px",
              }}
            >
              {location.title}
            </h2>

            {/* Date */}
            <p
              style={{
                fontFamily: "var(--font-cormorant), serif",
                fontStyle: "italic",
                fontSize: "15px",
                color: "#786459",
                margin: 0,
              }}
            >
              {location.date_label}
            </p>

            {/* Divider */}
            <hr
              style={{
                border: "none",
                borderTop: "1px solid rgba(193,127,90,0.18)",
                margin: "12px 0",
              }}
            />

            {/* Description */}
            {location.description && (
              <p
                style={{
                  fontFamily: "var(--font-quicksand), sans-serif",
                  fontSize: "14px",
                  color: "#6B5248",
                  lineHeight: 1.7,
                  margin: 0,
                }}
              >
                {location.description}
              </p>
            )}

            {/* Action buttons: none in the read only demo */}
            {!readOnly && (
              <>
                <hr
                  style={{
                    border: "none",
                    borderTop: "1px solid rgba(193,127,90,0.12)",
                    margin: "14px 0 10px",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    gap: "4px",
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    onClick={() => {
                      onEdit(location);
                      onClose();
                    }}
                    title="Edit this place"
                    aria-label="Edit this place"
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "#786459",
                      padding: "4px 6px",
                      display: "flex",
                      alignItems: "center",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.color =
                        "#C17F5A";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.color =
                        "#786459";
                    }}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    onClick={() => {
                      onDelete(location);
                      onClose();
                    }}
                    title="Remove this place"
                    aria-label="Remove this place"
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "#786459",
                      padding: "4px 6px",
                      display: "flex",
                      alignItems: "center",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.color =
                        "#e05c6b";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.color =
                        "#786459";
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <style>{`
          @media (max-width: 767px) {
            .location-card {
              left: 16px !important;
              right: 16px !important;
              width: auto !important;
              bottom: 96px !important;
            }
          }
          @media (min-width: 768px) and (max-width: 1023px) {
            .location-card {
              left: calc(50% - 190px) !important;
              width: 380px !important;
              bottom: calc(32px + env(safe-area-inset-bottom, 0px)) !important;
            }
          }
        `}</style>
      </div>

      {selectedPhotoIndex !== null && lightboxPhotos.length > 0 && (
        <PhotoLightbox
          photos={lightboxPhotos}
          initialIndex={Math.min(selectedPhotoIndex, lightboxPhotos.length - 1)}
          onClose={() => setSelectedPhotoIndex(null)}
          onReframe={
            readOnly
              ? undefined
              : (url) => {
                  // Close the lightbox and open the reframe editor on top of the card.
                  setSelectedPhotoIndex(null);
                  setReframePhotoUrl(url);
                }
          }
        />
      )}

      {reframePhotoUrl && (
        <ReframeOverlay
          src={reframePhotoUrl}
          initialOffset={offsetFor(reframePhotoUrl)}
          initialLegacyPx={
            photoFilename(reframePhotoUrl) === photoFilename(location.photo_url)
              ? legacyCoverPx
              : null
          }
          previewAspect={reframeAspect}
          saving={reframeSaving}
          fallbackEmoji={cat.emoji}
          fallbackBg={cat.bg}
          onSave={handleReframeSave}
          onClose={() => setReframePhotoUrl(null)}
        />
      )}
    </>
  );
}
