"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { CATEGORIES } from "@/lib/constants";
import { api, setReauthReloadSuppressed } from "@/lib/api-client";
import {
  offsetForPhoto,
  photoFilename,
  cardSurfaceAspect,
  mergePhotoOffset,
} from "@/lib/photos";
import {
  makeThumbnail,
  makeCardImage,
  makeLqip,
  LQIP_ENABLED,
} from "@/lib/image-resize";
import type { Location, CategoryKey } from "@/types";
import mapboxgl from "mapbox-gl";
import PhotoEditGrid from "./PhotoEditGrid";
import ReframeOverlay from "./ReframeOverlay";

// Reads the app_csrf cookie set by /api/auth on successful login. The
// double-submit cookie pattern: server compares this value (sent as a
// header) against the cookie. State-changing endpoints reject with 403
// if the header is missing or mismatched.
function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)app_csrf=([^;]+)/);
  return m ? m[1] : null;
}

function csrfHeader(): Record<string, string> {
  const t = getCsrfToken();
  return t ? { "X-CSRF-Token": t } : {};
}

interface AdminPanelProps {
  map: mapboxgl.Map | null;
  onClose: () => void;
  onLocationAdded: (location: Location) => void;
  onLocationUpdated: (location: Location) => void;
  onLocationPhotoUpdated: (location: Location) => void;
  onLocationDeleted: (id: string) => void;
  locations: Location[];
  editingLocation?: Location | null;
}

interface SuggestFeature {
  mapbox_id: string;
  name: string;
  place_formatted: string;
  feature_type: string;
}

interface RetrieveFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name: string;
    place_formatted?: string;
    full_address?: string;
  };
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

async function compressImage(
  file: File,
  maxWidthPx = 2400,
  qualityJpeg = 0.92,
): Promise<File> {
  const isHeic =
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    file.name.toLowerCase().endsWith(".heic") ||
    file.name.toLowerCase().endsWith(".heif");
  if (isHeic) throw new Error("HEIC_UNSUPPORTED");

  if (file.size < 1.5 * 1024 * 1024) {
    console.log(
      `[app] compressImage skipped (${(file.size / 1024).toFixed(0)}KB already < 1.5MB)`,
    );
    return file;
  }

  try {
    // createImageBitmap with imageOrientation: 'from-image' applies EXIF
    // rotation natively — fixes the iPhone-portrait-loaded-sideways problem.
    // EXIF metadata (GPS, device info) is automatically stripped because
    // canvas-based encoding doesn't preserve any source metadata. This is
    // a privacy feature, not a bug.
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    const scale = Math.min(
      1,
      maxWidthPx / Math.max(bitmap.width, bitmap.height),
    );
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    let blob: Blob | null = null;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, w, h);
        blob = await canvas.convertToBlob({
          type: "image/jpeg",
          quality: qualityJpeg,
        });
      }
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, w, h);
        blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", qualityJpeg),
        );
      }
    }
    bitmap.close();

    if (!blob) return file;

    const compressed = new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
      type: "image/jpeg",
    });
    const ratio = (file.size / compressed.size).toFixed(2);
    console.log(
      `[app] compressImage: ${(file.size / 1024).toFixed(0)}KB → ${(compressed.size / 1024).toFixed(0)}KB (${ratio}× smaller, ${w}×${h})`,
    );
    return compressed;
  } catch (err) {
    if ((err as Error).message === "HEIC_UNSUPPORTED") throw err;
    console.warn("[app] compressImage failed, using original:", err);
    return file;
  }
}

interface UploadResult {
  photo_url: string;
  photos: string[];
  /** Stable storage object name of the just-uploaded photo (for LQIP keying). */
  objectName?: string;
}

async function uploadPhotoDirect(
  file: File,
  locationId: string,
): Promise<UploadResult | null> {
  let storageSucceeded = false;
  let objectName: string | undefined;
  try {
    const urlRes = await fetch(`/api/locations/${locationId}/photo-url`, {
      method: "POST",
      headers: csrfHeader(),
    });
    if (!urlRes.ok) {
      console.error("[app] photo-url route failed:", urlRes.status);
      return null;
    }
    const { signedUrl, path, thumbSignedUrl, cardSignedUrl } =
      await urlRes.json();
    objectName = (path as string)?.split("/").pop() ?? path;
    const uploadRes = await fetch(signedUrl, {
      method: "PUT",
      body: file,
      headers: {
        "Content-Type": file.type || "image/jpeg",
        // Photo bytes are immutable per object name, so cache them for a year.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
    if (!uploadRes.ok) {
      console.error(
        "[app] direct storage upload failed:",
        uploadRes.status,
        await uploadRes.text(),
      );
      return null;
    }
    storageSucceeded = true;

    // Generate + upload a small cover thumbnail alongside the original so the
    // map card + timeline never download the full image. Best-effort: any
    // failure leaves no thumbnail and the full image is served as the fallback.
    if (thumbSignedUrl) {
      try {
        const thumb = await makeThumbnail(file);
        if (thumb) {
          const res = await fetch(thumbSignedUrl, {
            method: "PUT",
            body: thumb.blob,
            headers: {
              "Content-Type": thumb.contentType,
              "cache-control": "public, max-age=31536000, immutable",
            },
          });
          // A non-2xx PUT does NOT throw — surface it so a silently-failed
          // thumbnail isn't mistaken for success (the full image is the fallback).
          if (!res.ok)
            console.warn("[app] thumbnail upload failed:", res.status);
        }
      } catch (thumbErr) {
        console.warn("[app] thumbnail upload skipped:", thumbErr);
      }
    }

    // Also generate + upload the ~1152px card-tier image so the map card renders
    // sharp at DPR 3 without pulling the full original. Best-effort, same as the
    // thumbnail: a failure falls back to the full image on the card.
    if (cardSignedUrl) {
      try {
        const card = await makeCardImage(file);
        if (card) {
          const res = await fetch(cardSignedUrl, {
            method: "PUT",
            body: card.blob,
            headers: {
              "Content-Type": card.contentType,
              "cache-control": "public, max-age=31536000, immutable",
            },
          });
          if (!res.ok)
            console.warn("[app] card image upload failed:", res.status);
        }
      } catch (cardErr) {
        console.warn("[app] card image upload skipped:", cardErr);
      }
    }

    const saveRes = await fetch(`/api/locations/${locationId}/photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeader() },
      body: JSON.stringify({ path }),
    });
    if (!saveRes.ok) {
      console.error("[app] save path failed:", saveRes.status, "— retrying");
      await new Promise((r) => setTimeout(r, 1500));
      const retryRes = await fetch(`/api/locations/${locationId}/photo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeader() },
        body: JSON.stringify({ path }),
      });
      if (retryRes.ok) return { ...(await retryRes.json()), objectName };
      return { photo_url: "", photos: [], objectName };
    }
    return { ...(await saveRes.json()), objectName };
  } catch (err) {
    console.error("[app] uploadPhotoDirect failed:", err);
    if (storageSucceeded) return { photo_url: "", photos: [], objectName };
    return null;
  }
}

