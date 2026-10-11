"use client";

import { useState, useRef, useEffect } from "react";
import { CATEGORIES } from "@/lib/constants";
import { BRAND } from "@/lib/brand";
import type { Location, CategoryKey } from "@/types";
import StatsBar from "./StatsBar";
import TimelineView, { TimelineSkeleton } from "./TimelineView";

interface SidebarProps {
  locations: Location[];
  onSelectLocation: (location: Location) => void;
  mobileOpen: boolean;
  onMobileToggle: () => void;
  /** Deterministic close (not a toggle) — used by the timeline date tap + back. */
  onMobileClose: () => void;
  onCategoryFilter: (category: string | null) => void;
  activeView: "map" | "timeline";
  onViewChange: (v: "map" | "timeline") => void;
  isLoading?: boolean;
  onResetView?: () => void;
}

export default function Sidebar({
  locations,
  onSelectLocation,
  mobileOpen,
  onMobileToggle,
  onMobileClose,
  onCategoryFilter,
  activeView,
  onViewChange,
  isLoading,
  onResetView,
}: SidebarProps) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef(0);
  const dragYRef = useRef(0);
  const [dragY, setDragY] = useState(0);

  function handleCategoryFilter(cat: string | null) {
    setSelectedCategory(cat);
    onCategoryFilter(cat);
  }

  // Raw touchmove listener — passive: false so e.preventDefault() works on iOS Safari
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const handler = (e: TouchEvent) => {
      const delta = e.touches[0].clientY - dragStartY.current;
      const scrollTop = scrollRef.current?.scrollTop ?? 0;
      if (delta > 10 && scrollTop <= 0) {
        dragYRef.current = delta;
        setDragY(delta);
        e.preventDefault();
      }
    };
    el.addEventListener("touchmove", handler, { passive: false });
    return () => el.removeEventListener("touchmove", handler);
  }, []);

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          bottom: 0,
          width: "320px",
          background: "#FAF6F0",
          borderRight: "1px solid rgba(193,127,90,0.12)",
          zIndex: 15,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          cursor: "default",
        }}
        className="sidebar-desktop"
      >
        <SidebarContent
          locations={locations}
          onSelectLocation={onSelectLocation}
          selectedCategory={selectedCategory}
          onCategoryFilter={handleCategoryFilter}
          activeView={activeView}
          onViewChange={onViewChange}
          isLoading={isLoading}
          onResetView={onResetView}
        />
        {locations.length > 0 && activeView === "map" && (
          <StatsBar locations={locations} />
        )}
      </aside>

      {/* Backdrop — closes sheet on tap outside */}
      {mobileOpen && (
        <div
          onClick={onMobileToggle}
          className="sidebar-mobile-backdrop"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.2)",
            zIndex: 19,
          }}
        />
      )}

      {/* Mobile full sheet */}
      <div
        ref={sheetRef}
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "#FAF6F0",
          borderRadius: "20px 20px 0 0",
          borderTop: "1px solid rgba(193,127,90,0.15)",
          zIndex: 20,
          height: mobileOpen ? "calc(100dvh - 52px)" : "0px",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          overscrollBehavior: "none",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          transform: `translateY(${dragY}px)`,
          transition:
            dragY > 0
              ? "height 0.3s ease"
              : "height 0.3s ease, transform 0.3s ease",
        }}
        className="sidebar-mobile"
        onTouchStart={(e) => {
          dragStartY.current = e.touches[0].clientY;
        }}
        onTouchEnd={() => {
          if (dragYRef.current > 120) {
            dragYRef.current = 0;
            setDragY(0);
            onMobileToggle();
          } else {
            dragYRef.current = 0;
            setDragY(0);
          }
        }}
      >
        {/* Close button */}
        <button
          onClick={onMobileToggle}
          aria-label="Close"
          style={{
            position: "absolute",
            top: "16px",
            right: "16px",
            width: "32px",
            height: "32px",
            borderRadius: "8px",
            border: "1px solid rgba(193,127,90,0.2)",
            background: "transparent",
            color: "#6B4F3A",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "18px",
            lineHeight: 1,
            zIndex: 1,
          }}
        >
          ×
        </button>

        {/* Scrollable content */}
        <div
          ref={scrollRef}
          style={
            {
              flex: 1,
              overflowY: "auto",
              WebkitOverflowScrolling: "touch",
              touchAction: "pan-y",
              // Contain the scroll so reaching the top/bottom of the list never
              // rubber-bands the whole sheet (reinforces the parent's
              // overscrollBehavior:none).
              overscrollBehavior: "contain",
            } as React.CSSProperties
          }
        >
          <SidebarContent
            locations={locations}
            onSelectLocation={onSelectLocation}
            selectedCategory={selectedCategory}
            onCategoryFilter={handleCategoryFilter}
            showStats
            activeView={activeView}
            onViewChange={onViewChange}
            onMobileClose={onMobileClose}
            isMobile
            isLoading={isLoading}
          />
        </div>
      </div>

      <style>{`
        @media (min-width: 768px) {
          .sidebar-mobile { display: none !important; }
          .sidebar-mobile-backdrop { display: none !important; }
        }
        @media (max-width: 767px) {
          .sidebar-desktop { display: none !important; }
        }
        @media (min-width: 768px) and (max-width: 1023px) {
          .sidebar-desktop { width: 280px !important; }
        }
      `}</style>
    </>
  );
}

