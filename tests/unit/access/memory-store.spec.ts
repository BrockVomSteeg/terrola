import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { DEMO_LOCATIONS } from "@/lib/demo/fixtures";
import { createMemoryStore, demoStore } from "@/lib/demo/memory-store";
import type { CategoryKey } from "@/types";
import { A, contractSeed, storeContract } from "./store-contract";

// The demo's store (SPEC R3, R4, R17): the contract in both modes, then what is
// particular to a store that lives in memory, then the made up data itself.

storeContract("memory, writable", {
  open: (seed) => createMemoryStore({ readOnly: false, seed }),
  writable: true,
  uploads: false,
});

storeContract("memory, read only", {
  open: (seed) => createMemoryStore({ readOnly: true, seed }),
  writable: false,
  uploads: false,
});

test.describe("the memory store", () => {
  test("copies its seed: later changes to the seed, or to the store, do not cross over", async () => {
    const seed = contractSeed();
    const store = createMemoryStore({ readOnly: false, seed });
    seed[0].title = "changed after the store was made";
    seed.pop();
    const first = await store.getLocation(A);
    expect(first.ok && first.data.title).toBe("First");
    const listed = await store.listLocations();
    expect(listed.ok && listed.data).toHaveLength(3);

    await store.updateLocation(A, { title: "changed in the store" });
    expect(seed[0].title).toBe("changed after the store was made");
  });

  test("two stores never share data", async () => {
    const one = createMemoryStore({ readOnly: false });
    const two = createMemoryStore({ readOnly: false });
    const id = DEMO_LOCATIONS[0].id;
    await one.deleteLocation(id);
    expect((await one.getLocation(id)).ok).toBe(false);
    expect((await two.getLocation(id)).ok).toBe(true);
    // And the fixtures themselves are untouched.
    expect(DEMO_LOCATIONS[0].id).toBe(id);
    expect(DEMO_LOCATIONS).toHaveLength(12);
  });

  test("uses the clock and the id maker it is given", async () => {
    const store = createMemoryStore({
      readOnly: false,
      seed: [],
      now: () => Date.UTC(2030, 0, 2, 3, 4, 5),
      newId: () => "20000000-0000-4000-8000-000000000001",
    });
    const created = await store.createLocation({
      title: "t",
      date_label: "2030-01-02",
      description: "",
      category: "food",
      lat: 39,
      lng: -8,
    });
    expect(created.ok && created.data.id).toBe("20000000-0000-4000-8000-000000000001");
    expect(created.ok && created.data.created_at).toBe("2030-01-02T03:04:05.000Z");
  });

  test("makes no network call, whatever is asked of it", async () => {
    const real = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(args[0]);
      throw new Error("the memory store must not use the network");
    }) as typeof fetch;
    try {
      for (const readOnly of [true, false]) {
        const store = createMemoryStore({ readOnly });
        const id = DEMO_LOCATIONS[0].id;
        await store.listLocations();
        await store.getLocation(id);
        await store.listPhotos(id);
        await store.ping();
        await store.createLocation({
          title: "t",
          date_label: "2025-01-01",
          description: "",
          category: "food",
          lat: 39,
          lng: -8,
        });
        await store.updateLocation(id, { title: "t", photoOrder: [] });
        await store.createPhotoUpload(id);
        await store.registerPhoto(id, "x.jpg");
        await store.deletePhoto(id);
        await store.deleteLocation(id);
      }
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toEqual([]);
  });

  test("its source reaches for no database client, no network and no environment", () => {
    const dir = path.join(process.cwd(), "lib", "demo");
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".ts"));
    expect(files.sort()).toEqual(["fixtures.ts", "memory-store.ts", "store.ts"]);
    for (const file of files) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join("\n");
      for (const banned of ["supabase", "fetch(", "process.env", "node:", "server-only"]) {
        expect(code.toLowerCase().includes(banned), `${file}: ${banned}`).toBe(false);
      }
    }
  });
});

