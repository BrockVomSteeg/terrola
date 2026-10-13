import { test, expect } from "@playwright/test";
import type { Store, StoreResult } from "@/lib/demo/store";
import type { Location } from "@/types";

// The Store contract (SPEC R17, R4). Every store has to pass it: the in-memory demo
// store today, the live store once CI has a database. A spec file calls
// storeContract() once per store and mode.

export interface ContractSubject {
  /** A fresh store that holds exactly `seed`. */
  open: (seed: readonly Location[]) => Store | Promise<Store>;
  /** Whether this store accepts writes at all. */
  writable: boolean;
  /** Whether it can take new picture files. */
  uploads: boolean;
}

const uuid = (n: number): string =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const picture = (owner: string, n: number): string =>
  `/demo/location-photos/${owner}-${1700000000000 + n}.svg`;
const nameOf = (url: string): string => url.split("/").pop() ?? "";

export const A = uuid(1);
export const B = uuid(2);
export const C = uuid(3);
const UNKNOWN = uuid(99);
const A_PHOTOS = [picture(A, 1), picture(A, 2), picture(A, 3)];

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

const NEW_LOCATION = {
  title: "Fourth",
  date_label: "2025-02-01",
  description: "Added by the contract",
  category: "trip" as const,
  lat: 41.1,
  lng: -8.6,
};

function dataOf<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`expected data, got ${result.error.code}`);
  return result.data;
}

function codeOf<T>(result: StoreResult<T>): string {
  return result.ok ? "ok" : result.error.code;
}

/** Everything a reader can see, as one comparable value. */
async function snapshot(store: Store): Promise<string> {
  const locations = dataOf(await store.listLocations());
  const photos = [];
  for (const location of locations) {
    photos.push(dataOf(await store.listPhotos(location.id)));
  }
  return JSON.stringify({ locations, photos });
}

