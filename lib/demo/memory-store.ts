// The demo's store: the fixtures held in memory. It never opens a network connection
// and never imports the Supabase client, so a demo cannot reach real data even by
// mistake (SPEC R3, R17).
//
//   read only  every write answers `read_only`, as a result and never as a thrown
//              error (SPEC R4). The public demo runs this way.
//   writable   writes change the copy in memory, for the dev server and tests. They
//              last as long as the server instance.
//
// A read never changes anything, and every answer is a copy: a caller that edits
// what it was given does not edit the store.
import { photoFilename } from "@/lib/photos";
import type { Location } from "@/types";
import { DEMO_LOCATIONS } from "./fixtures";
import {
  ok,
  refused,
  type LocationPatch,
  type NewLocation,
  type PhotoChange,
  type PhotoSet,
  type PhotoUpload,
  type Store,
  type StoreResult,
} from "./store";

export interface MemoryStoreOptions {
  readOnly: boolean;
  /** The starting data. Copied, never changed. */
  seed?: readonly Location[];
  now?: () => number;
  newId?: () => string;
}

const copy = <T>(value: T): T => structuredClone(value);

// The patch fields that are written to the row as they are.
const PLAIN_FIELDS = [
  "title",
  "date_label",
  "description",
  "category",
  "lat",
  "lng",
  "photo_offset_x",
  "photo_offset_y",
  "photo_offsets",
  "photo_lqips",
] as const;

function photoSet(location: Location): PhotoSet {
  const photos = [...(location.photos ?? [])];
  // The demo has no smaller copies. "" tells the page to show the full picture.
  return { photos, thumbs: photos.map(() => ""), cards: photos.map(() => "") };
}

function photoChange(location: Location): PhotoChange {
  return { ...photoSet(location), photo_url: location.photo_url ?? null };
}

function setPhotos(location: Location, photos: string[]): void {
  location.photos = photos;
  if (photos.length > 0) location.photo_url = photos[0];
  else delete location.photo_url;
}

export function createMemoryStore(options: MemoryStoreOptions): Store {
  const { readOnly } = options;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const rows = new Map<string, Location>(
    (options.seed ?? DEMO_LOCATIONS).map(
      (location) => [location.id, copy(location)] as const,
    ),
  );

  /** Runs a write, or refuses it. Nothing in `change` runs in a read only store. */
  async function write<T>(change: () => StoreResult<T>): Promise<StoreResult<T>> {
    if (readOnly) return refused("read_only");
    return change();
  }

  return {
    async listLocations() {
      const all = [...rows.values()].sort(
        (a, b) =>
          b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id),
      );
      return ok(copy(all));
    },

    async getLocation(id) {
      const found = rows.get(id);
      return found ? ok(copy(found)) : refused("not_found");
    },

    createLocation(input: NewLocation) {
      return write<Location>(() => {
        const created: Location = {
          id: newId(),
          title: input.title,
          date_label: input.date_label,
          description: input.description,
          category: input.category,
          lat: input.lat,
          lng: input.lng,
          display_order: 0,
          created_at: new Date(now()).toISOString(),
          photos: [],
        };
        rows.set(created.id, created);
        return ok(copy(created));
      });
    },

    updateLocation(id: string, patch: LocationPatch) {
      return write<Location>(() => {
        const found = rows.get(id);
        if (!found) return refused("not_found");
        const next: Location = copy(found);
        for (const field of PLAIN_FIELDS) {
          const value = patch[field];
          Object.assign(next, { [field]: copy(value) });
        }
        if (patch.photoOrder) {
          const current = next.photos ?? [];
          const named = patch.photoOrder
            .map((name) => current.find((photo) => photoFilename(photo) === name))
            .filter((photo): photo is string => photo !== undefined);
          const first = [...new Set(named)];
          const rest = current.filter((photo) => !first.includes(photo));
          setPhotos(next, [...first, ...rest]);
        }
        rows.set(id, next);
        return ok(copy(next));
      });
    },

    deleteLocation(id: string) {
      return write<{ id: string }>(() =>
        rows.delete(id) ? ok({ id }) : refused("not_found"),
      );
    },

    async listPhotos(id) {
      const found = rows.get(id);
      return found ? ok(photoSet(found)) : refused("not_found");
    },

    // The demo has no file storage, so there is nowhere to put a new picture.
    createPhotoUpload(id: string) {
      return write<PhotoUpload>(() =>
        rows.has(id) ? refused("unsupported") : refused("not_found"),
      );
    },

    registerPhoto(id: string) {
      return write<PhotoChange>(() =>
        rows.has(id) ? refused("unsupported") : refused("not_found"),
      );
    },

    deletePhoto(id: string, filename?: string) {
      return write<PhotoChange>(() => {
        const found = rows.get(id);
        if (!found) return refused("not_found");
        const next: Location = copy(found);
        const current = next.photos ?? [];
        const target =
          filename === undefined
            ? current[0]
            : current.find((photo) => photoFilename(photo) === filename);
        if (target !== undefined) {
          setPhotos(
            next,
            current.filter((photo) => photo !== target),
          );
          rows.set(id, next);
        }
        return ok(photoChange(next));
      });
    },

    async ping() {
      return ok(null);
    },
  };
}

// One store per mode and server instance, so what a writable demo saves is still
// there on the next request.
const shared: { "demo-readonly"?: Store; "demo-writable"?: Store } = {};

export function demoStore(mode: "demo-readonly" | "demo-writable"): Store {
  return (shared[mode] ??= createMemoryStore({ readOnly: mode === "demo-readonly" }));
}
