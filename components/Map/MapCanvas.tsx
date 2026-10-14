"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { BRAND } from "@/lib/brand";
import { DEFAULT_CENTER, DEFAULT_ZOOM, DEFAULT_BOUNDS } from "@/lib/constants";
import type { Location } from "@/types";
import LocationCard from "./LocationCard";
import DemoBanner from "@/components/UI/DemoBanner";
import Sidebar from "./Sidebar";
import AdminPanel from "./AdminPanel";
import { api } from "@/lib/api-client";
import { stabilizeCoverUrls } from "@/lib/photos";
import { isHiddenFromMap } from "@/lib/locations";
import { useBreakpoint } from "@/lib/useBreakpoint";

interface MapCanvasProps {
  initialLocations: Location[];
  /**
   * The public demo: nothing can be added, changed or removed. The server refuses
   * every write there anyway (the proxy and the store); this only keeps controls that
   * could never work off the screen.
   */
  readOnly?: boolean;
}

function geojsonFromLocations(
  locations: Location[],
): GeoJSON.FeatureCollection {
  const seen = new Set<string>();
  return {
    type: "FeatureCollection",
    features: locations
      // Never plot a phantom pin. Test-tagged (`__pw…__`) rows are dropped in
      // EVERY environment so a misconfigured NODE_ENV can't expose a test pin;
      // null-island ([0,0]) coords are dropped in production. The dev sidebar
      // still lists these rows (the local write-suite selects them there).
      .filter((loc) => !isHiddenFromMap(loc))
      .filter((loc) => {
        if (seen.has(loc.id)) return false;
        seen.add(loc.id);
        return true;
      })
      .map((loc) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [loc.lng, loc.lat] },
        properties: {
          id: loc.id,
          title: loc.title,
          date_label: loc.date_label,
          description: loc.description,
          category: loc.category,
        },
      })),
  };
}

