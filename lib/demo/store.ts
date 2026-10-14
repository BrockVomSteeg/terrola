// The data layer contract (SPEC R17): every read and write of locations and photos
// goes through a Store. The demo gets the in-memory store (lib/demo/memory-store.ts);
// live mode gets the Supabase store, which checks the session itself. One contract
// suite runs against both (tests/unit/access/store-contract.ts).
//
// A Store method never throws. It answers with a result, so a refused write is a
// value the route maps to a status, not an exception that could leak or be missed.
//
// What a store may assume: the route has checked the shape of every id (a UUID) and of
// every field before it calls. What a store does not offer: a method that takes file
// bytes. The browser sends a picture straight to storage (createPhotoUpload, then
// registerPhoto); the older upload through the server is not part of the contract.
//
// Types and two tiny helpers: importing this file runs nothing.
import type { CategoryKey, Location } from "@/types";

/**
 *   not_found     no such location
 *   read_only     the public demo refuses every write (SPEC R4)
 *   unauthorized  the caller did not prove a session or the cron secret
 *   unsupported   this store cannot do it (the demo has no file storage)
 *   failed        the database or the storage failed; the reason is never passed on
 */
export type StoreErrorCode =
  | "not_found"
  | "read_only"
  | "unauthorized"
  | "unsupported"
  | "failed";

export type StoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: StoreErrorCode } };

/** A new location. The route has validated and trimmed every field. */
export interface NewLocation {
  title: string;
  date_label: string;
  description: string;
  category: CategoryKey;
  lat: number;
  lng: number;
}

/** The fields a location update may carry. The route has validated each one. */
export interface LocationPatch {
  title?: string;
  date_label?: string;
  description?: string;
  category?: CategoryKey;
  lat?: number;
  lng?: number;
  photo_offset_x?: number;
  photo_offset_y?: number;
  photo_offsets?: Location["photo_offsets"];
  photo_lqips?: Location["photo_lqips"];
  /**
   * A new photo order, as stored file names; never empty. The route has checked that
   * each name belongs to this location. The named photos come first, in this order.
   * A photo that is not named follows them: leaving a name out never removes a photo.
   * A name the store does not hold is ignored.
   */
  photoOrder?: string[];
}

/** A location's photos. `thumbs[i]` and `cards[i]` belong to `photos[i]`; "" means none. */
export interface PhotoSet {
  photos: string[];
  thumbs: string[];
  cards: string[];
}

/** The photos after a change, with the new cover. */
export interface PhotoChange extends PhotoSet {
  photo_url: string | null;
}

/** Where the browser may put one new photo and its two smaller copies. */
export interface PhotoUpload {
  signedUrl: string;
  token: string;
  path: string;
  thumbSignedUrl: string | null;
  thumbToken: string | null;
  thumbPath: string | null;
  cardSignedUrl: string | null;
  cardToken: string | null;
  cardPath: string | null;
}

export interface Store {
  /** Every location, newest first. */
  listLocations(): Promise<StoreResult<Location[]>>;
  getLocation(id: string): Promise<StoreResult<Location>>;
  createLocation(input: NewLocation): Promise<StoreResult<Location>>;
  updateLocation(id: string, patch: LocationPatch): Promise<StoreResult<Location>>;
  /** Removes the location and its photos. */
  deleteLocation(id: string): Promise<StoreResult<{ id: string }>>;
  // The four photo methods answer `not_found` when the store can tell that the
  // location is missing. The memory store always can.
  listPhotos(id: string): Promise<StoreResult<PhotoSet>>;
  createPhotoUpload(id: string): Promise<StoreResult<PhotoUpload>>;
  /** Adds an uploaded file (by its storage path) to the location's photos. */
  registerPhoto(id: string, path: string): Promise<StoreResult<PhotoChange>>;
  /**
   * Removes one photo by file name, or the cover when no name is given. "No name" is
   * `undefined`: an empty string is a name that matches nothing.
   */
  deletePhoto(id: string, filename?: string): Promise<StoreResult<PhotoChange>>;
  /** Touches the data source and reports only whether that worked. */
  ping(): Promise<StoreResult<null>>;
}

/** What a caller shows the gate. In live mode the store checks it; a demo ignores it. */
export type Credential =
  | { kind: "session"; token: string | undefined | null }
  | { kind: "cron"; authorization: string | null };

export const ok = <T>(data: T): StoreResult<T> => ({ ok: true, data });

export const refused = <T = never>(code: StoreErrorCode): StoreResult<T> => ({
  ok: false,
  error: { code },
});
