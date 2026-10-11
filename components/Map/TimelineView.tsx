"use client";

import { useState } from "react";
import { CATEGORIES } from "@/lib/constants";
import { offsetForPhoto } from "@/lib/photos";
import type { Location, CategoryKey } from "@/types";
import FramedPhoto from "./FramedPhoto";

interface TimelineViewProps {
  locations: Location[];
  onSelect: (location: Location) => void;
  onViewChange: (v: "map" | "timeline") => void;
  onMobileClose?: () => void;
  isMobile?: boolean;
}

export default function TimelineView({
  locations,
  onSelect,
  onViewChange,
  onMobileClose,
  isMobile,
}: TimelineViewProps) {
  const [highlightId, setHighlightId] = useState<string | null>(null);

  function handleRowClick(loc: Location) {
    onSelect(loc);
    setHighlightId(loc.id);
    setTimeout(() => setHighlightId(null), 2000);
    if (isMobile) {
      onViewChange("map");
      onMobileClose?.();
    }
  }

  const sorted = [...locations].sort((a, b) =>
    b.date_label.localeCompare(a.date_label),
  );

  return (
    <div>
      {isMobile && (
        <button
          onClick={() => {
            onViewChange("map");
            onMobileClose?.();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "12px 20px",
            background: "none",
            border: "none",
            borderBottom: "1px solid rgba(193,127,90,0.08)",
            cursor: "pointer",
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "11px",
            letterSpacing: "1.5px",
            textTransform: "uppercase",
            color: "#C17F5A",
            width: "100%",
          }}
        >
          ← Back to map
        </button>
      )}

      {locations.length === 0 ? (
        <div
          style={{
            padding: "48px 20px",
            textAlign: "center",
            color: "#9B8578",
            fontFamily: "var(--font-cormorant), serif",
            fontStyle: "italic",
            fontSize: "16px",
          }}
        >
          No places to show yet
        </div>
      ) : (
        sorted.map((loc) => {
          const cat =
            CATEGORIES[loc.category as CategoryKey] ?? CATEGORIES.everyday;
          const highlighted = highlightId === loc.id;
          return (
            <TimelineRow
              key={loc.id}
              location={loc}
              cat={cat}
              highlighted={highlighted}
              onClick={() => handleRowClick(loc)}
            />
          );
        })
      )}
    </div>
  );
}

interface RowCat {
  emoji: string;
  label: string;
  bg: string;
  color: string;
}

function TimelineRow({
  location,
  cat,
  highlighted,
  onClick,
}: {
  location: Location;
  cat: RowCat;
  highlighted: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      data-testid={`timeline-row-${location.id}`}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        gap: "12px",
        padding: "12px 20px",
        borderBottom: "1px solid rgba(193,127,90,0.08)",
        cursor: "pointer",
        background: highlighted
          ? "rgba(193,127,90,0.10)"
          : hovered
            ? "rgba(193,127,90,0.05)"
            : "transparent",
        transition: "background 0.2s ease",
      }}
    >
      {/* Thumbnail */}
      <div
        style={{
          width: "48px",
          height: "48px",
          flexShrink: 0,
          borderRadius: "8px",
          overflow: "hidden",
          background: cat.bg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "20px",
        }}
      >
        <FramedPhoto
          src={location.photo_url}
          thumbSrc={location.photo_thumb_url}
          lqip={location.cover_lqip}
          alt=""
          width="100%"
          height="100%"
          offset={offsetForPhoto(location.photo_url, location.photo_offsets)}
          legacyOffsetPx={{
            x: location.photo_offset_x ?? 0,
            y: location.photo_offset_y ?? 0,
          }}
          // Load the tiny 48px thumbnails EAGERLY, never lazily. On Safari/WebKit
          // `img.decode()` rejects on cross-origin (Supabase) images, so FramedPhoto
          // falls back to the <img> `onLoad` event — but `onLoad` never fires for a
          // `loading="lazy"` image that the browser hasn't fetched, and Safari does
          // not fetch off-screen lazy images on a slow connection. That left every
          // below-the-fold timeline row stuck on a spinner forever (the cover
          // never appeared). The timeline is a finite, deliberately-opened list of
          // small thumbnails, so eager-loading them is correct and guarantees the
          // preview shows on every engine. (Chromium hid this because its decode()
          // force-loads even lazy/off-screen images.)
          eager
          fallbackEmoji={cat.emoji}
        />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "13px",
            fontWeight: 600,
            color: "#4A3728",
            margin: "0 0 2px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {location.title}
        </p>
        <p
          style={{
            fontFamily: "var(--font-cormorant), serif",
            fontStyle: "italic",
            fontSize: "12px",
            color: "#9B8578",
            margin: "0 0 5px",
          }}
        >
          {location.date_label}
        </p>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            padding: "2px 7px",
            borderRadius: "100px",
            background: cat.bg,
            color: cat.color,
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "9px",
            letterSpacing: "1.2px",
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          {cat.emoji} {cat.label}
        </span>
      </div>
    </div>
  );
}

export function TimelineSkeleton() {
  return (
    <div>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            gap: "12px",
            padding: "12px 20px",
            borderBottom: "1px solid rgba(193,127,90,0.08)",
          }}
        >
          <div
            className="tl-shimmer"
            style={{
              width: "48px",
              height: "48px",
              flexShrink: 0,
              borderRadius: "8px",
            }}
          />
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              justifyContent: "center",
            }}
          >
            <div
              className="tl-shimmer"
              style={{ height: "13px", borderRadius: "4px", width: "58%" }}
            />
            <div
              className="tl-shimmer"
              style={{ height: "11px", borderRadius: "4px", width: "32%" }}
            />
          </div>
        </div>
      ))}
      <style>{`
        .tl-shimmer {
          background: linear-gradient(
            90deg,
            rgba(193,127,90,0.07) 25%,
            rgba(193,127,90,0.15) 50%,
            rgba(193,127,90,0.07) 75%
          );
          background-size: 200% 100%;
          animation: tlShimmer 1.5s infinite;
        }
        @keyframes tlShimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}
