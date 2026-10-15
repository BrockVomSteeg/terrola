import { test, expect } from "@playwright/test";
import { cardName, thumbName } from "@/lib/photos";
import type { PhotoUpload, Store, StoreResult } from "@/lib/demo/store";
import type { Location } from "@/types";

// The Store contract (SPEC R17, R4): what EVERY store has to keep, the in-memory demo
// store today and the live store once CI has a database. A spec file calls
// storeContract() once per store and mode.
//
// Only what both can keep is pinned here. Ids are well formed UUIDs (the route checks
// the shape before it calls a store). Photos are compared by file name, because a live
// store hands out signed addresses. Where a photo was not named in a reorder, only its
// presence is pinned, not its place. What is particular to one store is tested in that
// store's own spec file.

export interface ContractSubject {
  /** A fresh store that holds exactly `seed`. */
  open: (seed: readonly Location[]) => Store | Promise<Store>;
  /** Whether this store accepts writes at all. */
  writable: boolean;
  /** Whether it can take new picture files. */
  uploads: boolean;
  /**
   * Puts a small picture where `upload` points, as the browser does. Needed when
   * `uploads` is true: the store hands out the place, it never takes the bytes.
   */
  put?: (upload: PhotoUpload) => Promise<void>;
}

const uuid = (n: number): string =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const picture = (owner: string, n: number): string =>
  `/demo/location-photos/${owner}-${1700000000000 + n}.jpg`;

/** The stored file name behind a photo address: no folder, no query string. */
export const nameOf = (address: string): string =>
  (address.split("?")[0].split("/").pop() ?? "").trim();
const namesOf = (addresses: readonly string[] | undefined): string[] =>
  (addresses ?? []).map(nameOf);

export const A = uuid(1);
export const B = uuid(2);
export const C = uuid(3);
export const UNKNOWN = uuid(99);
export const A_PHOTOS = [picture(A, 1), picture(A, 2), picture(A, 3)];
const [FIRST, SECOND, THIRD] = A_PHOTOS.map(nameOf);
// Shaped like a photo of A, held by no store.
const NOT_STORED = `${A}-1700000000099.jpg`;

/** Three locations: A is the oldest and has three pictures, C is the newest. */
export function contractSeed(): Location[] {
  const row = (id: string, title: string, day: number, photos: string[]): Location => ({
    id,
    title,
    date_label: `2025-01-0${day}`,
    description: `About ${title}`,
    category: "everyday",
    lat: 38.7 + day / 100,
    lng: -9.1,
    display_order: 0,
    created_at: `2025-01-0${day}T12:00:00.000Z`,
    photos,
    ...(photos.length > 0 ? { photo_url: photos[0] } : {}),
  });
  return [row(A, "First", 1, [...A_PHOTOS]), row(B, "Second", 2, []), row(C, "Third", 3, [])];
}

export const NEW_LOCATION = {
  title: "Fourth",
  date_label: "2025-02-01",
  description: "Added by the contract",
  category: "trip" as const,
  lat: 41.1,
  lng: -8.6,
};

export function dataOf<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`expected data, got ${result.error.code}`);
  return result.data;
}

export function codeOf<T>(result: StoreResult<T>): string {
  return result.ok ? "ok" : result.error.code;
}

/** Everything a reader can see, as one comparable value. */
export async function snapshot(store: Store): Promise<string> {
  const locations = dataOf(await store.listLocations());
  const photos = [];
  for (const location of locations) {
    photos.push(dataOf(await store.listPhotos(location.id)));
  }
  return JSON.stringify({ locations, photos });
}

/** Every write the contract knows, against one id. */
export function writes(
  store: Store,
  id: string,
): [string, () => Promise<StoreResult<unknown>>][] {
  return [
    ["createLocation", () => store.createLocation(NEW_LOCATION)],
    ["updateLocation", () => store.updateLocation(id, { title: "Changed" })],
    ["updateLocation photoOrder", () => store.updateLocation(id, { photoOrder: [SECOND] })],
    ["deleteLocation", () => store.deleteLocation(id)],
    ["createPhotoUpload", () => store.createPhotoUpload(id)],
    ["registerPhoto", () => store.registerPhoto(id, `${id}-1700000000009.jpg`)],
    ["deletePhoto", () => store.deletePhoto(id)],
    ["deletePhoto by name", () => store.deletePhoto(id, SECOND)],
  ];
}