/** Every write the contract knows, against one id. */
function writes(store: Store, id: string): [string, () => Promise<StoreResult<unknown>>][] {
  return [
    ["createLocation", () => store.createLocation(NEW_LOCATION)],
    ["updateLocation", () => store.updateLocation(id, { title: "Changed" })],
    ["updateLocation photoOrder", () => store.updateLocation(id, { photoOrder: [] })],
    ["deleteLocation", () => store.deleteLocation(id)],
    ["createPhotoUpload", () => store.createPhotoUpload(id)],
    ["registerPhoto", () => store.registerPhoto(id, `${id}-1700000000009.jpg`)],
    ["deletePhoto", () => store.deletePhoto(id)],
    ["deletePhoto by name", () => store.deletePhoto(id, nameOf(A_PHOTOS[1]))],
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
      expect(listed[2].photos).toEqual(A_PHOTOS);
    });

    test("gets one location, and says not_found for an id it does not hold", async () => {
      const store = await open();
      expect(dataOf(await store.getLocation(B)).title).toBe("Second");
      for (const id of [UNKNOWN, "", "not-an-id", "../etc", A.toUpperCase() + "x"]) {
        expect(codeOf(await store.getLocation(id)), id).toBe("not_found");
        expect(codeOf(await store.listPhotos(id)), id).toBe("not_found");
      }
    });

    test("lists photos with one thumb and one card entry per photo", async () => {
      const store = await open();
      const set = dataOf(await store.listPhotos(A));
      expect(set.photos).toEqual(A_PHOTOS);
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
      listed.pop();
      const one = dataOf(await store.getLocation(A));
      one.title = "scribbled";
      one.photos?.push("scribbled");
      const set = dataOf(await store.listPhotos(A));
      set.photos.length = 0;
      expect(await snapshot(store)).toBe(before);
    });

    if (!subject.writable) {
      test("refuses every write with read_only, for known and unknown ids alike", async () => {
        const store = await open();
        const before = await snapshot(store);
        for (const id of [A, B, UNKNOWN, ""]) {
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
      expect(dataOf(await store.getLocation(created.id))).toEqual(created);
    });

    test("updates only the fields it is given", async () => {
      const store = await open();
      const before = dataOf(await store.getLocation(B));
      const updated = dataOf(
        await store.updateLocation(B, {
          title: "Second, renamed",
          lat: 40.5,
          photo_offsets: { "x.jpg": { x: 0.25, y: -0.5 } },
        }),
      );
      expect(updated).toEqual({
        ...before,
        title: "Second, renamed",
        lat: 40.5,
        photo_offsets: { "x.jpg": { x: 0.25, y: -0.5 } },
      });
      expect(dataOf(await store.getLocation(B))).toEqual(updated);
      // Nobody else moved.
      expect(dataOf(await store.getLocation(A)).title).toBe("First");
      expect(codeOf(await store.updateLocation(UNKNOWN, { title: "x" }))).toBe("not_found");
    });

    test("reorders photos without ever dropping one, and the cover follows", async () => {
      const store = await open();
      const [first, second, third] = A_PHOTOS;
      const reordered = dataOf(
        await store.updateLocation(A, { photoOrder: [nameOf(third), nameOf(first)] }),
      );
      expect(reordered.photos).toEqual([third, first, second]);
      expect(reordered.photo_url).toBe(third);

      // Names that are unknown, repeated or missing change nothing but the order.
      const again = dataOf(
        await store.updateLocation(A, {
          photoOrder: ["not-a-photo.jpg", nameOf(second), nameOf(second)],
        }),
      );
      expect(again.photos).toEqual([second, third, first]);
      const none = dataOf(await store.updateLocation(A, { photoOrder: [] }));
      expect(none.photos).toEqual([second, third, first]);
    });

    test("deletes one photo by name, the cover by default, and keeps the lists in step", async () => {
      const store = await open();
      const [first, second, third] = A_PHOTOS;
      const afterNamed = dataOf(await store.deletePhoto(A, nameOf(second)));
      expect(afterNamed.photos).toEqual([first, third]);
      expect(afterNamed.photo_url).toBe(first);
      expect(afterNamed.thumbs).toHaveLength(2);
      expect(afterNamed.cards).toHaveLength(2);

      const afterCover = dataOf(await store.deletePhoto(A));
      expect(afterCover.photos).toEqual([third]);
      expect(afterCover.photo_url).toBe(third);

      // A name that is not there removes nothing.
      expect(dataOf(await store.deletePhoto(A, "not-a-photo.jpg")).photos).toEqual([third]);

      const empty = dataOf(await store.deletePhoto(A));
      expect(empty).toEqual({ photos: [], thumbs: [], cards: [], photo_url: null });
      expect(dataOf(await store.getLocation(A)).photos).toEqual([]);
      expect(codeOf(await store.deletePhoto(UNKNOWN))).toBe("not_found");
    });

    test("deletes a location once", async () => {
      const store = await open();
      expect(await store.deleteLocation(B)).toEqual({ ok: true, data: { id: B } });
      expect(codeOf(await store.getLocation(B))).toBe("not_found");
      expect(codeOf(await store.deleteLocation(B))).toBe("not_found");
      expect(dataOf(await store.listLocations()).map((l) => l.id)).toEqual([C, A]);
    });

    if (!subject.uploads) {
      test("says unsupported for a new picture, and not_found before that", async () => {
        const store = await open();
        const before = await snapshot(store);
        expect(codeOf(await store.createPhotoUpload(A))).toBe("unsupported");
        expect(codeOf(await store.registerPhoto(A, `${A}-1700000000009.jpg`))).toBe(
          "unsupported",
        );
        expect(codeOf(await store.createPhotoUpload(UNKNOWN))).toBe("not_found");
        expect(codeOf(await store.registerPhoto(UNKNOWN, "x.jpg"))).toBe("not_found");
        expect(await snapshot(store)).toBe(before);
      });
    }
  });
}
