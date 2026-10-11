import type { Location } from "@/types";

/**
 * Frontend-only API client. Routes EVERY data operation through `/api/*`
 * so the browser never holds a Supabase key with database access.
 *
 * Auth: relies on the httpOnly `app_session` cookie (set by /api/auth and
 * verified by proxy.ts middleware).
 *
 * CSRF: state-changing requests (POST/PATCH/DELETE) include the
 * X-CSRF-Token header read from the non-httpOnly `app_csrf` cookie
 * (double-submit cookie pattern). GET requests do not need it.
 */

const CSRF_COOKIE = "app_csrf";

// When a 401 surfaces from a BACKGROUND api-client call (the 30s poll, a card's
// photo fetch), the default response is a hard `window.location.reload()` to
// bounce the user to the login gate. That is destructive while the user is
// mid-edit in the admin panel: it discards the pending edit and races the save's
// own "Session expired" re-auth toast. AdminPanel sets this true while open, so a
// failed save surfaces gracefully (toast + preserved form) instead of reloading.
// Everywhere else the bounce-to-login behavior is unchanged.
let reauthReloadSuppressed = false;
export function setReauthReloadSuppressed(v: boolean): void {
  reauthReloadSuppressed = v;
}

function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]+)`),
  );
  return m ? m[1] : null;
}

class SessionExpiredError extends Error {
  constructor() {
    super("Session expired");
    this.name = "SessionExpiredError";
  }
}

class CsrfError extends Error {
  constructor() {
    super("Forbidden (CSRF or auth)");
    this.name = "CsrfError";
  }
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const method = (opts?.method ?? "GET").toUpperCase();
  const isStateChanging = method !== "GET" && method !== "HEAD";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((opts?.headers as Record<string, string>) ?? {}),
  };

  if (isStateChanging) {
    const csrf = getCsrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  const res = await fetch(path, {
    credentials: "include",
    ...opts,
    headers,
  });

  if (res.status === 401) {
    if (!reauthReloadSuppressed && typeof window !== "undefined")
      window.location.reload();
    throw new SessionExpiredError();
  }
  if (res.status === 403) throw new CsrfError();

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} failed: ${res.status} ${text}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface NewLocation {
  title: string;
  date_label: string;
  lat: number;
  lng: number;
  description?: string;
  category?: string;
}

export interface SignedUploadUrlResponse {
  signedUrl: string;
  token: string;
  path: string;
  // Second signed upload URL for this photo's thumbnail (`<path>.thumb`).
  // null when the storage thumb-URL mint failed — the client then skips the
  // thumbnail (the full image is the fallback everywhere).
  thumbSignedUrl?: string | null;
  thumbToken?: string | null;
  thumbPath?: string | null;
  // Third signed upload URL for this photo's card-tier image (`<path>.card`),
  // the ~1152px sharp derivative the map card renders. null when the mint
  // failed — the client skips it (the full image is the fallback).
  cardSignedUrl?: string | null;
  cardToken?: string | null;
  cardPath?: string | null;
}

export interface PhotoListResponse {
  photos: string[];
  // Per-photo thumbnail signed URLs, aligned to `photos` ("" = none yet).
  thumbs?: string[];
  // Per-photo card-tier signed URLs, aligned to `photos` ("" = none yet).
  cards?: string[];
}

export interface PhotoSaveResponse {
  photo_url: string | null;
  photos: string[];
  thumbs?: string[];
  cards?: string[];
}

export const api = {
  listLocations: () => apiFetch<Location[]>("/api/locations"),

  getLocation: (id: string) => apiFetch<Location>(`/api/locations/${id}`),

  createLocation: (data: NewLocation) =>
    apiFetch<Location>("/api/locations", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateLocation: (id: string, data: Partial<Location>) =>
    apiFetch<Location>(`/api/locations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteLocation: (id: string) =>
    apiFetch<void>(`/api/locations/${id}`, { method: "DELETE" }),

  // POST: returns a Supabase signed UPLOAD URL the browser then PUTs to directly.
  createPhotoUploadUrl: (id: string) =>
    apiFetch<SignedUploadUrlResponse>(`/api/locations/${id}/photo-url`, {
      method: "POST",
    }),

  // GET: list current signed READ URLs for a location's photos.
  listPhotos: (id: string) =>
    apiFetch<PhotoListResponse>(`/api/locations/${id}/photo`),

  // POST: register a path that was uploaded directly to Supabase Storage.
  registerUploadedPhoto: (id: string, path: string) =>
    apiFetch<PhotoSaveResponse>(`/api/locations/${id}/photo`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  // POST multipart: legacy upload path going through the server.
  uploadPhotoMultipart: async (
    id: string,
    file: Blob,
  ): Promise<PhotoSaveResponse> => {
    const form = new FormData();
    form.append("photo", file);
    const csrf = getCsrfToken();
    const res = await fetch(`/api/locations/${id}/photo`, {
      method: "POST",
      credentials: "include",
      headers: csrf ? { "X-CSRF-Token": csrf } : {},
      body: form,
    });
    if (res.status === 401) {
      if (!reauthReloadSuppressed && typeof window !== "undefined")
        window.location.reload();
      throw new SessionExpiredError();
    }
    if (res.status === 403) throw new CsrfError();
    if (!res.ok) throw new Error(`Photo upload failed: ${res.status}`);
    return res.json();
  },

  deletePhoto: (id: string, filename: string) =>
    apiFetch<PhotoSaveResponse>(
      `/api/locations/${id}/photo?filename=${encodeURIComponent(filename)}`,
      { method: "DELETE" },
    ),

  // PATCH: persist per-photo normalized framing (keyed by stable storage object
  // name; `x`/`y` fractions in [-1, 1], optional `scale` zoom in [1, 3]).
  // Returns the full row.
  setPhotoOffsets: (
    id: string,
    offsets: Record<string, { x: number; y: number; scale?: number }>,
  ) =>
    apiFetch<Location>(`/api/locations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ photo_offsets: offsets }),
    }),

  // PATCH: persist per-photo LQIP placeholders (base64 data URIs keyed by
  // stable storage object name). GATED — only called when NEXT_PUBLIC_LQIP_ENABLED
  // and the `photo_lqips` column exist. Returns the full row.
  setPhotoLqips: (id: string, lqips: Record<string, string>) =>
    apiFetch<Location>(`/api/locations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ photo_lqips: lqips }),
    }),

  // PATCH: reorder photos. `order` is the desired sequence of stable storage
  // object names (or signed URLs); the server re-signs and sets cover =
  // order[0]. Returns the full row with the new `photos` + `photo_url`.
  reorderPhotos: (id: string, order: string[]) =>
    apiFetch<Location>(`/api/locations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ photos: order }),
    }),
};