export function storeContract(name: string, subject: ContractSubject): void {
  const open = async () => subject.open(contractSeed());

  test.describe(`store contract: ${name}`, () => {
    test("lists every location, newest first", async () => {
      const store = await open();
      const listed = dataOf(await store.listLocations());
      expect(listed.map((location) => location.id)).toEqual([C, B, A]);
      expect(listed[2].title).toBe("First");
      expect(namesOf(listed[2].photos)).toEqual([FIRST, SECOND, THIRD]);
    });

    test("gets one location, and says not_found for an id it does not hold", async () => {
      const store = await open();
      expect(dataOf(await store.getLocation(B)).title).toBe("Second");
      expect(codeOf(await store.getLocation(UNKNOWN))).toBe("not_found");
    });

    test("lists photos with one thumb and one card entry per photo", async () => {
      const store = await open();
      const set = dataOf(await store.listPhotos(A));
      expect(namesOf(set.photos)).toEqual([FIRST, SECOND, THIRD]);
      expect(set.thumbs).toHaveLength(set.photos.length);
      expect(set.cards).toHaveLength(set.photos.length);
      expect(dataOf(await store.listPhotos(B))).toEqual({ photos: [], thumbs: [], cards: [] });
    });

    test("answers a ping", async () => {
      const store = await open();
      expect(await store.ping()).toEqual({ ok: true, data: null });
    });

    test("a read changes nothing, and what it hands out is a copy", async () => {
      const store = await open();
      const before = await snapshot(store);
      for (let round = 0; round < 3; round++) {
        await store.listLocations();
        await store.getLocation(A);
        await store.getLocation(UNKNOWN);
        await store.listPhotos(A);
        await store.ping();
      }
      expect(await snapshot(store)).toBe(before);

      // Scribble on everything a read returned.
      const listed = dataOf(await store.listLocations());
      listed[0].title = "scribbled";
      listed[2].photos?.reverse();
      const one = dataOf(await store.getLocation(A));
      one.title = "scribbled";
      one.photos?.push("scribbled");
      const set = dataOf(await store.listPhotos(A));
      set.photos.length = 0;
      set.thumbs.push("scribbled");
      expect(await snapshot(store)).toBe(before);
    });

    if (!subject.writable) {
      test("refuses every write with read_only, for known and unknown ids alike", async () => {
        const store = await open();
        const before = await snapshot(store);
        for (const id of [A, B, UNKNOWN]) {
          for (const [label, run] of writes(store, id)) {
            // A result, never a thrown error (SPEC R4).
            const result = await run();
            expect(result, `${label} ${id}`).toEqual({
              ok: false,
              error: { code: "read_only" },
            });
          }
        }
        expect(await snapshot(store)).toBe(before);
      });
      return;
    }

    test("creates a location that is then listed first", async () => {
      const store = await open();
      const created = dataOf(await store.createLocation(NEW_LOCATION));
      expect(created).toMatchObject({ ...NEW_LOCATION, display_order: 0 });
      expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(Number.isNaN(Date.parse(created.created_at))).toBe(false);
      expect([A, B, C]).not.toContain(created.id);

      const listed = dataOf(await store.listLocations());
      expect(listed).toHaveLength(4);
      expect(listed[0].id).toBe(created.id);
      const stored = dataOf(await store.getLocation(created.id));
      expect(stored).toEqual(created);

      // What a write hands back is a copy too.
      created.title = "scribbled";
      expect(dataOf(await store.getLocation(created.id))).toEqual(stored);
    });

    test("updates only the fields it is given", async () => {
      const store = await open();
      const before = dataOf(await store.getLocation(B));
      const offsets = { "x.jpg": { x: 0.25, y: -0.5 } };
      const updated = dataOf(
        await store.updateLocation(B, {
          title: "Second, renamed",
          lat: 40.5,
          photo_offsets: offsets,
        }),
      );
      const want = {
        ...before,
        title: "Second, renamed",
        lat: 40.5,
        photo_offsets: { "x.jpg": { x: 0.25, y: -0.5 } },
      };
      expect(updated).toEqual(want);
      expect(dataOf(await store.getLocation(B))).toEqual(want);
      // Nobody else moved.
      expect(dataOf(await store.getLocation(A)).title).toBe("First");
      expect(codeOf(await store.updateLocation(UNKNOWN, { title: "x" }))).toBe("not_found");

      // Neither what went in nor what came out is the stored value.
      offsets["x.jpg"].x = 1;
      updated.title = "scribbled";
      if (updated.photo_offsets) updated.photo_offsets["x.jpg"].y = 1;
      expect(dataOf(await store.getLocation(B))).toEqual(want);
    });

    test("puts the named photos first, keeps the others, and the cover follows", async () => {
      const store = await open();
      const reordered = dataOf(await store.updateLocation(A, { photoOrder: [THIRD, FIRST] }));
      const names = namesOf(reordered.photos);
      expect(names.slice(0, 2)).toEqual([THIRD, FIRST]);
      expect([...names].sort()).toEqual([FIRST, SECOND, THIRD].sort());
      expect(nameOf(reordered.photo_url ?? "")).toBe(THIRD);

      // A name the store does not hold changes nothing but the order.
      const again = dataOf(
        await store.updateLocation(A, { photoOrder: [NOT_STORED, SECOND] }),
      );
      const namesAgain = namesOf(again.photos);
      expect(namesAgain[0]).toBe(SECOND);
      expect([...namesAgain].sort()).toEqual([FIRST, SECOND, THIRD].sort());
      expect(namesOf(dataOf(await store.listPhotos(A)).photos)).toEqual(namesAgain);
    });

    test("deletes one photo by name, the cover by default, and keeps the lists in step", async () => {
      const store = await open();
      const afterNamed = dataOf(await store.deletePhoto(A, SECOND));
      expect(namesOf(afterNamed.photos)).toEqual([FIRST, THIRD]);
      expect(nameOf(afterNamed.photo_url ?? "")).toBe(FIRST);
      expect(afterNamed.thumbs).toHaveLength(2);
      expect(afterNamed.cards).toHaveLength(2);

      const afterCover = dataOf(await store.deletePhoto(A));
      expect(namesOf(afterCover.photos)).toEqual([THIRD]);
      expect(nameOf(afterCover.photo_url ?? "")).toBe(THIRD);

      // A name that is not there removes nothing.
      expect(namesOf(dataOf(await store.deletePhoto(A, NOT_STORED)).photos)).toEqual([THIRD]);

      const empty = dataOf(await store.deletePhoto(A));
      expect(empty).toEqual({ photos: [], thumbs: [], cards: [], photo_url: null });
      expect(dataOf(await store.getLocation(A)).photos ?? []).toEqual([]);
    });

    test("deletes a location once", async () => {
      const store = await open();
      expect(await store.deleteLocation(B)).toEqual({ ok: true, data: { id: B } });
      expect(codeOf(await store.getLocation(B))).toBe("not_found");
      expect(codeOf(await store.deleteLocation(B))).toBe("not_found");
      expect(dataOf(await store.listLocations()).map((l) => l.id)).toEqual([C, A]);
    });

    // A store with file storage. These cases are always declared, so a store
    // without uploads shows them as skipped, with the reason, and never as passed.
    test.describe("with uploads", () => {
      const SKIP = "this store has no file storage; a run with uploads: true runs these";

      /** An upload place for `id`, with the picture put there. */
      async function uploaded(store: Store, id: string): Promise<PhotoUpload> {
        if (!subject.put) throw new Error("uploads: true needs a put function");
        const upload = dataOf(await store.createPhotoUpload(id));
        await subject.put(upload);
        return upload;
      }

      test("hands out an upload place in the location's namespace, and stores nothing yet", async () => {
        test.skip(!subject.uploads, SKIP);
        const store = await open();
        const before = await snapshot(store);
        const upload = dataOf(await store.createPhotoUpload(B));
        const name = nameOf(upload.path);
        expect(name.startsWith(`${B}-`)).toBe(true);
        expect(upload.signedUrl).not.toBe("");
        expect(upload.token).not.toBe("");
        // A smaller copy is optional; when there is one, it sits next to the photo.
        if (upload.thumbPath !== null) expect(nameOf(upload.thumbPath)).toBe(thumbName(name));
        if (upload.cardPath !== null) expect(nameOf(upload.cardPath)).toBe(cardName(name));
        // Two places for the same location never share a name.
        const second = dataOf(await store.createPhotoUpload(B));
        expect(nameOf(second.path)).not.toBe(name);
        expect(await snapshot(store)).toBe(before);
      });

      test("registers an uploaded picture as the cover of a location with none", async () => {
        test.skip(!subject.uploads, SKIP);
        const store = await open();
        const upload = await uploaded(store, B);
        const name = nameOf(upload.path);

        const change = dataOf(await store.registerPhoto(B, upload.path));
        expect(namesOf(change.photos)).toEqual([name]);
        expect(nameOf(change.photo_url ?? "")).toBe(name);
        expect(change.thumbs).toHaveLength(1);
        expect(change.cards).toHaveLength(1);

        expect(namesOf(dataOf(await store.listPhotos(B)).photos)).toEqual([name]);
        expect(namesOf(dataOf(await store.getLocation(B)).photos)).toEqual([name]);
        // Nobody else moved.
        expect(namesOf(dataOf(await store.listPhotos(A)).photos)).toEqual([FIRST, SECOND, THIRD]);
      });

      test("adds an uploaded picture after the others, and keeps the cover", async () => {
        test.skip(!subject.uploads, SKIP);
        const store = await open();
        const upload = await uploaded(store, A);
        const change = dataOf(await store.registerPhoto(A, upload.path));
        expect(namesOf(change.photos)).toEqual([FIRST, SECOND, THIRD, nameOf(upload.path)]);
        expect(nameOf(change.photo_url ?? "")).toBe(FIRST);
      });

      test("removes a registered picture by name", async () => {
        test.skip(!subject.uploads, SKIP);
        const store = await open();
        const upload = await uploaded(store, B);
        dataOf(await store.registerPhoto(B, upload.path));
        const gone = dataOf(await store.deletePhoto(B, nameOf(upload.path)));
        expect(gone).toEqual({ photos: [], thumbs: [], cards: [], photo_url: null });
        expect(dataOf(await store.listPhotos(B))).toEqual({ photos: [], thumbs: [], cards: [] });
      });
    });

    if (!subject.uploads) {
      test("says unsupported for a new picture and stores nothing", async () => {
        const store = await open();
        const before = await snapshot(store);
        expect(codeOf(await store.createPhotoUpload(A))).toBe("unsupported");
        expect(codeOf(await store.registerPhoto(A, `${A}-1700000000009.jpg`))).toBe(
          "unsupported",
        );
        expect(await snapshot(store)).toBe(before);
      });
    }
  });
}