test.describe("the shared demo stores", () => {
  test("one store per mode, kept between requests", async () => {
    expect(demoStore("demo-readonly")).toBe(demoStore("demo-readonly"));
    expect(demoStore("demo-writable")).toBe(demoStore("demo-writable"));
    expect(demoStore("demo-readonly")).not.toBe(demoStore("demo-writable"));
  });

  test("the public one refuses writes and the local one keeps them", async () => {
    const input = {
      title: "kept",
      date_label: "2025-01-01",
      description: "",
      category: "food" as const,
      lat: 39,
      lng: -8,
    };
    expect(await demoStore("demo-readonly").createLocation(input)).toEqual({
      ok: false,
      error: { code: "read_only" },
    });
    const created = await demoStore("demo-writable").createLocation(input);
    expect(created.ok).toBe(true);
    const listed = await demoStore("demo-writable").listLocations();
    expect(listed.ok && listed.data.some((l) => l.title === "kept")).toBe(true);
    // What the local store saved never shows up in the public one.
    const publicList = await demoStore("demo-readonly").listLocations();
    expect(publicList.ok && publicList.data).toHaveLength(DEMO_LOCATIONS.length);
  });
});

test.describe("the demo data", () => {
  const CATEGORIES: CategoryKey[] = [
    "food",
    "nightout",
    "everyday",
    "beach",
    "adventure",
    "trip",
    "celebration",
    "milestone",
    "concert",
  ];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test("is twelve pins with fixed, distinct ids", () => {
    expect(DEMO_LOCATIONS).toHaveLength(12);
    const ids = DEMO_LOCATIONS.map((location) => location.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(UUID);
    expect(ids[0]).toBe("00000000-0000-4000-8000-000000000001");
  });

  test("uses every category", () => {
    const used = new Set(DEMO_LOCATIONS.map((location) => location.category));
    expect([...used].sort()).toEqual([...CATEGORIES].sort());
  });

  test("lies inside mainland Portugal and far from the test coordinates", () => {
    for (const { title, lat, lng } of DEMO_LOCATIONS) {
      expect(lat, title).toBeGreaterThan(36.9);
      expect(lat, title).toBeLessThan(42.2);
      expect(lng, title).toBeGreaterThan(-9.6);
      expect(lng, title).toBeLessThan(-6.1);
    }
  });

  test("has a title, a date that parses and text within the app's limits", () => {
    for (const location of DEMO_LOCATIONS) {
      expect(location.title.trim().length, location.id).toBeGreaterThan(0);
      // The caps POST /api/locations applies: 200, 1000 and 50 characters.
      expect(location.title.length, location.id).toBeLessThanOrEqual(200);
      expect(location.description.length, location.id).toBeLessThanOrEqual(1000);
      expect(location.date_label.length, location.id).toBeLessThanOrEqual(50);
      expect(location.date_label, location.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(location.date_label)), location.id).toBe(false);
      expect(Number.isNaN(Date.parse(location.created_at)), location.id).toBe(false);
      // Not a leftover of the write tests, which the map hides.
      expect(location.title.startsWith("__pw"), location.id).toBe(false);
      expect(location.photos).toEqual([]);
      expect(location.photo_url).toBeUndefined();
    }
  });

  test("is listed newest first in the order it is written", async () => {
    const listed = await createMemoryStore({ readOnly: true }).listLocations();
    expect(listed.ok && listed.data.map((l) => l.id)).toEqual(
      DEMO_LOCATIONS.map((l) => l.id),
    );
  });

  // SPEC R16: text a visitor reads has no em dash and no en dash.
  test("has no long dashes in its text", () => {
    for (const { title, description, date_label } of DEMO_LOCATIONS) {
      expect(`${title} ${description} ${date_label}`).not.toMatch(/[–—]/);
    }
  });
});