export default function MapCanvas({
  initialLocations,
  readOnly = false,
}: MapCanvasProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const locationsRef = useRef<Location[]>(initialLocations);
  const pulseRafRef = useRef<number | null>(null);
  const pulseStartRef = useRef<number>(Date.now());
  const cardDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCardDeleteLocRef = useRef<Location | null>(null);
  const categoryFilterRef = useRef<string | null>(null);
  const recentlyAddedIdsRef = useRef<Set<string>>(new Set());
  // Ids deleted within the last ~60s. The list route serves with
  // stale-while-revalidate (up to ~59s), so a poll can briefly re-serve a
  // just-deleted row; we filter those out so a deleted pin can't reappear.
  const recentlyDeletedIdsRef = useRef<Set<string>>(new Set());
  // Cover URLs already warmed into the browser cache (so a pin tap is instant).
  const prefetchedCoversRef = useRef<Set<string>>(new Set());
  const clusterMarkersRef = useRef<Map<number, mapboxgl.Marker>>(new Map());
  // Pending fade-out removal timers keyed by cluster_id. Lets us cancel a
  // removal if the cluster bounces back into view mid-fadeout.
  const fadeOutTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const renderRafIdRef = useRef<number | null>(null);

  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [locations, setLocations] = useState<Location[]>(initialLocations);
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(
    null,
  );
  const [adminOpen, setAdminOpen] = useState(false);
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false);
  const [supabaseDown, setSupabaseDown] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [pendingCardDeleteId, setPendingCardDeleteId] = useState<string | null>(
    null,
  );
  const [mapStyle, setMapStyle] = useState<"vintage" | "satellite">("vintage");
  // 2D / 3D toggle. Default flat. Pitch is driven only by this toggle, never
  // by a zoom-event handler: setPitch fires zoom, which would re-fire setPitch.
  const [is3D, setIs3D] = useState<boolean>(false);
  const [activeView, setActiveView] = useState<"map" | "timeline">("map");
  const [pollReconnecting, setPollReconnecting] = useState(false);
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === "mobile";

  // Keep locationsRef current so map click handlers don't have stale closure
  useEffect(() => {
    locationsRef.current = locations;
  }, [locations]);

  // Keep categoryFilterRef current for use in style.load handlers
  useEffect(() => {
    categoryFilterRef.current = categoryFilter;
  }, [categoryFilter]);

  // NOTE: the map is intentionally NOT pinned to window.innerHeight. Pinning
  // makes the whole map RESIZE/JUMP whenever the visual viewport changes: the
  // iOS Safari dynamic toolbar showing/hiding, and especially the on-screen
  // keyboard opening when an admin-panel field is focused (innerHeight shrinks,
  // the map snaps shorter and drags the bottom-anchored chrome with it). The
  // map container is `position:absolute; inset:0` inside a `100dvh` parent
  // (app/map/page.tsx), so it already fills the dynamic viewport stably, and
  // Mapbox GL v3 auto-resizes via its built-in ResizeObserver (`trackResize`
  // defaults to true). `100dvh` tracks the toolbar but, unlike innerHeight,
  // ignores the keyboard, so opening the keyboard does not resize the map.

  // Continuous-pool synchronization for HTML cluster markers. Mapbox-recommended
  // pattern (https://docs.mapbox.com/mapbox-gl-js/example/cluster-html/):
  // "manually synchronize the clustered source with a pool of marker objects
  // that updates continuously while the map view changes."
  //
  // This single function is called on every `render` event (RAF-batched)
  // rather than being split into a render-position-only path and a
  // moveend-full-update path. When zoom crosses a cluster threshold,
  // supercluster mints NEW cluster_ids; a position-only path finds no matching
  // markers in the pool and does nothing, so markers would freeze at old
  // positions until `moveend` fired and snapped them to new positions.
  //
  // Instead the full create/update/remove runs every frame. New cluster_ids
  // fade in (opacity 0 → 1) and old cluster_ids fade out (opacity 1 → 0,
  // setTimeout-removed) continuously through the gesture. The CSS transition
  // on the inner div is opacity + width + height ONLY — never `transform` —
  // because mapboxgl.Marker.setLngLat() updates the marker's transform every
  // frame and a CSS transition on transform would lag that.
  //
  // Fraunces 800 italic cluster labels cannot be rendered by Mapbox's native
  // symbol layer, so we use DOM markers with styled divs instead.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const updateClusterMarkers = useCallback((map: mapboxgl.Map) => {
    const features = map.querySourceFeatures("locations-source", {
      filter: ["has", "point_count"],
    });
    const visibleClusterIds = new Set<number>();

    // Color palette: primary cream #fbf3df (alt: #fdf1d6, #faf5ec),
    // text brown #3d2818 (alt: #2a1810). Subtle shadow.
    const bgColor = "#fbf3df";
    const textColor = "#3d2818";
    const shadowStyle = "0 2px 8px rgba(61, 40, 24, 0.18)";

    for (const feature of features) {
      const clusterId = feature.properties?.cluster_id as number;
      const pointCount = feature.properties?.point_count as number;
      const coords = (feature.geometry as GeoJSON.Point).coordinates as [
        number,
        number,
      ];

      visibleClusterIds.add(clusterId);

      // Determine diameter tier based on point_count.
      let diameterPx = 22;
      if (pointCount >= 50) {
        diameterPx = 34;
      } else if (pointCount >= 10) {
        diameterPx = 28;
      }

      if (clusterMarkersRef.current.has(clusterId)) {
        // Cluster bounced back into view — cancel any pending fade-out removal.
        const pendingTimer = fadeOutTimersRef.current.get(clusterId);
        if (pendingTimer !== undefined) {
          clearTimeout(pendingTimer);
          fadeOutTimersRef.current.delete(clusterId);
        }

        // Update existing marker position and content
        const marker = clusterMarkersRef.current.get(clusterId)!;
        marker.setLngLat(coords);
        // Update inner HTML with new count (in case it changed)
        const markerEl = marker.getElement();
        const innerDiv = markerEl.querySelector(
          "[data-cluster-inner]",
        ) as HTMLDivElement;
        if (innerDiv) {
          innerDiv.textContent = String(pointCount);
          innerDiv.style.width = `${diameterPx}px`;
          innerDiv.style.height = `${diameterPx}px`;
          innerDiv.style.fontSize = `${diameterPx >= 34 ? 16 : diameterPx >= 28 ? 14 : 12}px`;
          // Restore full opacity in case the marker was mid-fadeout.
          innerDiv.style.opacity = "1";
        }
      } else {
        // Create new marker
        const el = document.createElement("div");
        el.style.pointerEvents = "none";
        el.style.position = "relative";
        el.style.width = `${diameterPx}px`;
        el.style.height = `${diameterPx}px`;
        el.style.willChange = "transform";

        const innerDiv = document.createElement("div");
        innerDiv.setAttribute("data-cluster-inner", "true");
        innerDiv.textContent = String(pointCount);
        innerDiv.style.width = `${diameterPx}px`;
        innerDiv.style.height = `${diameterPx}px`;
        innerDiv.style.display = "flex";
        innerDiv.style.alignItems = "center";
        innerDiv.style.justifyContent = "center";
        innerDiv.style.borderRadius = "50%";
        innerDiv.style.backgroundColor = bgColor;
        innerDiv.style.color = textColor;
        innerDiv.style.fontFamily = "var(--font-fraunces), serif";
        innerDiv.style.fontWeight = "800";
        innerDiv.style.fontStyle = "italic";
        innerDiv.style.fontFeatureSettings = '"tnum"';
        innerDiv.style.fontSize = `${diameterPx >= 34 ? 16 : diameterPx >= 28 ? 14 : 12}px`;
        innerDiv.style.boxShadow = shadowStyle;
        // NO transform transition: position is updated by
        // mapboxgl.Marker.setLngLat() every frame via Mapbox's transform
        // pipeline; a CSS transition on transform would lag that and
        // produce a snap. width/height get a slightly faster ease
        // (150ms) so tier transitions feel snappier; opacity stays 200ms
        // for the fade lifecycle.
        innerDiv.style.transition =
          "width 150ms ease, height 150ms ease, opacity 200ms ease-out";
        innerDiv.style.lineHeight = "1";
        // Start hidden so the opacity transition can run on insertion.
        innerDiv.style.opacity = "0";

        el.appendChild(innerDiv);

        const marker = new mapboxgl.Marker(el, { anchor: "center" })
          .setLngLat(coords)
          .addTo(map);

        // Trigger fade-in on the next frame so the browser paints opacity 0
        // first and the transition fires.
        requestAnimationFrame(() => {
          innerDiv.style.opacity = "1";
        });

        clusterMarkersRef.current.set(clusterId, marker);
      }
    }

    // Schedule fade-out removal for clusters that are no longer visible.
    // Defer the actual `marker.remove()` until after the opacity transition
    // so the cluster fades out instead of popping out.
    for (const clusterId of clusterMarkersRef.current.keys()) {
      if (visibleClusterIds.has(clusterId)) continue;
      // Already fading out — don't double-schedule.
      if (fadeOutTimersRef.current.has(clusterId)) continue;

      const marker = clusterMarkersRef.current.get(clusterId)!;
      const innerDiv = marker
        .getElement()
        .querySelector("[data-cluster-inner]") as HTMLDivElement | null;
      if (innerDiv) innerDiv.style.opacity = "0";

      const timerId = setTimeout(() => {
        marker.remove();
        clusterMarkersRef.current.delete(clusterId);
        fadeOutTimersRef.current.delete(clusterId);
      }, 200);
      fadeOutTimersRef.current.set(clusterId, timerId);
    }
  }, []);

  // Apply warm vintage palette to all map layers
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const applyPalette = useCallback((map: mapboxgl.Map) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const safeSet = (layer: string, prop: string, value: unknown) => {
      try {
        if (map.getLayer(layer))
          map.setPaintProperty(layer, prop as any, value);
      } catch (_e) {}
    };
    safeSet("background", "background-color", "#F0E6D3");
    safeSet("landcover", "fill-color", "#E8DCC8");
    safeSet("landcover_wood", "fill-color", "#D4C8A8");
    safeSet("landcover_grass", "fill-color", "#E0D4B8");
    safeSet("landuse", "fill-color", "#EBE0CE");
    safeSet("landuse_overlay_national_park", "fill-color", "#D4DCBC");
    safeSet("national_park", "fill-color", "#D4DCBC");
    safeSet("water", "fill-color", "#B8CED8");
    safeSet("water-shadow", "fill-color", "#AABFCB");
    safeSet("waterway", "line-color", "#B8CED8");
    safeSet("waterway-label", "text-color", "#7A9BAA");
    safeSet("road-motorway-trunk", "line-color", "#C9A87A");
    safeSet("road-primary", "line-color", "#D4B896");
    safeSet("road-secondary-tertiary", "line-color", "#DBBFA0");
    safeSet("road-street", "line-color", "#E2CCAE");
    safeSet("road-path", "line-color", "#D4C4A0");
    safeSet("road-rail", "line-color", "#C8B898");
    safeSet("settlement-major-label", "text-color", "#6B4F3A");
    safeSet("settlement-minor-label", "text-color", "#8B6347");
    safeSet("settlement-subdivision-label", "text-color", "#9B7357");
    safeSet("state-label", "text-color", "#8B6347");
    safeSet("country-label", "text-color", "#6B4F3A");
    safeSet("natural-point-label", "text-color", "#7A8B6F");
    safeSet("road-label", "text-color", "#9B7D65");
    safeSet("water-point-label", "text-color", "#7A9BAA");
    safeSet("poi-label", "text-color", "#8B6F5A");
    safeSet("building", "fill-color", "#E8DCCF");
    safeSet("building", "fill-outline-color", "#D6C9B8");
    safeSet("building-outline", "line-color", "#D6C9B8");
  }, []);

  // Add GeoJSON source, cluster layers, event listeners, and pulse animation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initMapLayers = useCallback((map: mapboxgl.Map) => {
    map.addSource("locations-source", {
      type: "geojson",
      data: geojsonFromLocations(locationsRef.current),
      cluster: true,
      // radius 120 means any two pins within 120 screen px combine. At
      // typical city-level zooms (10–13), a 120 px radius covers most metros,
      // so region-wide views show a few clusters instead of many individual
      // pins. clusterMaxZoom 11 means clustering applies only at zoom <= 11;
      // at 12+ every pin shows individually (neighborhood granularity without
      // zooming to 14). If clusters glue together at city zoom, dial back to
      // radius 100 / maxZoom 12.
      clusterMaxZoom: 11,
      clusterRadius: 120,
      // Require >=3 points to form a cluster. Kills 2-point churn at zoom 12-14
      // where two close pins kept oscillating between cluster and unclustered.
      clusterMinPoints: 3,
    });

    // Invisible hit-target circle layer for cluster clicks.
    // HTML markers are rendered on top via updateClusterMarkers().
    map.addLayer({
      id: "clusters",
      type: "circle",
      source: "locations-source",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#C17F5A",
        "circle-radius": ["step", ["get", "point_count"], 16, 5, 22, 15, 28],
        "circle-opacity": 0,
      },
    });

    map.addLayer({
      id: "unclustered-pulse",
      type: "circle",
      source: "locations-source",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": 8,
        "circle-color": "#C17F5A",
        "circle-opacity": 0.4,
        "circle-stroke-width": 0,
      },
    });

    map.addLayer({
      id: "unclustered-point",
      type: "circle",
      source: "locations-source",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": 8,
        "circle-color": "#C17F5A",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#FAF6F0",
      },
    });

    // Invisible hit-target layer — larger radius for easier finger tapping
    map.addLayer({
      id: "unclustered-hit",
      type: "circle",
      source: "locations-source",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": 22,
        "circle-color": "#000",
        "circle-opacity": 0,
      },
    });

    // 3D buildings extrusion layer. Both `light-v10` and `satellite-streets-v12`
    // ship the `composite` source with a `building` source-layer, so this works
    // in either style. Insert before `road-label` if it exists so labels render
    // on top; otherwise let it sit on top of the stack.
    //
    // Layer is ALWAYS visible above minzoom 15. Buildings look flat top-down
    // when pitch is 0 and 3D when pitched; pitch is controlled by the 2D/3D
    // toggle.
    if (map.getSource("composite")) {
      try {
        const beforeId = map.getLayer("road-label") ? "road-label" : undefined;
        map.addLayer(
          {
            id: "3d-buildings",
            source: "composite",
            "source-layer": "building",
            type: "fill-extrusion",
            minzoom: 15,
            filter: ["==", "extrude", "true"],
            paint: {
              "fill-extrusion-color": "#DCC8B0",
              "fill-extrusion-height": ["get", "height"],
              "fill-extrusion-base": ["get", "min_height"],
              "fill-extrusion-opacity": 0.7,
            },
          },
          beforeId,
        );
      } catch (_e) {}
    }

    map.on("mouseenter", "clusters", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "clusters", () => {
      map.getCanvas().style.cursor = "";
    });
    map.on("mouseenter", "unclustered-hit", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "unclustered-hit", () => {
      map.getCanvas().style.cursor = "";
    });

    map.on("click", "clusters", (e) => {
      const features = map.queryRenderedFeatures(e.point, {
        layers: ["clusters"],
      });
      if (!features.length) return;
      const clusterId = features[0].properties?.cluster_id as number;
      const source = map.getSource(
        "locations-source",
      ) as mapboxgl.GeoJSONSource;
      source.getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err || zoom === null || zoom === undefined) return;
        const coords = (features[0].geometry as GeoJSON.Point).coordinates as [
          number,
          number,
        ];
        map.easeTo({ center: coords, zoom });
      });
    });

    map.on("click", "unclustered-hit", (e) => {
      const features = map.queryRenderedFeatures(e.point, {
        layers: ["unclustered-hit"],
      });
      if (!features.length) return;
      const id = features[0].properties?.id as string;
      const loc = locationsRef.current.find((l) => l.id === id);
      if (loc) setSelectedLocation(loc);
    });

    if (pulseRafRef.current !== null) cancelAnimationFrame(pulseRafRef.current);
    pulseStartRef.current = Date.now();
    function animatePulse() {
      const duration = 2500;
      const elapsed = (Date.now() - pulseStartRef.current) % duration;
      const t = elapsed / duration;
      const radius = 8 + t * 12;
      const opacity = 0.4 * (1 - t);
      try {
        map.setPaintProperty("unclustered-pulse", "circle-radius", radius);
        map.setPaintProperty("unclustered-pulse", "circle-opacity", opacity);
      } catch (_e) {
        return;
      }
      pulseRafRef.current = requestAnimationFrame(animatePulse);
    }
    pulseRafRef.current = requestAnimationFrame(animatePulse);
  }, []);

  // Initialize map
  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) {
      setMapError(true);
      return;
    }

    const savedStyle = localStorage.getItem("app-map-style");
    const initialStyle: "vintage" | "satellite" =
      savedStyle === "satellite" ? "satellite" : "vintage";
    if (initialStyle === "satellite") setMapStyle("satellite");

    const styleUrl =
      initialStyle === "satellite"
        ? "mapbox://styles/mapbox/satellite-streets-v12"
        : "mapbox://styles/mapbox/light-v10";

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: mapContainer.current!,
      style: styleUrl,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: 0,
      maxZoom: 18,
      // Two-finger drag to tilt (Apple-Maps-style). Enabled by default in
      // Mapbox GL JS v3, but set explicitly so future Map options edits don't
      // accidentally turn it off.
      touchPitch: true,
      // Suppress the auto-added AttributionControl. A compact one is added
      // at bottom-left below; without this, Mapbox v3's default
      // AttributionControl renders at bottom-right too, producing two (i)
      // toggle buttons.
      attributionControl: false,
    });

    mapRef.current = map;

    map.on("load", () => {
      map.addControl(
        new mapboxgl.AttributionControl({ compact: true }),
        "bottom-left",
      );
      map.addControl(
        new mapboxgl.NavigationControl({ showCompass: false }),
        "bottom-right",
      );
      if (initialStyle === "vintage") applyPalette(map);
      initMapLayers(map);
      updateClusterMarkers(map);
      // Mapbox canvas defaults to tabindex="0" (focusable). Removing it as a focus
      // target prevents Chrome's Caret Browsing (F7) and similar accessibility
      // indicators from drawing a phantom caret over the map.
      map.getCanvas().setAttribute("tabindex", "-1");
      setMapLoaded(true);
    });

    map.on("click", () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) {
        active.blur();
      }
      window.getSelection()?.removeAllRanges();
    });

    map.on("error", () => {
      setMapError(true);
    });

    // Update cluster markers on moveend and sourcedata events
    const handleMoveEnd = () => updateClusterMarkers(map);
    const handleSourceData = (e: any) => {
      if (e.sourceId === "locations-source" && !e.isSourceLoading) {
        updateClusterMarkers(map);
      }
    };
    // Per-frame full marker synchronization during pinch-zoom, pan, and
    // programmatic camera animation (easeTo / flyTo / fitBounds). Mapbox
    // recomputes clusters every frame during gestures, so cluster_ids change
    // continuously as the user crosses zoom thresholds. Running the full
    // create/update/remove on every render lets new cluster_ids fade in and
    // old fade out smoothly through the gesture instead of snapping at
    // `moveend`. RAF-batched so at most one update per frame.
    //
    // Gate on `isMoving / isZooming / isRotating` so the pulse animation
    // (which calls setPaintProperty 60×/sec → fires render events) doesn't
    // re-query source features when nothing about the marker pool has
    // changed. moveend + sourcedata handlers below are the safety net for
    // idle data updates.
    const handleRender = () => {
      const map = mapRef.current;
      if (!map) return;
      if (!map.isMoving() && !map.isZooming() && !map.isRotating()) return;
      if (renderRafIdRef.current !== null) return;
      renderRafIdRef.current = requestAnimationFrame(() => {
        renderRafIdRef.current = null;
        if (mapRef.current) updateClusterMarkers(mapRef.current);
      });
    };
    map.on("moveend", handleMoveEnd);
    map.on("sourcedata", handleSourceData);
    map.on("render", handleRender);

    return () => {
      if (pulseRafRef.current !== null)
        cancelAnimationFrame(pulseRafRef.current);
      if (renderRafIdRef.current !== null) {
        cancelAnimationFrame(renderRafIdRef.current);
        renderRafIdRef.current = null;
      }
      // Clean up all cluster markers and any pending fade-out timers
      fadeOutTimersRef.current.forEach((timerId) => clearTimeout(timerId));
      fadeOutTimersRef.current.clear();
      clusterMarkersRef.current.forEach((marker) => marker.remove());
      clusterMarkersRef.current.clear();
      map.off("moveend", handleMoveEnd);
      map.off("sourcedata", handleSourceData);
      map.off("render", handleRender);
      map.remove();
    };
  }, []);

  // Pre-warm the /api/locations function so the first real POST doesn't cold-start.
  // The read only demo never posts, so it does not warm anything up.
  useEffect(() => {
    if (mapLoaded && !readOnly) fetch("/api/locations").catch(() => {});
  }, [mapLoaded, readOnly]);

  // Sync GeoJSON source whenever locations change
  useEffect(() => {
    if (!mapLoaded) return;
    const source = mapRef.current?.getSource("locations-source") as
      mapboxgl.GeoJSONSource | undefined;
    source?.setData(geojsonFromLocations(locations));
  }, [mapLoaded, locations]);

  // Apply category filter to map layers
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    const filter: mapboxgl.FilterSpecification = categoryFilter
      ? ["==", ["get", "category"], categoryFilter]
      : ["!", ["has", "point_count"]];
    map.setFilter("unclustered-point", filter);
    map.setFilter("unclustered-pulse", filter);
    map.setFilter("unclustered-hit", filter);
  }, [mapLoaded, categoryFilter]);

  // Cross-device sync via polling. All reads go through /api/locations, gated
  // by the app_session cookie, so the browser never holds a public database
  // key. Trade-off: cross-device changes show up within one poll interval
  // plus jitter, not instantly. Acceptable for a small app's traffic pattern.
  useEffect(() => {
    // The demo's data never changes, so the read only demo does not poll.
    if (!mapLoaded || readOnly) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 90s poll: a small app doesn't need a faster cadence, which keeps
    // per-tab Database egress low. focus + visibilitychange still re-poll instantly.
    let retryDelay = 90_000;
    let lastPollAt = 0;

    const poll = async () => {
      if (cancelled) return;
      // Skip polling a backgrounded tab — a hidden tab polling every cycle is
      // needless Database egress. Re-arm cheaply (no fetch); the visibilitychange
      // handler below fires an immediate poll the moment the tab is foregrounded.
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(poll, retryDelay);
        return;
      }
      lastPollAt = Date.now();
      try {
        const fresh = await api.listLocations();
        if (cancelled) return;
        setLocations((prev) => {
          // Reuse the prior signed cover URL when the underlying photo object is
          // unchanged, so a re-signed `?token=` doesn't reload every cover every
          // poll (the list is `no-store` + re-signs per read → otherwise a
          // flicker each poll + wasted re-fetches). Genuine cover changes take
          // the fresh URL.
          const stable = stabilizeCoverUrls(prev, fresh);
          // Preserve any optimistically-added items that haven't yet shown up
          // in the server response (race window between create and poll).
          const freshIds = new Set(fresh.map((l) => l.id));
          const optimistic = prev.filter(
            (l) => recentlyAddedIdsRef.current.has(l.id) && !freshIds.has(l.id),
          );
          // Drop anything we just deleted that a stale cache still returns.
          return [...optimistic, ...stable].filter(
            (l) => !recentlyDeletedIdsRef.current.has(l.id),
          );
        });
        setSupabaseDown(false);
        setPollReconnecting(false);
        retryDelay = 90_000;
      } catch (err) {
        if (cancelled) return;
        // Exponential backoff capped at 5 minutes on persistent failure.
        retryDelay = Math.min(retryDelay * 2, 300_000);
        setSupabaseDown(true);
        if (retryDelay > 120_000) setPollReconnecting(true);
        console.warn(
          "[app] Poll failed, backing off to",
          retryDelay,
          "ms",
          err,
        );
      } finally {
        if (cancelled) return;
        // Re-arm with jitter so two clients don't synchronize.
        const jitter = Math.random() * 5_000;
        timer = setTimeout(poll, retryDelay + jitter);
      }
    };

    // Initial poll on mount.
    poll();

    const debouncedPoll = () => {
      if (Date.now() - lastPollAt < 10_000) return;
      poll();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") debouncedPoll();
    };
    window.addEventListener("focus", debouncedPoll);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", debouncedPoll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [mapLoaded, readOnly]);

  // Pitch follows is3D. A static toggle only: a zoom-event handler that sets
  // pitch would create a feedback loop (setPitch fires 'zoom', which re-fires
  // setPitch).
  useEffect(() => {
    if (!mapLoaded) return;
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ pitch: is3D ? 50 : 0, duration: 300 });
  }, [mapLoaded, is3D]);

  // Warm each location's cover THUMBNAIL into the browser cache shortly after
  // the map settles, so tapping a pin shows its photo near-instantly. We warm
  // the small thumbnail (tens of KB), never the full ~2400px original — that
  // would defeat the byte savings. Covers without a thumbnail yet are skipped
  // (new uploads provision every tier; FramedPhoto serves the full image meanwhile).
  useEffect(() => {
    if (!mapLoaded || typeof window === "undefined") return;
    const handle = window.setTimeout(() => {
      for (const l of locations) {
        const u = l.photo_thumb_url;
        if (!u || prefetchedCoversRef.current.has(u)) continue;
        prefetchedCoversRef.current.add(u);
        const img = new Image();
        img.decoding = "async";
        img.src = u;
      }
    }, 600);
    return () => clearTimeout(handle);
  }, [locations, mapLoaded]);

  // No idle backfill of cover derivatives runs here: re-downloading the full
  // cover from storage on every mount would be a recurring Storage-egress
  // cost. `uploadPhotoDirect` (AdminPanel) provisions full + `.thumb` + `.card`
  // client-side at upload time from the in-browser bytes. A cover that lacks a
  // tier simply falls back to the full image (FramedPhoto), never broken.

  // NOTE: these update the map data only; they DO NOT close the admin panel.
  // The panel close + form reset happen in AdminPanel ONLY after the save's
  // network call SUCCEEDS (via onClose). Closing here would run on the
  // OPTIMISTIC update, before the await, so a failed save would unmount the
  // panel before its error/"Session expired" toast could render. See
  // AdminPanel.handleSave.
  const handleLocationAdded = useCallback((location: Location) => {
    recentlyAddedIdsRef.current.add(location.id);
    setTimeout(() => recentlyAddedIdsRef.current.delete(location.id), 3000);
    setLocations((prev) => {
      if (prev.find((l) => l.id === location.id)) return prev;
      return [location, ...prev];
    });
    setSelectedLocation(location);
    mapRef.current?.flyTo({ center: [location.lng, location.lat], zoom: 14 });
  }, []);

  const handleLocationUpdated = useCallback((location: Location) => {
    setLocations((prev) =>
      prev.map((l) => (l.id === location.id ? location : l)),
    );
    setSelectedLocation((prev) => (prev?.id === location.id ? location : prev));
  }, []);

  const handleLocationPhotoUpdated = useCallback((location: Location) => {
    setLocations((prev) =>
      prev.map((l) => (l.id === location.id ? location : l)),
    );
    setSelectedLocation((prev) => (prev?.id === location.id ? location : prev));
  }, []);

  const handleLocationDeleted = useCallback(
    (id: string) => {
      // Guard against a stale-cache poll re-adding the row (admin delete path).
      recentlyDeletedIdsRef.current.add(id);
      setTimeout(() => recentlyDeletedIdsRef.current.delete(id), 60_000);
      setLocations((prev) => prev.filter((l) => l.id !== id));
      if (selectedLocation?.id === id) setSelectedLocation(null);
    },
    [selectedLocation],
  );

  const handleSidebarSelect = useCallback((location: Location) => {
    setSelectedLocation(location);
    mapRef.current?.flyTo({ center: [location.lng, location.lat], zoom: 14 });
    setSidebarMobileOpen(false);
  }, []);

  const handleSoftDeleteFromCard = useCallback((loc: Location) => {
    if (cardDeleteTimerRef.current) clearTimeout(cardDeleteTimerRef.current);
    pendingCardDeleteLocRef.current = loc;
    setPendingCardDeleteId(loc.id);
    setLocations((prev) => prev.filter((l) => l.id !== loc.id));
    setSelectedLocation(null);
    // Mark it deleted up-front so an interim poll can't restore it; undo clears.
    recentlyDeletedIdsRef.current.add(loc.id);

    cardDeleteTimerRef.current = setTimeout(async () => {
      try {
        // api.deleteLocation goes through apiFetch → sends the CSRF header,
        // which the route requires for state-changing calls.
        await api.deleteLocation(loc.id);
        // Keep the guard for ~60s after a SUCCESSFUL delete to outlast the
        // list route's stale-while-revalidate window, then release it.
        setTimeout(() => recentlyDeletedIdsRef.current.delete(loc.id), 60_000);
      } catch (err) {
        // Delete failed — release the guard now so the row can come back rather
        // than being hidden forever.
        recentlyDeletedIdsRef.current.delete(loc.id);
        console.warn("[app] card delete failed", err);
      }
      setPendingCardDeleteId(null);
      pendingCardDeleteLocRef.current = null;
      cardDeleteTimerRef.current = null;
    }, 5000);
  }, []);

  const handleUndoCardDelete = useCallback(() => {
    if (cardDeleteTimerRef.current) clearTimeout(cardDeleteTimerRef.current);
    cardDeleteTimerRef.current = null;
    const loc = pendingCardDeleteLocRef.current;
    if (loc) {
      recentlyDeletedIdsRef.current.delete(loc.id);
      setLocations((prev) => [loc, ...prev]);
    }
    setPendingCardDeleteId(null);
    pendingCardDeleteLocRef.current = null;
  }, []);

  const handleMobileToggle = useCallback(() => {
    setSidebarMobileOpen((p) => {
      if (!p) setSelectedLocation(null);
      return !p;
    });
  }, []);

  // Deterministic CLOSE (not a toggle). Used by the timeline date-tap + back
  // button. Calling the toggle on top of handleSidebarSelect's
  // setSidebarMobileOpen(false) would batch to flipping the sheet back OPEN
  // and clearing the just-set selection. A plain setter agrees with
  // handleSidebarSelect (both → false) and never touches the selection, so
  // the date tap reliably closes the sheet, flies, and opens the card.
  const closeMobileSheet = useCallback(() => setSidebarMobileOpen(false), []);

  // Reset view to the default frame. Wired to both the mobile header title
  // button and the desktop sidebar h1 (parity).
  const handleResetView = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    map.fitBounds(DEFAULT_BOUNDS, {
      padding: 60,
      duration: 800,
    });
  }, []);

  function handleStyleToggle() {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const newStyle = mapStyle === "vintage" ? "satellite" : "vintage";
    const newStyleUrl =
      newStyle === "satellite"
        ? "mapbox://styles/mapbox/satellite-streets-v12"
        : "mapbox://styles/mapbox/light-v10";
    if (pulseRafRef.current !== null) {
      cancelAnimationFrame(pulseRafRef.current);
      pulseRafRef.current = null;
    }
    map.setStyle(newStyleUrl);
    map.once("style.load", () => {
      initMapLayers(map);
      updateClusterMarkers(map);
      if (newStyle === "vintage") applyPalette(map);
      const cf = categoryFilterRef.current;
      if (cf) {
        map.setFilter("unclustered-point", ["==", ["get", "category"], cf]);
        map.setFilter("unclustered-pulse", ["==", ["get", "category"], cf]);
        map.setFilter("unclustered-hit", ["==", ["get", "category"], cf]);
      }
    });
    setMapStyle(newStyle);
    localStorage.setItem("app-map-style", newStyle);
  }

  function handle3DToggle() {
    setIs3D((curr) => !curr);
  }

  if (mapError) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#F2E8D9",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "16px",
          fontFamily: "var(--font-quicksand), sans-serif",
        }}
      >
        <p style={{ color: "#6B4F3A", fontSize: "16px" }}>
          The map couldn&apos;t load.
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "10px 24px",
            background: "transparent",
            border: "1px solid #C17F5A",
            borderRadius: "100px",
            color: "#C17F5A",
            cursor: "pointer",
            fontSize: "12px",
            letterSpacing: "1.5px",
            textTransform: "uppercase",
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overscrollBehavior: "none",
      }}
    >
      {/* Map container */}
      <div
        ref={mapContainer}
        tabIndex={-1}
        style={{ position: "absolute", inset: 0 }}
        className="map-with-drawer map-container"
      />

      {/* Sidebar */}
      <Sidebar
        locations={locations}
        onSelectLocation={handleSidebarSelect}
        mobileOpen={sidebarMobileOpen}
        onMobileToggle={handleMobileToggle}
        onMobileClose={closeMobileSheet}
        onCategoryFilter={setCategoryFilter}
        activeView={activeView}
        onViewChange={setActiveView}
        isLoading={!mapLoaded}
        onResetView={handleResetView}
      />

      {/* Mobile places button */}
      {!sidebarMobileOpen && (
        <button
          onClick={() => {
            setSidebarMobileOpen(true);
            setSelectedLocation(null);
          }}
          className="mobile-places-btn"
          style={{
            position: "fixed",
            bottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(250,246,240,0.97)",
            border: "1px solid rgba(193,127,90,0.2)",
            borderRadius: "100px",
            padding: "10px 20px",
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "12px",
            letterSpacing: "1.5px",
            color: "#6B4F3A",
            cursor: "pointer",
            boxShadow: "0 2px 16px rgba(74,55,40,0.12)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            zIndex: 20,
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}
        >
          <span style={{ fontSize: "14px" }}>≡</span>
          {BRAND.name} · {locations.length}
        </button>
      )}

      {/* Floating header */}
      <header
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: "52px",
          background: "rgba(250,246,240,0.90)",
          backdropFilter: "blur(10px)",
          borderBottom: "1px solid rgba(193,127,90,0.12)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: "16px",
          paddingRight: "16px",
          zIndex: 20,
        }}
        className="map-header"
      >
        {/* Desktop spacer — matches sidebar width so buttons stay right-aligned */}
        <div
          className="header-sidebar-spacer"
          style={{
            width: "320px",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            paddingLeft: "16px",
          }}
        />

        {/* Mobile title — hidden on desktop */}
        <button
          onClick={handleResetView}
          className="header-title"
          style={{
            fontFamily: "var(--font-cormorant), serif",
            fontStyle: "italic",
            fontSize: "17px",
            color: "#6B4F3A",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          {BRAND.name}
        </button>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {pollReconnecting && (
            <span
              style={{
                fontSize: "10px",
                color: "#9B8578",
                fontFamily: "var(--font-quicksand), sans-serif",
                background: "rgba(193,127,90,0.08)",
                border: "1px solid rgba(193,127,90,0.2)",
                borderRadius: "100px",
                padding: "2px 10px",
                animation: "pulse 2s ease-in-out infinite",
              }}
            >
              Reconnecting…
            </span>
          )}
          {!pollReconnecting && supabaseDown && (
            <span
              style={{
                fontSize: "10px",
                color: "#9B8578",
                fontFamily: "var(--font-quicksand), sans-serif",
              }}
            >
              Saving unavailable right now
            </span>
          )}
          {readOnly && <DemoBanner />}
          {!readOnly && (
            <button
              onClick={() => {
                setAdminOpen(true);
                setSelectedLocation(null);
              }}
              title="Add a place"
              data-testid="admin-fab"
              style={headerBtnStyle}
            >
              +
            </button>
          )}
          <button
            onClick={handleMobileToggle}
            title="Toggle list"
            style={{ ...headerBtnStyle, display: "none" }}
            className="mobile-list-toggle"
          >
            ☰
          </button>
        </div>
      </header>

      {/* Location card */}
      {selectedLocation && (
        <LocationCard
          location={selectedLocation}
          onClose={() => setSelectedLocation(null)}
          onEdit={(loc) => {
            setSelectedLocation(null);
            setEditingLocation(loc);
            setAdminOpen(true);
          }}
          onDelete={handleSoftDeleteFromCard}
          onLocationUpdated={handleLocationPhotoUpdated}
          readOnly={readOnly}
        />
      )}

      {/* Admin panel */}
      {adminOpen && !readOnly && (
        <AdminPanel
          map={mapRef.current}
          onClose={() => {
            setAdminOpen(false);
            setEditingLocation(null);
          }}
          onLocationAdded={handleLocationAdded}
          onLocationUpdated={handleLocationUpdated}
          onLocationPhotoUpdated={handleLocationPhotoUpdated}
          onLocationDeleted={handleLocationDeleted}
          locations={locations}
          editingLocation={editingLocation}
        />
      )}

      {/* Satellite/vintage + 2D/3D toggles — paired top-right (or top-left
          on mobile so they don't overlap the admin/list buttons). Hidden when
          the mobile sheet is open to avoid overlap. */}
      {mapLoaded && !(isMobile && sidebarMobileOpen) && (
        <div
          style={{
            position: "fixed",
            top: "calc(52px + 12px)",
            ...(isMobile ? { left: "12px" } : { right: "12px" }),
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            zIndex: 25,
          }}
        >
          <button
            onClick={handleStyleToggle}
            style={{
              ...mapToggleBtnStyle,
              width: isMobile ? "40px" : "36px",
              height: isMobile ? "40px" : "36px",
              lineHeight: 1,
            }}
            title={mapStyle === "vintage" ? "Satellite view" : "Map view"}
            aria-label={
              mapStyle === "vintage"
                ? "Switch to satellite view"
                : "Switch to map view"
            }
          >
            {mapStyle === "vintage" ? <SatelliteIcon /> : <GlobeIcon />}
          </button>
          <button
            onClick={handle3DToggle}
            style={{
              ...mapToggleBtnStyle,
              width: isMobile ? "40px" : "36px",
              height: isMobile ? "40px" : "36px",
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.5px",
              lineHeight: 1,
            }}
            title={is3D ? "Switch to flat view" : "Switch to 3D view"}
            aria-label={is3D ? "Switch to 2D view" : "Switch to 3D view"}
          >
            {is3D ? "2D" : "3D"}
          </button>
        </div>
      )}

      {/* Card delete undo toast */}
      {pendingCardDeleteId && (
        <div
          style={{
            position: "fixed",
            bottom: "24px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#4A3728",
            color: "white",
            borderRadius: "100px",
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "12px",
            letterSpacing: "1px",
            zIndex: 60,
            overflow: "hidden",
            minWidth: "220px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px 10px 24px",
              gap: "12px",
            }}
          >
            <span>Place removed</span>
            <button
              onClick={handleUndoCardDelete}
              style={{
                background: "none",
                border: "1px solid rgba(255,255,255,0.4)",
                borderRadius: "100px",
                color: "white",
                cursor: "pointer",
                fontFamily: "var(--font-quicksand), sans-serif",
                fontSize: "10px",
                letterSpacing: "1.5px",
                textTransform: "uppercase",
                padding: "3px 10px",
                whiteSpace: "nowrap",
              }}
            >
              Undo
            </button>
          </div>
          <div style={{ height: "3px", background: "rgba(193,127,90,0.15)" }}>
            <div
              key={pendingCardDeleteId}
              style={{
                height: "100%",
                background: "rgba(193,127,90,0.4)",
                animation: "deleteProgress 5s linear forwards",
              }}
            />
          </div>
        </div>
      )}

      <style>{`
        .mapboxgl-ctrl-zoom-in,
        .mapboxgl-ctrl-zoom-out {
          background-color: rgba(250,246,240,0.97) !important;
          color: #6B4F3A !important;
        }
        .mapboxgl-ctrl-zoom-in:hover,
        .mapboxgl-ctrl-zoom-out:hover {
          background-color: rgba(250,246,240,1) !important;
        }
        .mapboxgl-ctrl-group {
          border: 1px solid rgba(193,127,90,0.2) !important;
          box-shadow: 0 2px 8px rgba(74,55,40,0.08) !important;
        }
        /* The Mapbox wordmark and attribution render at their default size
           and full opacity, as the Mapbox terms of service require. The
           background tint only increases contrast against the map. */
        .mapboxgl-ctrl-attrib {
          background: rgba(250,246,240,0.65) !important;
        }
        .mapboxgl-ctrl-bottom-right {
          bottom: calc(16px + env(safe-area-inset-bottom, 0px)) !important;
          right: 12px !important;
        }
        /* Corner padding that keeps the logo and attribution close to the
           edge and to each other. */
        .mapboxgl-ctrl-bottom-left {
          bottom: calc(8px + env(safe-area-inset-bottom, 0px)) !important;
          left: 6px !important;
        }
        .mapboxgl-ctrl-bottom-left .mapboxgl-ctrl {
          margin: 0 4px 4px 0 !important;
        }
        /* From 768px up the list sits on top of the map's left edge (320px
           wide, 280px below 1024px; see Sidebar.tsx). Move the Mapbox
           wordmark and attribution out from under it, so they stay in view
           as the Mapbox terms of service require. */
        @media (min-width: 768px) and (max-width: 1023px) {
          .mapboxgl-ctrl-bottom-left { left: calc(280px + 6px) !important; }
        }
        @media (min-width: 1024px) {
          .mapboxgl-ctrl-bottom-left { left: calc(320px + 6px) !important; }
        }
        /* From 768px up a place's card opens just right of the list, 32px
           above the bottom edge (LocationCard.tsx). Stacked, the attribution
           button would end up under it. Side by side, both controls fit in
           the 32px below the card: 8px from the edge plus 24px of height. */
        @media (min-width: 768px) {
          .mapboxgl-ctrl-bottom-left {
            display: flex !important;
            align-items: flex-end !important;
          }
          .mapboxgl-ctrl-bottom-left .mapboxgl-ctrl {
            margin: 0 4px 0 0 !important;
          }
        }
        @media (min-width: 768px) {
          .header-title { display: none !important; }
          .header-sidebar-spacer { display: flex !important; }
        }
        @media (max-width: 767px) {
          .header-sidebar-spacer { display: none !important; }
          .map-header {
            padding-left: 16px !important;
          }
          .mobile-list-toggle {
            display: flex !important;
          }
          .map-with-drawer {
            padding-bottom: calc(72px + env(safe-area-inset-bottom, 0px));
          }
        }
        @media (min-width: 768px) {
          .mobile-places-btn { display: none !important; }
        }
        @media (min-width: 768px) and (max-width: 1023px) {
          .header-sidebar-spacer { width: 280px !important; }
        }
        .mapboxgl-canvas-container,
        .mapboxgl-canvas {
          z-index: 1 !important;
        }
        .mapboxgl-marker {
          z-index: 2 !important;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes deleteProgress {
          from { width: 100%; }
          to { width: 0%; }
        }
        .mapboxgl-canvas-container {
          cursor: default !important;
        }
        .mapboxgl-canvas-container textarea {
          caret-color: transparent !important;
          color: transparent !important;
          opacity: 0 !important;
        }
        .sidebar-desktop * {
          cursor: default;
        }
      `}</style>
    </div>
  );
}

