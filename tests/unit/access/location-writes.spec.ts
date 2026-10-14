import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import {
  GET as listPlaces,
  POST as createPlace,
} from "@/app/api/locations/route";
import {
  DELETE as deletePlace,
  GET as getPlace,
  PATCH as patchPlace,
} from "@/app/api/locations/[id]/route";
import { storeFor } from "@/app/api/_lib/live-access";
import { storeError } from "@/app/api/_lib/store-response";
import { DEMO_LOCATIONS } from "@/lib/demo/fixtures";
import { demoStore } from "@/lib/demo/memory-store";
import { LIVE_VARS } from "@/lib/mode";
import type { Location } from "@/types";

// The place writes go through the data gate (SPEC R17, R4). These tests call the real
// POST, PATCH and DELETE handlers. The route keeps its own checks (write token, rate
// limit, id shape, body) and then makes one store call; in a demo that store is the
// memory store. The routes read the real environment, so each test sets it.

const env = process.env as Record<string, string | undefined>;
const MANAGED = [...LIVE_VARS, "DEMO_MODE", "NODE_ENV", "VERCEL", "VERCEL_ENV"];
const KEY = "unit-test-signing-key-0123456789abcdef";
// Shaped like bcrypt output, built at run time. Never a real hash.
const HASH = "$2b$04$" + "a".repeat(53);

let saved: Record<string, string | undefined> = {};

test.beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((name) => [name, env[name]]));
  for (const name of MANAGED) delete env[name];
  env.NODE_ENV = "test";
});