interface SidebarContentProps {
  locations: Location[];
  onSelectLocation: (l: Location) => void;
  selectedCategory: string | null;
  onCategoryFilter: (cat: string | null) => void;
  showStats?: boolean;
  activeView: "map" | "timeline";
  onViewChange: (v: "map" | "timeline") => void;
  onMobileClose?: () => void;
  isMobile?: boolean;
  isLoading?: boolean;
  onResetView?: () => void;
}

function SidebarContent({
  locations,
  onSelectLocation,
  selectedCategory,
  onCategoryFilter,
  showStats,
  activeView,
  onViewChange,
  onMobileClose,
  isMobile,
  isLoading,
  onResetView,
}: SidebarContentProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterToast, setFilterToast] = useState<string | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  const filteredLocations = selectedCategory
    ? locations.filter((l) => l.category === selectedCategory)
    : locations;

  const categoryCounts = (Object.keys(CATEGORIES) as CategoryKey[]).reduce(
    (acc, key) => {
      acc[key] = locations.filter((l) => l.category === key).length;
      return acc;
    },
    {} as Record<CategoryKey, number>,
  );

  // Close filter popover on outside click/touch
  useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler, { passive: true });
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [filterOpen]);

  // Auto-dismiss empty-category toast
  useEffect(() => {
    if (!filterToast) return;
    const t = setTimeout(() => setFilterToast(null), 2000);
    return () => clearTimeout(t);
  }, [filterToast]);

  const selectedCat = selectedCategory
    ? CATEGORIES[selectedCategory as CategoryKey]
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ height: "52px", flexShrink: 0 }} />

      {/* Header with view toggle */}
      <div
        style={{
          padding: "20px 20px 8px",
          borderBottom: "1px solid rgba(193,127,90,0.12)",
          background: "#FAF6F0",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div>
          <h1
            onClick={onResetView}
            style={{
              fontFamily: "var(--font-cormorant), serif",
              fontStyle: "italic",
              fontSize: "28px",
              color: "#4A3728",
              margin: "0 0 4px",
              letterSpacing: "-0.5px",
              lineHeight: 1.1,
              outline: "none",
              userSelect: "none",
              cursor: onResetView ? "pointer" : "default",
            }}
            title={onResetView ? "Reset view" : undefined}
          >
            {BRAND.name}
          </h1>
          <p
            style={{
              fontFamily: "var(--font-quicksand), sans-serif",
              fontSize: "11px",
              textTransform: "uppercase",
              letterSpacing: "1.5px",
              color: "#9B8578",
              margin: 0,
            }}
          >
            {locations.length} {locations.length === 1 ? "place" : "places"}
          </p>
        </div>

        {/* Map / Timeline toggle */}
        {locations.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: "2px",
              background: "rgba(193,127,90,0.08)",
              borderRadius: "8px",
              padding: "3px",
              marginTop: "4px",
              flexShrink: 0,
            }}
          >
            <button
              onClick={() => onViewChange("map")}
              title="Map view"
              aria-label="Map view"
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "6px",
                border: "none",
                background: activeView === "map" ? "#FAF6F0" : "transparent",
                color: activeView === "map" ? "#6B4F3A" : "#9B8578",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 0.15s, color 0.15s",
                boxShadow:
                  activeView === "map"
                    ? "0 1px 3px rgba(74,55,40,0.12)"
                    : "none",
              }}
            >
              <MapIcon />
            </button>
            <button
              onClick={() => onViewChange("timeline")}
              title="Timeline view"
              aria-label="Timeline view"
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "6px",
                border: "none",
                background:
                  activeView === "timeline" ? "#FAF6F0" : "transparent",
                color: activeView === "timeline" ? "#6B4F3A" : "#9B8578",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 0.15s, color 0.15s",
                boxShadow:
                  activeView === "timeline"
                    ? "0 1px 3px rgba(74,55,40,0.12)"
                    : "none",
              }}
            >
              <CalendarIcon />
            </button>
          </div>
        )}
      </div>

      {showStats && locations.length > 0 && activeView === "map" && (
        <StatsBar locations={locations} />
      )}

      {/* Timeline view */}
      {activeView === "timeline" ? (
        <div
          style={{ animation: "sidebarFadeIn 0.25s ease-out" }}
          className="sidebar-view-panel"
        >
          <TimelineView
            locations={locations}
            onSelect={onSelectLocation}
            onViewChange={onViewChange}
            onMobileClose={onMobileClose}
            isMobile={isMobile}
          />
        </div>
      ) : (
        /* Map / list view */
        <div
          style={{ animation: "sidebarFadeIn 0.25s ease-out" }}
          className="sidebar-view-panel"
        >
          {/* Filter button + inline popover */}
          {locations.length > 0 && (
            <div
              ref={filterRef}
              style={{
                padding: "10px 16px",
                borderBottom: "1px solid rgba(193,127,90,0.08)",
                flexShrink: 0,
              }}
            >
              <button
                onClick={() => setFilterOpen((o) => !o)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "4px 12px",
                  borderRadius: "100px",
                  border: selectedCategory
                    ? "1px solid rgba(193,127,90,0.4)"
                    : "1px solid rgba(193,127,90,0.18)",
                  background: selectedCategory
                    ? "rgba(193,127,90,0.12)"
                    : "transparent",
                  color: selectedCategory ? "#C17F5A" : "#9B8578",
                  fontFamily: "var(--font-quicksand), sans-serif",
                  fontSize: "9px",
                  letterSpacing: "1.2px",
                  textTransform: "uppercase",
                  fontWeight: 500,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition:
                    "background 0.15s, border-color 0.15s, color 0.15s",
                }}
              >
                {selectedCat
                  ? `${selectedCat.emoji} ${selectedCat.label}`
                  : "✦ Filter"}
                <span
                  style={{
                    fontSize: "7px",
                    opacity: 0.45,
                    marginLeft: "2px",
                  }}
                >
                  {filterOpen ? "▲" : "▼"}
                </span>
              </button>

              {filterOpen && (
                <div
                  style={{
                    marginTop: "8px",
                    background: "#FAF6F0",
                    border: "1px solid rgba(193,127,90,0.18)",
                    borderRadius: "12px",
                    overflow: "hidden",
                    boxShadow: "0 4px 16px rgba(74,55,40,0.10)",
                  }}
                >
                  {/* All places row */}
                  <div
                    onClick={() => {
                      onCategoryFilter(null);
                      setFilterOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "10px 14px",
                      cursor: "pointer",
                      borderBottom: "1px solid rgba(193,127,90,0.08)",
                      background: !selectedCategory
                        ? "rgba(193,127,90,0.06)"
                        : "transparent",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-quicksand), sans-serif",
                        fontSize: "11px",
                        color: "#6B4F3A",
                        fontWeight: !selectedCategory ? 600 : 400,
                        flex: 1,
                        letterSpacing: "0.3px",
                      }}
                    >
                      All places
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-quicksand), sans-serif",
                        fontSize: "10px",
                        color: "#9B8578",
                        marginRight: !selectedCategory ? "8px" : "0",
                      }}
                    >
                      {locations.length}
                    </span>
                    {!selectedCategory && (
                      <span
                        style={{
                          color: "#C17F5A",
                          fontSize: "11px",
                          marginLeft: "8px",
                        }}
                      >
                        ✓
                      </span>
                    )}
                  </div>

                  {/* All 8 category rows */}
                  {(Object.keys(CATEGORIES) as CategoryKey[]).map((key) => {
                    const cat = CATEGORIES[key];
                    const count = categoryCounts[key];
                    const isActive = selectedCategory === key;
                    const isEmpty = count === 0;
                    return (
                      <div
                        key={key}
                        onClick={() => {
                          if (isEmpty) {
                            setFilterToast(
                              `No ${cat.label.toLowerCase()} places yet`,
                            );
                            return;
                          }
                          onCategoryFilter(isActive ? null : key);
                          setFilterOpen(false);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          padding: "9px 14px",
                          cursor: "pointer",
                          opacity: isEmpty ? 0.4 : 1,
                          background: isActive
                            ? "rgba(193,127,90,0.06)"
                            : "transparent",
                          borderBottom: "1px solid rgba(193,127,90,0.05)",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "13px",
                            marginRight: "8px",
                            lineHeight: 1,
                          }}
                        >
                          {cat.emoji}
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--font-quicksand), sans-serif",
                            fontSize: "11px",
                            color: "#6B4F3A",
                            fontWeight: isActive ? 600 : 400,
                            flex: 1,
                            letterSpacing: "0.3px",
                          }}
                        >
                          {cat.label}
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--font-quicksand), sans-serif",
                            fontSize: "10px",
                            color: "#9B8578",
                            marginRight: isActive ? "8px" : "0",
                          }}
                        >
                          {count}
                        </span>
                        {isActive && (
                          <span style={{ color: "#C17F5A", fontSize: "11px" }}>
                            ✓
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Toast for empty-category tap */}
              {filterToast && (
                <div
                  style={{
                    position: "fixed",
                    bottom: "80px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: "#4A3728",
                    color: "white",
                    borderRadius: "100px",
                    padding: "8px 18px",
                    fontFamily: "var(--font-quicksand), sans-serif",
                    fontSize: "11px",
                    letterSpacing: "0.5px",
                    zIndex: 60,
                    whiteSpace: "nowrap",
                    boxShadow: "0 2px 12px rgba(74,55,40,0.18)",
                    pointerEvents: "none",
                  }}
                >
                  {filterToast}
                </div>
              )}
            </div>
          )}

          {/* Location list */}
          <div>
            {isLoading && locations.length === 0 ? (
              <TimelineSkeleton />
            ) : locations.length === 0 ? (
              <EmptyState />
            ) : filteredLocations.length === 0 ? (
              <div
                style={{
                  padding: "32px 20px",
                  textAlign: "center",
                  color: "rgba(92,61,46,0.5)",
                  fontFamily: "var(--font-quicksand), sans-serif",
                  fontSize: "13px",
                  letterSpacing: "1px",
                }}
              >
                No{" "}
                {selectedCategory
                  ? CATEGORIES[
                      selectedCategory as CategoryKey
                    ]?.label.toLowerCase()
                  : ""}{" "}
                places yet
              </div>
            ) : (
              filteredLocations.map((loc) => (
                <SidebarItem
                  key={loc.id}
                  location={loc}
                  onClick={() => onSelectLocation(loc)}
                />
              ))
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes sidebarFadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 20px 36px",
        gap: "10px",
      }}
    >
      {/* Pin with heart SVG */}
      <svg
        width="52"
        height="52"
        viewBox="0 0 52 52"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M26 4C17.716 4 11 10.716 11 19C11 28.5 26 48 26 48C26 48 41 28.5 41 19C41 10.716 34.284 4 26 4Z"
          fill="rgba(193,127,90,0.12)"
          stroke="#C17F5A"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M26 27C26 27 18.5 21.8 18.5 17C18.5 14.239 20.739 12 23.5 12C24.88 12 26 13.12 26 13.12C26 13.12 27.12 12 28.5 12C31.261 12 33.5 14.239 33.5 17C33.5 21.8 26 27 26 27Z"
          fill="#C17F5A"
          opacity="0.65"
        />
      </svg>

      <p
        style={{
          fontFamily: "var(--font-cormorant), serif",
          fontStyle: "italic",
          fontSize: "18px",
          color: "#6B4F3A",
          margin: 0,
          textAlign: "center",
          lineHeight: 1.3,
        }}
      >
        Drop your first place
      </p>

      <p
        style={{
          fontFamily: "var(--font-quicksand), sans-serif",
          fontSize: "11px",
          color: "#9B8578",
          margin: 0,
          letterSpacing: "1.2px",
          textTransform: "uppercase",
        }}
      >
        Tap + to begin
      </p>

      {/* Arrow pointing toward + button (top-right) */}
      <svg
        width="36"
        height="28"
        viewBox="0 0 36 28"
        fill="none"
        aria-hidden="true"
        style={{ marginTop: "4px", opacity: 0.45 }}
      >
        <path
          d="M4 24C4 24 12 20 20 12C26 6 30 4 32 4"
          stroke="#C17F5A"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="M26 4L32 4L32 10"
          stroke="#C17F5A"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function SidebarItem({
  location,
  onClick,
}: {
  location: Location;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const cat = CATEGORIES[location.category] ?? CATEGORIES.everyday;

  return (
    <div
      data-testid={`sidebar-loc-${location.id}`}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(e) => e.currentTarget.blur()}
      tabIndex={-1}
      style={{
        padding: "14px 20px",
        borderBottom: "1px solid rgba(193,127,90,0.08)",
        cursor: "pointer",
        background: hovered ? "rgba(193,127,90,0.05)" : "transparent",
        transition: "background 0.15s",
        outline: "none",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "3px",
          padding: "2px 8px",
          borderRadius: "100px",
          background: cat.bg,
          color: cat.color,
          fontFamily: "var(--font-quicksand), sans-serif",
          fontSize: "9px",
          letterSpacing: "1.5px",
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        {cat.emoji} {cat.label}
      </span>
      <p
        style={{
          fontFamily: "var(--font-quicksand), sans-serif",
          fontSize: "13px",
          fontWeight: 600,
          color: "#4A3728",
          margin: "4px 0 2px",
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
          margin: "0 0 4px",
        }}
      >
        {location.date_label}
      </p>
      {location.description && (
        <p
          className="line-clamp-2"
          style={{
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "11px",
            color: "#7A6458",
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          {location.description}
        </p>
      )}
    </div>
  );
}

function MapIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}