export default function AdminPanel({
  map,
  onClose,
  onLocationAdded,
  onLocationUpdated,
  onLocationPhotoUpdated,
  onLocationDeleted,
  locations,
  editingLocation,
}: AdminPanelProps) {
  const [visible, setVisible] = useState(false);
  const [panelHidden, setPanelHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SuggestFeature[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedLat, setSelectedLat] = useState<number | null>(null);
  const [selectedLng, setSelectedLng] = useState<number | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const [clickMode, setClickMode] = useState(false);
  const [title, setTitle] = useState("");
  const [dateLabel, setDateLabel] = useState("");
  const [category, setCategory] = useState<CategoryKey>("everyday");
  const [description, setDescription] = useState("");
  const [saveError, setSaveError] = useState("");
  const [toast, setToast] = useState("");
  const [geocodeError, setGeocodeError] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingPhotos, setPendingPhotos] = useState<File[]>([]);
  const [pendingPhotoUrls, setPendingPhotoUrls] = useState<string[]>([]);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [existingPhotos, setExistingPhotos] = useState<string[]>([]);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(
    null,
  );
  // Reframe overlay — the signed URL of the photo currently being reframed.
  const [reframeUrl, setReframeUrl] = useState<string | null>(null);
  const [reframeSaving, setReframeSaving] = useState(false);
  // width/height aspect of the card surface this photo lands on, so the reframe
  // preview is WYSIWYG with the card. Computed CLIENT-SIDE in an effect (below):
  // the overlay never server-renders, and recomputing on resize keeps it correct
  // if the device is rotated mid-reframe.
  const [reframeAspect, setReframeAspect] = useState(1.65);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const tempMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDeleteLocRef = useRef<Location | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const overlayGuardRef = useRef(false);
  const overlayGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionTokenRef = useRef<string>(crypto.randomUUID());
  const panelRef = useRef<HTMLDivElement>(null);
  const toastActionRef = useRef<(() => void) | null>(null);
  const [toastHasAction, setToastHasAction] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "success">(
    "idle",
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // While the admin panel is open, a background api-client 401 (poll / photo
    // fetch) must NOT hard-reload the page — that would discard the pending edit
    // and race the save's own re-auth toast. Restored on unmount.
    setReauthReloadSuppressed(true);
    return () => {
      mountedRef.current = false;
      setReauthReloadSuppressed(false);
      tempMarkerRef.current?.remove();
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      if (mobileHideTimeoutRef.current)
        clearTimeout(mobileHideTimeoutRef.current);
      if (overlayGuardTimerRef.current)
        clearTimeout(overlayGuardTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  // Auto-start edit when editingLocation prop is set
  useEffect(() => {
    if (editingLocation) {
      startEdit(editingLocation);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingLocation?.id]);

  // Fetch existing photos when entering edit mode
  useEffect(() => {
    if (!editingId) {
      setExistingPhotos([]);
      return;
    }
    fetch(`/api/locations/${editingId}/photo`)
      .then((r) => {
        // A failed read is not "no photos": keep the list and say so.
        if (!r.ok) throw new Error(`photo list failed: ${r.status}`);
        return r.json();
      })
      .then((data) => setExistingPhotos(data.photos ?? []))
      .catch(() => {
        if (mountedRef.current)
          setPhotoError(
            "Couldn't load this place's photos. Close and open it again.",
          );
      });
  }, [editingId]);

  // Keep the reframe preview aspect matched to the card surface — recomputed
  // when the overlay opens and on viewport resize/rotate, all client-side (the
  // overlay is never SSR'd, so this can read window.innerWidth safely).
  useEffect(() => {
    if (!reframeUrl) return;
    const update = () =>
      setReframeAspect(cardSurfaceAspect(existingPhotos.length));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [reframeUrl, existingPhotos.length]);

  // Click-mode listener
  useEffect(() => {
    if (!map || !clickMode) return;

    const canvas = map.getCanvas();
    const container = map.getCanvasContainer();

    let fired = false;
    const handleClick = (e: mapboxgl.MapMouseEvent) => {
      fired = true;
      map.off("click", handleClick);
      const { lat, lng } = e.lngLat;
      setSelectedLat(lat);
      setSelectedLng(lng);
      setClickMode(false);
      canvas.blur();
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();

      // Re-show panel on mobile after pin is dropped
      if (typeof window !== "undefined" && window.innerWidth < 768) {
        if (mobileHideTimeoutRef.current) {
          clearTimeout(mobileHideTimeoutRef.current);
          mobileHideTimeoutRef.current = null;
        }
        setPanelHidden(false);
        setTimeout(() => setVisible(true), 10);
      }

      tempMarkerRef.current?.remove();
      const el = createTempMarkerEl();
      tempMarkerRef.current = new mapboxgl.Marker({
        element: el,
        anchor: "center",
      })
        .setLngLat([lng, lat])
        .addTo(map);

      map.flyTo({ center: [lng, lat], zoom: 14 });
    };

    canvas.style.cursor = "crosshair";
    if (container) container.style.cursor = "crosshair";
    map.on("click", handleClick);

    return () => {
      if (!fired) map.off("click", handleClick);
      canvas.style.cursor = "";
      if (container) container.style.cursor = "";
      canvas.blur();
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    };
  }, [map, clickMode]);

  const handleSearch = useCallback(
    (q: string) => {
      setSearchQuery(q);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      if (!q.trim()) {
        setSearchResults([]);
        return;
      }

      searchDebounceRef.current = setTimeout(async () => {
        setSearching(true);
        setGeocodeError("");
        try {
          const center = map?.getCenter();
          const lat = center?.lat;
          const lng = center?.lng;
          const res = await fetch(
            `/api/geocode?q=${encodeURIComponent(q)}&session=${sessionTokenRef.current}${lat && lng ? `&lat=${lat}&lng=${lng}` : ""}`,
          );
          if (res.ok) {
            const suggestions: SuggestFeature[] = await res.json();
            setSearchResults(suggestions.slice(0, 6));
          } else {
            setGeocodeError(
              "Couldn't find that place — try clicking the map directly",
            );
            setSearchResults([]);
          }
        } catch {
          setGeocodeError(
            "Couldn't find that place — try clicking the map directly",
          );
          setSearchResults([]);
        } finally {
          setSearching(false);
        }
      }, 250);
    },
    [map],
  );

  async function selectResult(feature: SuggestFeature) {
    setSearchQuery(feature.name);
    setSearchResults([]);
    setSearching(true);

    try {
      const res = await fetch(
        `/api/geocode?retrieve=${encodeURIComponent(feature.mapbox_id)}&session=${sessionTokenRef.current}`,
      );
      if (res.ok) {
        const retrieved: RetrieveFeature = await res.json();
        if (retrieved?.geometry?.coordinates) {
          const [lng, lat] = retrieved.geometry.coordinates;
          setSelectedLat(lat);
          setSelectedLng(lng);
          setSelectedName(feature.place_formatted ?? feature.name);
          setTitle(retrieved.properties?.name ?? feature.name);

          if (map) {
            tempMarkerRef.current?.remove();
            const el = createTempMarkerEl();
            tempMarkerRef.current = new mapboxgl.Marker({
              element: el,
              anchor: "center",
            })
              .setLngLat([lng, lat])
              .addTo(map);
            map.flyTo({ center: [lng, lat], zoom: 14 });
          }
        }
      } else {
        setGeocodeError(
          "Couldn't retrieve location — try clicking the map directly",
        );
      }
    } catch {
      setGeocodeError(
        "Couldn't retrieve location — try clicking the map directly",
      );
    } finally {
      setSearching(false);
    }
  }

  function startEdit(loc: Location) {
    setEditingId(loc.id);
    setTitle(loc.title);
    setDateLabel(loc.date_label);
    setDescription(loc.description ?? "");
    setCategory(loc.category);
    setSelectedLat(loc.lat);
    setSelectedLng(loc.lng);
    setSelectedName(loc.title);
    setSearchQuery(loc.title);
    setSearchResults([]);
    setSaveError("");
    setPhotoError(null);
    setPendingPhotos([]);
    setPendingPhotoUrls([]);

    if (map) {
      tempMarkerRef.current?.remove();
      const el = createTempMarkerEl();
      tempMarkerRef.current = new mapboxgl.Marker({
        element: el,
        anchor: "center",
      })
        .setLngLat([loc.lng, loc.lat])
        .addTo(map);
      map.flyTo({ center: [loc.lng, loc.lat], zoom: 14, speed: 1.2 });
    }

    panelRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetForm() {
    setEditingId(null);
    setTitle("");
    setDateLabel("");
    setDescription("");
    setCategory("everyday");
    setSelectedLat(null);
    setSelectedLng(null);
    setSelectedName("");
    setSearchQuery("");
    setSearchResults([]);
    setSaveError("");
    setPhotoError(null);
    setPendingPhotos([]);
    setPendingPhotoUrls([]);
    setExistingPhotos([]);
    tempMarkerRef.current?.remove();
    tempMarkerRef.current = null;
  }

  function handleClickModeToggle() {
    const next = !clickMode;
    // Blur any focused input before entering click mode — prevents the text caret
    // from showing through over the map canvas (the "green cursor" artifact on iOS).
    if (next && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setClickMode(next);
    if (next && typeof window !== "undefined" && window.innerWidth < 768) {
      setVisible(false);
      mobileHideTimeoutRef.current = setTimeout(
        () => setPanelHidden(true),
        300,
      );
    }
  }

  // Compute + persist a per-photo LQIP placeholder. Gated: a no-op unless
  // NEXT_PUBLIC_LQIP_ENABLED=1 and the `photo_lqips` column exists. Reads the
  // row to merge so any photo's prior placeholders are preserved. Best-effort.
  async function persistPhotoLqip(
    locationId: string,
    objectName: string | undefined,
    file: Blob,
  ) {
    if (!LQIP_ENABLED || !objectName) return;
    try {
      const lqip = await makeLqip(file);
      if (!lqip) return;
      const cur = await api.getLocation(locationId).catch(() => null);
      const merged = { ...(cur?.photo_lqips ?? {}), [objectName]: lqip };
      const realLoc = await api.setPhotoLqips(locationId, merged);
      onLocationPhotoUpdated(realLoc);
    } catch (err) {
      console.warn("[app] persistPhotoLqip failed:", err);
    }
  }

  async function handlePhotoUpload(file: File, locationId: string) {
    setPhotoUploading(true);
    setPhotoError(null);
    const beforeUploadCount = existingPhotos.length;
    try {
      const data = await uploadPhotoDirect(file, locationId);
      if (data?.objectName)
        void persistPhotoLqip(locationId, data.objectName, file);
      if (data === null) {
        // upload step reported failure — verify storage before surfacing the error
        const fresh = await fetch(`/api/locations/${locationId}/photo`)
          .then((r) => r.json())
          .catch(() => ({ photos: [], photo_url: null }));
        if ((fresh.photos ?? []).length > beforeUploadCount) {
          setExistingPhotos(fresh.photos ?? []);
          const updated = locations.find((l) => l.id === locationId);
          if (updated)
            onLocationPhotoUpdated({
              ...updated,
              photo_url: fresh.photo_url ?? undefined,
              photos: fresh.photos ?? [],
            });
        } else {
          showToast("Upload failed — try again");
        }
      } else if (data.photos.length === 0 && data.photo_url === "") {
        const fresh = await fetch(`/api/locations/${locationId}/photo`)
          .then((r) => r.json())
          .catch(() => ({ photos: [], photo_url: null }));
        setExistingPhotos(fresh.photos ?? []);
        const updated = locations.find((l) => l.id === locationId);
        if (updated)
          onLocationPhotoUpdated({
            ...updated,
            photo_url: fresh.photo_url ?? undefined,
            photos: fresh.photos ?? [],
          });
      } else {
        const { photo_url, photos } = data;
        setExistingPhotos(photos);
        const updated = locations.find((l) => l.id === locationId);
        if (updated) onLocationPhotoUpdated({ ...updated, photo_url, photos });
      }
    } catch {
      showToast("Upload failed — try again");
    }
    setPhotoUploading(false);
  }

  async function handlePhotoRemoveByUrl(locationId: string, url: string) {
    // Strip query string before extracting filename (signed URLs have ?token=...)
    const urlWithoutQuery = url.split("?")[0];
    const filename = urlWithoutQuery.split("/").pop() ?? "";
    if (!filename) return;
    setPhotoUploading(true);
    setPhotoError(null);
    try {
      const res = await fetch(
        `/api/locations/${locationId}/photo?filename=${encodeURIComponent(filename)}`,
        { method: "DELETE", headers: csrfHeader() },
      );
      if (res.ok) {
        const data = await res.json();
        setExistingPhotos(data.photos ?? []);
        const updated = locations.find((l) => l.id === locationId);
        if (updated)
          onLocationPhotoUpdated({
            ...updated,
            photo_url: data.photo_url ?? undefined,
            photos: data.photos,
          });
      } else {
        showToast("Delete failed — try again");
      }
    } catch {
      showToast("Delete failed — try again");
    }
    setPhotoUploading(false);
  }

  // Persist a per-photo normalized framing (pan + zoom) in one PATCH (optimistic
  // + rollback). Keyed by the photo's stable storage object name.
  async function handleReframeSave(offset: {
    x: number;
    y: number;
    scale: number;
  }) {
    const loc = editingId
      ? locations.find((l) => l.id === editingId)
      : undefined;
    const newOffsets =
      reframeUrl && loc
        ? mergePhotoOffset(loc.photo_offsets, reframeUrl, offset)
        : null;
    if (!editingId || !loc || !newOffsets) {
      setReframeUrl(null);
      return;
    }
    setReframeSaving(true);
    onLocationPhotoUpdated({ ...loc, photo_offsets: newOffsets });
    try {
      const realLoc = await api.setPhotoOffsets(editingId, newOffsets);
      onLocationPhotoUpdated(realLoc);
      setReframeUrl(null);
    } catch (err) {
      onLocationPhotoUpdated(loc); // rollback
      console.error("[app] setPhotoOffsets failed:", err);
      showToast("Couldn't save framing — try again");
    } finally {
      setReframeSaving(false);
    }
  }

  // Commit a drag-reorder (one PATCH, optimistic + rollback). `filenames` is the
  // desired order of stable storage object names; the server re-signs + sets the
  // cover to filenames[0].
  async function handleReorder(filenames: string[]) {
    if (!editingId) return;
    const loc = locations.find((l) => l.id === editingId);
    if (!loc) return;
    const prevExisting = existingPhotos;
    const byFn = new Map(
      existingPhotos.map((u) => [photoFilename(u), u] as const),
    );
    const optimistic = filenames
      .map((fn) => byFn.get(fn))
      .filter((u): u is string => !!u);
    if (!optimistic.length) return;
    setExistingPhotos(optimistic);
    onLocationPhotoUpdated({
      ...loc,
      photos: optimistic,
      photo_url: optimistic[0] ?? loc.photo_url,
    });
    try {
      const realLoc = await api.reorderPhotos(editingId, filenames);
      setExistingPhotos(realLoc.photos ?? optimistic);
      onLocationPhotoUpdated(realLoc);
    } catch (err) {
      setExistingPhotos(prevExisting); // rollback
      onLocationPhotoUpdated(loc);
      console.error("[app] reorderPhotos failed:", err);
      showToast("Couldn't reorder — try again");
    }
  }

  function triggerSaveSuccess() {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(15);
    }
    if (mountedRef.current) {
      setSaveState("success");
      setTimeout(() => {
        if (mountedRef.current) setSaveState("idle");
      }, 600);
    }
  }

  async function handleSave() {
    if (
      !title.trim() ||
      !dateLabel ||
      selectedLat === null ||
      selectedLng === null
    )
      return;
    setSaveError("");
    setSaveState("saving");
    tempMarkerRef.current?.remove();
    tempMarkerRef.current = null;

    if (editingId) {
      const savedEditingId = editingId;
      const originalLoc = locations.find((l) => l.id === savedEditingId);
      if (!originalLoc) return;

      const optimisticLoc: Location = {
        ...originalLoc,
        title: title.trim(),
        date_label: dateLabel,
        lat: selectedLat,
        lng: selectedLng,
        description: description.trim(),
        category,
      };

      // Optimistic map update only — DO NOT reset the form or close the panel
      // here. On failure the panel must stay mounted so its toast renders and
      // the pending edit is preserved; reset + close happen only on success.
      onLocationUpdated(optimisticLoc);

      try {
        const res = await fetch(`/api/locations/${savedEditingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...csrfHeader() },
          body: JSON.stringify({
            title: optimisticLoc.title,
            date_label: optimisticLoc.date_label,
            lat: optimisticLoc.lat,
            lng: optimisticLoc.lng,
            description: optimisticLoc.description,
            category: optimisticLoc.category,
          }),
        });
        if (!res.ok) {
          onLocationUpdated(originalLoc);
          if (mountedRef.current) setSaveState("idle");
          await reportSaveFailure(res, "PATCH");
          return;
        }
        const realLoc: Location = await res.json();
        onLocationUpdated(realLoc);
        triggerSaveSuccess();
        resetForm();
        onClose(); // close + reset ONLY after a confirmed save
      } catch (err) {
        onLocationUpdated(originalLoc);
        if (mountedRef.current) setSaveState("idle");
        console.error("[app] PATCH /api/locations failed:", err);
        showToast("Couldn't save — check your connection");
      }
    } else {
      const tempId = crypto.randomUUID();
      const optimisticLoc: Location = {
        id: tempId,
        title: title.trim(),
        date_label: dateLabel,
        description: description.trim(),
        category,
        lat: selectedLat,
        lng: selectedLng,
        display_order: 0,
        created_at: new Date().toISOString(),
      };

      const photosToUpload = [...pendingPhotos];
      // Optimistic pin only — the form reset + panel close happen below ONLY
      // after the row is created (and photos uploaded), so a failed save keeps
      // the panel mounted (toast visible) with the pending edit intact.
      onLocationAdded(optimisticLoc);

      try {
        const res = await fetch("/api/locations", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...csrfHeader() },
          body: JSON.stringify({
            title: optimisticLoc.title,
            date_label: optimisticLoc.date_label,
            lat: optimisticLoc.lat,
            lng: optimisticLoc.lng,
            description: optimisticLoc.description,
            category: optimisticLoc.category,
          }),
        });
        if (!res.ok) {
          onLocationDeleted(tempId);
          if (mountedRef.current) setSaveState("idle");
          await reportSaveFailure(res, "POST");
          return;
        }
        let newLocation: Location = await res.json();
        // Failure model: COMMIT-SUCCESSES-AND-REPORT-FAILURES. The location row
        // is created first; each photo registers independently and is persisted
        // server-side the moment it succeeds. We keep the authoritative photos[]
        // as it grows and NEVER let a failed upload overwrite it: an empty
        // result must not replace earlier successes.
        //
        // uploadPhotoDirect returns one of:
        //   • { photos:[non-empty] } — clean success. rebuildPhotos always
        //     includes the just-uploaded object, so a real success is never empty.
        //   • { photos: [] }         — PARTIAL failure: the file DID reach storage
        //     but the DB registration POST failed. Because the object is in
        //     storage, the next read self-heals it back onto the list
        //     (resolvePhotoOrder reconciles against storage). We re-fetch the
        //     authoritative list and RECOVER it rather than clobber — mirroring
        //     the edit-mode handlePhotoUpload path. If the re-fetch can't confirm
        //     the photo (after a retry), we conservatively report it rather than
        //     silently trust the self-heal. Either way nothing is lost.
        //   • null                   — TOTAL failure: the upload never reached
        //     storage. Genuinely unsaved → reported so the user can retry.
        let committedPhotos: string[] = Array.isArray(newLocation.photos)
          ? newLocation.photos
          : [];
        let committedCover: string | undefined = newLocation.photo_url;
        const failedPhotos: number[] = [];
        for (let i = 0; i < photosToUpload.length; i++) {
          const photo = photosToUpload[i];
          let data: UploadResult | null = null;
          try {
            data = await uploadPhotoDirect(photo, newLocation.id);
          } catch (photoErr) {
            console.error("[app] uploadPhotoDirect failed:", photoErr);
          }
          // A truthy result means the file reached storage (objectName set);
          // worth a placeholder even if registration lagged.
          if (data?.objectName)
            void persistPhotoLqip(newLocation.id, data.objectName, photo);

          if (data && data.photos.length > 0) {
            committedPhotos = data.photos;
            committedCover = data.photos[0] || committedCover;
          } else if (data) {
            // Partial failure: the bytes reached storage but the DB registration
            // POST failed. Re-fetch the authoritative, storage-reconciled list
            // (resolvePhotoOrder re-appends the object) and adopt it if the photo
            // recovered. NEVER clobber committedPhotos with the empty result.
            //
            // Be conservative: retry once (let storage listing + signing settle),
            // and if we STILL can't confirm the photo landed, REPORT it rather
            // than silently assume the self-heal — over-warning beats a silent
            // drop for irreplaceable photos. The bytes remain safe in storage and
            // also heal on the next poll/card read, so a retry is duplicate-free.
            let recovered: string[] | null = null;
            for (let attempt = 0; attempt < 2 && !recovered; attempt++) {
              if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
              const fresh = await fetch(
                `/api/locations/${newLocation.id}/photo`,
              )
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null);
              if (
                fresh &&
                Array.isArray(fresh.photos) &&
                fresh.photos.length > committedPhotos.length
              ) {
                recovered = fresh.photos as string[];
              }
            }
            if (recovered) {
              committedPhotos = recovered;
              committedCover = recovered[0] || committedCover;
            } else {
              console.warn(
                `[app] photo ${i + 1} reached storage but its registration could not be confirmed — reporting it for retry`,
              );
              failedPhotos.push(i + 1);
            }
          } else {
            // Total failure (null): never reached storage. Genuinely unsaved.
            failedPhotos.push(i + 1);
          }
        }
        newLocation = {
          ...newLocation,
          photo_url: committedCover,
          photos: committedPhotos,
        };
        // Commit the row + every photo that DID register to the map first — this
        // is safe even if the panel later unmounts.
        onLocationDeleted(tempId);
        onLocationAdded(newLocation);

        if (failedPhotos.length > 0) {
          // Some photos didn't upload. The row + the successful photos are saved;
          // switch the panel into EDIT mode for the new location so the saved
          // photos stay visible and re-adding a photo APPENDS (never a duplicate
          // row), surface exactly which photos failed, and DO NOT close-as-success.
          if (mountedRef.current) {
            setEditingId(newLocation.id);
            setExistingPhotos(committedPhotos);
            setPendingPhotos([]);
            setPendingPhotoUrls([]);
            setSaveState("idle");
            const n = failedPhotos.length;
            const noun = n === 1 ? "photo" : "photos";
            const which =
              n === 1
                ? `Photo ${failedPhotos[0]}`
                : `Photos ${failedPhotos.join(", ")}`;
            setPhotoError(
              `${which} didn't upload — tap + to add ${n === 1 ? "it" : "them"} again. Everything else is saved.`,
            );
            showToast(
              `${n} ${noun} didn't upload — your other changes are saved`,
            );
          }
          return;
        }

        triggerSaveSuccess();
        resetForm();
        onClose(); // close + reset ONLY after a confirmed save
      } catch (err) {
        onLocationDeleted(tempId);
        if (mountedRef.current) setSaveState("idle");
        console.error("[app] POST /api/locations failed:", err);
        showToast("Couldn't save — check your connection");
      }
    }
  }

  async function reportSaveFailure(res: Response, method: string) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {}
    console.error(
      `[app] ${method} /api/locations failed:`,
      res.status,
      bodyText,
    );
    if (res.status === 401) {
      showToast("Session expired — tap to sign in again", () => {
        window.location.href = "/";
      });
    } else if (res.status === 429) {
      showToast("Too many requests — wait a moment");
    } else {
      let serverMsg = "";
      try {
        serverMsg = JSON.parse(bodyText)?.error ?? "";
      } catch {}
      showToast(
        serverMsg ? `Save failed: ${serverMsg}` : "Save failed — try again",
      );
    }
  }

  function handleSoftDelete(loc: Location) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    pendingDeleteLocRef.current = loc;
    setPendingDeleteId(loc.id);

    deleteTimerRef.current = setTimeout(async () => {
      try {
        await fetch(`/api/locations/${loc.id}`, {
          method: "DELETE",
          headers: csrfHeader(),
        });
      } catch (err) {
        console.error("[app] DELETE /api/locations failed:", err);
      }
      onLocationDeleted(loc.id);
      setPendingDeleteId(null);
      pendingDeleteLocRef.current = null;
      deleteTimerRef.current = null;
    }, 5000);
  }

  function handleUndoDelete() {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    deleteTimerRef.current = null;
    setPendingDeleteId(null);
    pendingDeleteLocRef.current = null;
  }

  function showToast(msg: string, action?: () => void) {
    setToast(msg);
    setToastHasAction(!!action);
    toastActionRef.current = action ?? null;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToast("");
      setToastHasAction(false);
      toastActionRef.current = null;
      toastTimerRef.current = null;
    }, 4000);
  }

  const canSave =
    title.trim() && dateLabel && selectedLat !== null && selectedLng !== null;

  // Live editing location (carries current photo_offsets + legacy cover px).
  const editingLoc = editingId
    ? (locations.find((l) => l.id === editingId) ?? null)
    : null;

  return (
    <>
      {/* Overlay — hidden when panel is hidden (mobile click mode) */}
      <div
        onClick={
          clickMode
            ? undefined
            : () => {
                if (overlayGuardRef.current) return;
                onClose();
              }
        }
        style={{
          position: "fixed",
          inset: 0,
          background: clickMode ? "transparent" : "rgba(0,0,0,0.2)",
          zIndex: 40,
          pointerEvents: clickMode || photoUploading ? "none" : "auto",
          display: panelHidden ? "none" : undefined,
        }}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        style={{
          position: "fixed",
          right: 0,
          top: 0,
          bottom: 0,
          width: "380px",
          background: "#FAF6F0",
          borderLeft: "1px solid rgba(193,127,90,0.15)",
          overflowY: "auto",
          // Keep a scroll-to-the-edge inside the panel: no rubber-band chaining
          // out to the page (the section "moving around" while scrolling).
          overscrollBehavior: "contain",
          zIndex: 50,
          transform: visible ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.3s ease-out",
          display: panelHidden ? "none" : undefined,
        }}
        className="admin-panel"
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "20px 24px",
            borderBottom: "1px solid rgba(193,127,90,0.12)",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-cormorant), serif",
              fontSize: "20px",
              color: "#4A3728",
              margin: 0,
            }}
          >
            {editingId ? "Edit Place" : "Add a Place"}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "20px",
              color: "#9B8578",
              lineHeight: 1,
              padding: "4px",
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: "20px 24px" }}>
          {/* Search */}
          <div style={{ position: "relative", marginBottom: "12px" }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search restaurants, parks, places..."
              data-testid="admin-search"
              style={inputStyle}
            />
            {searching && (
              <span
                style={{
                  position: "absolute",
                  right: "12px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: "12px",
                  color: "#9B8578",
                }}
              >
                …
              </span>
            )}
          </div>

          {geocodeError && (
            <p
              style={{
                fontSize: "12px",
                color: "#9B8578",
                fontFamily: "var(--font-quicksand), sans-serif",
                marginBottom: "8px",
              }}
            >
              {geocodeError}
            </p>
          )}

          {/* Search results */}
          {searchResults.length > 0 && (
            <div
              style={{
                background: "#FAF6F0",
                border: "1px solid rgba(193,127,90,0.2)",
                borderRadius: "8px",
                marginBottom: "12px",
                overflow: "hidden",
              }}
            >
              {searchResults.map((feature, i) => (
                <div
                  key={feature.mapbox_id}
                  data-testid={`admin-suggestion-${i}`}
                  onClick={() => selectResult(feature)}
                  style={{
                    padding: "10px 14px",
                    cursor: "pointer",
                    borderBottom: "1px solid rgba(193,127,90,0.08)",
                    fontFamily: "var(--font-quicksand), sans-serif",
                    fontSize: "12px",
                    color: "#4A3728",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background =
                      "rgba(193,127,90,0.05)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background =
                      "transparent";
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{feature.name}</div>
                  <div
                    style={{
                      color: "#9B8578",
                      fontSize: "11px",
                      marginTop: "2px",
                    }}
                  >
                    {feature.place_formatted}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Click map toggle */}
          <button
            onClick={handleClickModeToggle}
            style={{
              width: "100%",
              padding: "8px",
              marginBottom: "20px",
              background: clickMode ? "rgba(193,127,90,0.12)" : "transparent",
              border: "1px solid rgba(193,127,90,0.3)",
              borderRadius: "8px",
              fontFamily: "var(--font-quicksand), sans-serif",
              fontSize: "11px",
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              color: "#C17F5A",
              cursor: "pointer",
              transition: "background 0.15s",
            }}
          >
            {clickMode
              ? "Click the map to drop a pin ✦"
              : "Click map to drop pin"}
          </button>

          {/* Form — shown when location selected */}
          {selectedLat !== null && selectedLng !== null && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                marginBottom: "28px",
              }}
            >
              {selectedName && (
                <p
                  style={{
                    fontSize: "11px",
                    color: "#9B8578",
                    fontFamily: "var(--font-quicksand), sans-serif",
                    margin: 0,
                  }}
                >
                  📍 {selectedName}
                </p>
              )}

              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Name this place"
                maxLength={200}
                required
                data-testid="admin-name"
                style={inputStyle}
              />
              <input
                type="date"
                value={dateLabel}
                onChange={(e) => setDateLabel(e.target.value)}
                required
                data-testid="admin-date"
                style={inputStyle}
              />

              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as CategoryKey)}
                style={inputStyle}
              >
                {(
                  Object.entries(CATEGORIES) as [
                    CategoryKey,
                    (typeof CATEGORIES)[CategoryKey],
                  ][]
                ).map(([key, cat]) => (
                  <option key={key} value={key}>
                    {cat.emoji} {cat.label}
                  </option>
                ))}
              </select>

              <div style={{ position: "relative" }}>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, 500))}
                  placeholder="What do you want to remember?"
                  rows={3}
                  style={{
                    ...inputStyle,
                    resize: "vertical",
                    minHeight: "80px",
                  }}
                />
                <span
                  style={{
                    position: "absolute",
                    bottom: "8px",
                    right: "10px",
                    fontSize: "10px",
                    color: description.length >= 450 ? "#C17F5A" : "#9B8578",
                    fontFamily: "var(--font-quicksand), sans-serif",
                  }}
                >
                  {description.length}/500
                </span>
              </div>

              {/* Photo section */}
              <div>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    // iOS ghost-click guard: when file picker closes, iOS fires a
                    // synthetic click ~100-300ms later that can hit the overlay.
                    // Block overlay for 600ms from the moment onChange fires.
                    if (overlayGuardTimerRef.current)
                      clearTimeout(overlayGuardTimerRef.current);
                    overlayGuardRef.current = true;
                    overlayGuardTimerRef.current = setTimeout(() => {
                      overlayGuardRef.current = false;
                      overlayGuardTimerRef.current = null;
                    }, 600);

                    const file = e.target.files?.[0];
                    if (!file) return;
                    e.target.value = "";
                    let compressed: File;
                    try {
                      compressed = await compressImage(file);
                    } catch (err) {
                      if ((err as Error).message === "HEIC_UNSUPPORTED") {
                        setPhotoError(
                          "Please take a screenshot of this photo or save it as JPEG first",
                        );
                        return;
                      }
                      compressed = file;
                    }
                    if (editingId) {
                      if (existingPhotos.length < 10) {
                        const localUrl = URL.createObjectURL(compressed);
                        setPendingPreviewUrl(localUrl);
                        await handlePhotoUpload(compressed, editingId);
                        URL.revokeObjectURL(localUrl);
                        setPendingPreviewUrl(null);
                      }
                    } else {
                      if (pendingPhotos.length >= 10) return;
                      setPendingPhotos((prev) => [...prev, compressed]);
                      setPendingPhotoUrls((prev) => [
                        ...prev,
                        URL.createObjectURL(compressed),
                      ]);
                    }
                  }}
                />

                {editingId ? (
                  /* Edit mode: tap a thumb to reframe, long-press to reorder */
                  <>
                    <PhotoEditGrid
                      photos={existingPhotos}
                      offsets={editingLoc?.photo_offsets ?? null}
                      coverUrl={existingPhotos[0] ?? null}
                      legacyCoverPx={
                        editingLoc
                          ? {
                              x: editingLoc.photo_offset_x ?? 0,
                              y: editingLoc.photo_offset_y ?? 0,
                            }
                          : null
                      }
                      uploading={photoUploading}
                      pendingPreviewUrl={pendingPreviewUrl}
                      canAddMore={existingPhotos.length < 10}
                      fallbackEmoji={CATEGORIES[category]?.emoji ?? "📍"}
                      fallbackBg={
                        CATEGORIES[category]?.bg ?? "rgba(193,127,90,0.12)"
                      }
                      onAdd={() => photoInputRef.current?.click()}
                      onRemove={(url) => handlePhotoRemoveByUrl(editingId, url)}
                      onReframe={(url) => setReframeUrl(url)}
                      onReorder={handleReorder}
                    />
                    {existingPhotos.length > 0 && (
                      <p
                        style={{
                          margin: "8px 0 0",
                          fontFamily: "var(--font-quicksand), sans-serif",
                          fontSize: "10px",
                          letterSpacing: "0.4px",
                          color: "#9B8578",
                        }}
                      >
                        Tap a photo to adjust its framing
                        {existingPhotos.length > 1
                          ? " · long-press to reorder"
                          : ""}
                      </p>
                    )}
                  </>
                ) : (
                  /* Multi-photo grid for create mode */
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      overflowX: "auto",
                      overscrollBehavior: "contain",
                      paddingBottom: "4px",
                    }}
                  >
                    {pendingPhotoUrls.map((url, index) => (
                      <div
                        key={index}
                        style={{ position: "relative", flexShrink: 0 }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={url}
                          alt=""
                          data-testid="pending-photo"
                          style={{
                            width: "60px",
                            height: "60px",
                            objectFit: "cover",
                            borderRadius: "8px",
                            display: "block",
                          }}
                        />
                        <button
                          onClick={() => {
                            setPendingPhotos((prev) =>
                              prev.filter((_, i) => i !== index),
                            );
                            setPendingPhotoUrls((prev) =>
                              prev.filter((_, i) => i !== index),
                            );
                          }}
                          title="Remove photo"
                          aria-label="Remove photo"
                          style={{
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
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {pendingPhotoUrls.length < 10 && (
                      <div
                        onClick={() => photoInputRef.current?.click()}
                        style={{
                          width:
                            pendingPhotoUrls.length === 0 ? "100%" : "60px",
                          height: "60px",
                          flexShrink: pendingPhotoUrls.length === 0 ? 1 : 0,
                          border: "1.5px dashed rgba(193,127,90,0.35)",
                          borderRadius: "8px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          color: "#C0A898",
                          fontFamily: "var(--font-quicksand), sans-serif",
                          fontSize:
                            pendingPhotoUrls.length === 0 ? "11px" : "20px",
                          transition: "border-color 0.15s",
                        }}
                        onMouseEnter={(e) => {
                          (
                            e.currentTarget as HTMLDivElement
                          ).style.borderColor = "rgba(193,127,90,0.6)";
                        }}
                        onMouseLeave={(e) => {
                          (
                            e.currentTarget as HTMLDivElement
                          ).style.borderColor = "rgba(193,127,90,0.35)";
                        }}
                      >
                        {pendingPhotoUrls.length === 0 ? "Add a photo" : "+"}
                      </div>
                    )}
                  </div>
                )}

                {photoError && (
                  <p
                    data-testid="photo-error"
                    style={{
                      fontSize: "11px",
                      color: "#e05c6b",
                      margin: "4px 0 0",
                      fontFamily: "var(--font-quicksand), sans-serif",
                    }}
                  >
                    {photoError}
                  </p>
                )}
              </div>

              {saveError && (
                <p
                  style={{
                    fontSize: "12px",
                    color: "#e05c6b",
                    fontFamily: "var(--font-quicksand), sans-serif",
                    margin: 0,
                  }}
                >
                  {saveError}
                </p>
              )}

              <button
                onClick={handleSave}
                disabled={!canSave || saveState !== "idle"}
                data-testid="admin-save"
                style={{
                  width: "100%",
                  padding: "12px",
                  background:
                    saveState === "success"
                      ? "rgba(80,140,80,0.85)"
                      : canSave
                        ? "#C17F5A"
                        : "rgba(193,127,90,0.3)",
                  color: "white",
                  border: "none",
                  borderRadius: "10px",
                  fontFamily: "var(--font-quicksand), sans-serif",
                  fontSize: "12px",
                  letterSpacing: "2px",
                  textTransform: "uppercase",
                  cursor:
                    canSave && saveState === "idle" ? "pointer" : "not-allowed",
                  transition: "background 0.2s",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  minHeight: "42px",
                }}
              >
                {saveState === "saving" ? (
                  <Spinner />
                ) : saveState === "success" ? (
                  <span style={{ fontSize: "18px", lineHeight: 1 }}>✓</span>
                ) : editingId ? (
                  "Update this place ✦"
                ) : (
                  "Save this place ✦"
                )}
              </button>

              {editingId && (
                <button
                  onClick={resetForm}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "var(--font-quicksand), sans-serif",
                    fontSize: "11px",
                    color: "#9B8578",
                    padding: "4px 0",
                    textAlign: "center",
                    width: "100%",
                  }}
                >
                  Cancel edit
                </button>
              )}
            </div>
          )}

          {/* Divider */}
          <hr
            style={{
              border: "none",
              borderTop: "1px solid rgba(193,127,90,0.15)",
              margin: "8px 0 20px",
            }}
          />

          {/* Manage existing locations */}
          <h3
            style={{
              fontFamily: "var(--font-cormorant), serif",
              fontSize: "16px",
              color: "#4A3728",
              margin: "0 0 12px",
            }}
          >
            Your Places
          </h3>

          {locations.length === 0 && (
            <p
              style={{
                fontSize: "12px",
                color: "#9B8578",
                fontFamily: "var(--font-quicksand), sans-serif",
              }}
            >
              No places saved yet.
            </p>
          )}

          {locations
            .filter((l) => l.id !== pendingDeleteId)
            .map((loc) => (
              <div
                key={loc.id}
                data-testid={`manage-row-${loc.id}`}
                style={{
                  padding: "12px 0",
                  borderBottom: `1px solid ${editingId === loc.id ? "rgba(193,127,90,0.3)" : "rgba(193,127,90,0.08)"}`,
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: "8px",
                  background:
                    editingId === loc.id
                      ? "rgba(193,127,90,0.04)"
                      : "transparent",
                  borderRadius: editingId === loc.id ? "6px" : undefined,
                  paddingLeft: editingId === loc.id ? "8px" : undefined,
                  paddingRight: editingId === loc.id ? "4px" : undefined,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p
                    style={{
                      fontFamily: "var(--font-quicksand), sans-serif",
                      fontSize: "12px",
                      fontWeight: 600,
                      color: "#4A3728",
                      margin: "0 0 2px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {loc.title}
                  </p>
                  <p
                    style={{
                      fontFamily: "var(--font-cormorant), serif",
                      fontStyle: "italic",
                      fontSize: "11px",
                      color: "#9B8578",
                      margin: 0,
                    }}
                  >
                    {loc.date_label}
                  </p>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: "2px",
                    alignItems: "center",
                    flexShrink: 0,
                  }}
                >
                  <button
                    onClick={() => startEdit(loc)}
                    title="Edit this place"
                    aria-label="Edit this place"
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: editingId === loc.id ? "#C17F5A" : "#C0A898",
                      padding: "2px 4px",
                      lineHeight: 1,
                      display: "flex",
                      alignItems: "center",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.color =
                        "#C17F5A";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.color =
                        editingId === loc.id ? "#C17F5A" : "#C0A898";
                    }}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    onClick={() => handleSoftDelete(loc)}
                    title="Remove this place"
                    aria-label="Remove this place"
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "#C0A898",
                      padding: "2px 4px",
                      lineHeight: 1,
                      display: "flex",
                      alignItems: "center",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.color =
                        "#e05c6b";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.color =
                        "#C0A898";
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            ))}
        </div>
      </div>

      {/* Mobile tap-to-drop-pin instruction pill */}
      {clickMode && (
        <div
          className="mobile-click-pill"
          style={{
            position: "fixed",
            top: "20px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(74,55,40,0.9)",
            color: "white",
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "11px",
            padding: "8px 20px",
            borderRadius: "100px",
            zIndex: 50,
            display: "none",
            alignItems: "center",
            gap: "8px",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "#C17F5A",
              flexShrink: 0,
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
          Tap anywhere on the map
        </div>
      )}

      {/* Save/update toast */}
      {toast && (
        <div
          onClick={
            toastHasAction ? () => toastActionRef.current?.() : undefined
          }
          style={{
            position: "fixed",
            bottom: "24px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#4A3728",
            color: "white",
            padding: "10px 24px",
            borderRadius: "100px",
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "12px",
            letterSpacing: "2px",
            zIndex: 60,
            animation: "fadeIn 0.3s ease-out",
            cursor: toastHasAction ? "pointer" : "default",
          }}
        >
          {toast}
        </div>
      )}

      {/* Delete undo toast */}
      {pendingDeleteId && (
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
              onClick={handleUndoDelete}
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
              key={pendingDeleteId}
              style={{
                height: "100%",
                background: "rgba(193,127,90,0.4)",
                animation: "deleteProgress 5s linear forwards",
              }}
            />
          </div>
        </div>
      )}

      {/* Reframe overlay — opened by tapping a thumbnail in the edit grid */}
      {reframeUrl && (
        <ReframeOverlay
          src={reframeUrl}
          initialOffset={offsetForPhoto(reframeUrl, editingLoc?.photo_offsets)}
          initialLegacyPx={
            editingLoc && existingPhotos[0] === reframeUrl
              ? {
                  x: editingLoc.photo_offset_x ?? 0,
                  y: editingLoc.photo_offset_y ?? 0,
                }
              : null
          }
          fallbackEmoji={CATEGORIES[category]?.emoji ?? "📍"}
          fallbackBg={CATEGORIES[category]?.bg ?? "rgba(193,127,90,0.12)"}
          previewAspect={reframeAspect}
          saving={reframeSaving}
          onSave={handleReframeSave}
          onClose={() => setReframeUrl(null)}
        />
      )}

      <style>{`
        @media (max-width: 767px) {
          .admin-panel {
            width: 100% !important;
          }
          .mobile-click-pill {
            display: flex !important;
          }
        }
        @keyframes deleteProgress {
          from { width: 100%; }
          to { width: 0%; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </>
  );
}

function createTempMarkerEl(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `
    width: 24px; height: 24px; border-radius: 50%;
    background: #FAF6F0; border: 2.5px dashed #C17F5A;
    pointer-events: none;
  `;
  return el;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontFamily: "var(--font-quicksand), sans-serif",
  fontSize: "13px",
  color: "#4A3728",
  background: "rgba(193,127,90,0.05)",
  border: "1px solid rgba(193,127,90,0.2)",
  borderRadius: "8px",
  outline: "none",
};

function Spinner() {
  return (
    <div
      style={{
        width: "14px",
        height: "14px",
        border: "2px solid rgba(255,255,255,0.4)",
        borderTopColor: "white",
        borderRadius: "50%",
        animation: "spin 0.6s linear infinite",
      }}
    />
  );
}