test.afterEach(() => {
  for (const name of MANAGED) {
    const value = saved[name];
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
});

const writable = () => {
  env.DEMO_MODE = "writable";
};
const readOnly = () => {
  env.DEMO_MODE = "1";
};

let address = 0;

/**
 * A request as the page sends it. Each one comes from its own address, so the
 * per address rate limit never decides a test.
 */
function call(method: string, path: string, body?: unknown): NextRequest {
  address++;
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.1.${Math.floor(address / 250)}.${address % 250}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const at = (id: string) => ({ params: Promise.resolve({ id }) });

const create = (body: unknown) => createPlace(call("POST", "/api/locations", body));
const patch = (id: string, body: unknown) =>
  patchPlace(call("PATCH", `/api/locations/${id}`, body), at(id));
const remove = (id: string) =>
  deletePlace(call("DELETE", `/api/locations/${id}`), at(id));
const read = (id: string) => getPlace(call("GET", `/api/locations/${id}`), at(id));

async function list(): Promise<Location[]> {
  const res = await listPlaces(call("GET", "/api/locations"));
  expect(res.status).toBe(200);
  return (await res.json()) as Location[];
}

/** The body the add form sends (components/Map/AdminPanel.tsx, lib/api-client.ts). */
const NEW_PLACE = {
  title: "Unit test place",
  date_label: "2025-10-01",
  lat: 38.7,
  lng: -9.1,
  description: "Made for a test.",
  category: "food",
};

/** The fields lib/api-client.ts reads back as a Location. */
const placeShape = (fields: Partial<Location>) => ({
  id: expect.any(String),
  display_order: 0,
  created_at: expect.any(String),
  ...fields,
});

const FIXTURE = DEMO_LOCATIONS[0];

test.describe("place writes in the writable demo", () => {
  test("a new place answers 201 with the place, and is in the next list", async () => {
    writable();
    const res = await create({
      ...NEW_PLACE,
      title: "  Padded title  ",
      category: "not-a-category",
    });
    expect(res.status).toBe(201);
    // The same headers as before the move: none about caching.
    expect(res.headers.get("cache-control")).toBeNull();
    const created = (await res.json()) as Location;
    // The route trims and checks; the store gets the cleaned value.
    expect(created).toMatchObject(
      placeShape({
        title: "Padded title",
        date_label: NEW_PLACE.date_label,
        description: NEW_PLACE.description,
        category: "everyday",
        lat: NEW_PLACE.lat,
        lng: NEW_PLACE.lng,
      }),
    );

    const listed = (await list()).find((place) => place.id === created.id);
    expect(listed?.title).toBe("Padded title");
    const found = await read(created.id);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(created);

    expect((await remove(created.id)).status).toBe(200);
  });

  test("an edit answers 200 with the changed place, and the next read shows it", async () => {
    writable();
    const created = (await (await create(NEW_PLACE)).json()) as Location;

    const res = await patch(created.id, { title: "Edited", category: "beach", lat: 40 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
    const edited = (await res.json()) as Location;
    expect(edited).toEqual({ ...created, title: "Edited", category: "beach", lat: 40 });
    expect(await (await read(created.id)).json()).toEqual(edited);

    expect((await remove(created.id)).status).toBe(200);
  });

  test("a delete answers 200 with exactly { success: true }, and the place is gone", async () => {
    writable();
    const created = (await (await create(NEW_PLACE)).json()) as Location;

    const res = await remove(created.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(await res.json()).toEqual({ success: true });

    expect((await list()).some((place) => place.id === created.id)).toBe(false);
    const gone = await read(created.id);
    expect(gone.status).toBe(404);

    // A second delete finds nothing, with the words the page already knows.
    const again = await remove(created.id);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "Location not found" });
    expect(again.headers.get("cache-control")).toBeNull();
  });

  test("an edit of a place that does not exist answers 404, as before", async () => {
    writable();
    const missing = "00000000-0000-4000-8000-0000000000ff";
    const res = await patch(missing, { title: "Edited" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Location not found" });
  });

  test("a reorder answers the place with its photos, and a photo of another place is refused", async () => {
    writable();
    const photos = FIXTURE.photos ?? [];
    expect(photos.length).toBeGreaterThan(0);

    const res = await patch(FIXTURE.id, { photos });
    expect(res.status).toBe(200);
    const reordered = (await res.json()) as Location;
    expect(reordered.photos).toEqual(photos);
    expect(reordered.photo_url).toBe(photos[0]);

    // Guards against changing another place's photos through this one (IDOR).
    const other = DEMO_LOCATIONS[1].photos ?? [];
    expect(other.length).toBeGreaterThan(0);
    const refused = await patch(FIXTURE.id, { photos: [other[0], ...photos] });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "photo does not belong to this location",
    });
    expect((await (await read(FIXTURE.id)).json()).photos).toEqual(photos);
  });
});

test.describe("the checks the route keeps before the store", () => {
  test("a fraction for photo_offset_x or photo_offset_y is refused, and nothing is saved", async () => {
    writable();
    const created = (await (await create(NEW_PLACE)).json()) as Location;

    const whole = await patch(created.id, { photo_offset_x: 12, photo_offset_y: -7 });
    expect(whole.status).toBe(200);
    expect(await whole.json()).toMatchObject({ photo_offset_x: 12, photo_offset_y: -7 });

    for (const [body, error] of [
      [{ photo_offset_x: 1.5 }, "photo_offset_x must be an integer between -500 and 500"],
      [{ photo_offset_y: -0.25 }, "photo_offset_y must be an integer between -500 and 500"],
      [{ photo_offset_x: 499.999 }, "photo_offset_x must be an integer between -500 and 500"],
    ] as const) {
      const res = await patch(created.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(await (await read(created.id)).json()).toMatchObject({
      photo_offset_x: 12,
      photo_offset_y: -7,
    });

    expect((await remove(created.id)).status).toBe(200);
  });

  test("an id that is not a UUID is refused before the store", async () => {
    writable();
    for (const res of [
      await patch("not-a-uuid", { title: "Edited" }),
      await remove("not-a-uuid"),
    ]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid id format" });
    }
  });

  test("a new place without its required fields is refused, and nothing is saved", async () => {
    writable();
    const before = (await list()).length;
    const res = await create({ title: "No place" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "title, date_label, lat, and lng are required",
    });
    expect((await list()).length).toBe(before);
  });
});

test.describe("the read only demo", () => {
  test("refuses every write with 403 demo_read_only, and nothing changes", async () => {
    readOnly();
    const before = await list();

    for (const res of [
      await create(NEW_PLACE),
      await patch(FIXTURE.id, { title: "Changed" }),
      await remove(FIXTURE.id),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "demo_read_only" });
    }

    expect(await list()).toEqual(before);
  });
});

test.describe("live mode", () => {
  test("a write without a session and its token is refused with 403 before any store is opened", async () => {
    env.SESSION_SECRET = KEY;
    env.SITE_PASSWORD_HASH = HASH;
    for (const res of [
      await create(NEW_PLACE),
      await patch(FIXTURE.id, { title: "Changed" }),
      await remove(FIXTURE.id),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "CSRF token missing or invalid" });
    }
  });
});

test.describe("the scheduler", () => {
  test("a cron caller is refused every place write, and the store does not change", async () => {
    const store = demoStore("demo-writable");
    const before = await store.listLocations();
    const scheduler = storeFor("cron", store);
    const refusal = { ok: false, error: { code: "unauthorized" } };

    expect(
      await scheduler.createLocation({
        title: NEW_PLACE.title,
        date_label: NEW_PLACE.date_label,
        description: NEW_PLACE.description,
        category: "food",
        lat: NEW_PLACE.lat,
        lng: NEW_PLACE.lng,
      }),
    ).toEqual(refusal);
    expect(await scheduler.updateLocation(FIXTURE.id, { title: "Changed" })).toEqual(
      refusal,
    );
    expect(await scheduler.deleteLocation(FIXTURE.id)).toEqual(refusal);
    expect(await store.listLocations()).toEqual(before);

    // What a route answers for that refusal: 401, the words the page treats as a
    // lost session.
    const res = storeError("unauthorized", "Failed to save location", false);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Session expired. Please re-enter the password.",
    });
  });
});