// Inline line-icon components for the style toggle. Match the existing
// inline-SVG vocabulary used by Sidebar/AdminPanel/LocationCard rather than
// adding a lucide-react dependency. Path data adapted from Lucide
// (https://lucide.dev) — Globe + Satellite glyphs. stroke 1.75, round caps.
function GlobeIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M21.54 15H17a2 2 0 0 0-2 2v4.54" />
      <path d="M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17" />
      <path d="M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05" />
    </svg>
  );
}

function SatelliteIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 7 9 3 5 7l4 4" />
      <path d="m17 11 4 4-4 4-4-4" />
      <path d="m8 12 4 4 6-6-4-4Z" />
      <path d="m16 8 3-3" />
      <path d="M9 21a6 6 0 0 0-6-6" />
    </svg>
  );
}

const headerBtnStyle: React.CSSProperties = {
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
  transition: "background 0.15s",
};

// Square icon-button base for the map view toggles (style + 3D). Per-button
// width/height/font are set inline so the same base can support emoji
// (18px) and text (11px) content without separate constants. Mirrors
// `headerBtnStyle` vocabulary (8px radius, warm brown text, subtle border)
// but uses a solid cream background so the buttons remain legible against
// satellite imagery.
const mapToggleBtnStyle: React.CSSProperties = {
  background: "#FAF6F0",
  border: "1px solid rgba(193,127,90,0.2)",
  borderRadius: "8px",
  padding: 0,
  fontFamily: "var(--font-quicksand), sans-serif",
  color: "#6B4F3A",
  cursor: "pointer",
  boxShadow: "0 1px 4px rgba(74,55,40,0.10)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "background 0.15s",
};
