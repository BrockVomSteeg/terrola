import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import {
  DELETE as deletePhoto,
  GET as listPhotos,
  POST as registerPhoto,
} from "@/app/api/locations/[id]/photo/route";
import { POST as createUpload } from "@/app/api/locations/[id]/photo-url/route";
import { storeFor } from "@/app/api/_lib/live-access";
import { DEMO_LOCATIONS } from "@/lib/demo/fixtures";
import { demoStore } from "@/lib/demo/memory-store";
import { LIVE_VARS } from "@/lib/mode";

// The photo writes go through the data gate (SPEC R17, R4). These tests call the real
// handlers of /api/locations/[id]/photo and /api/locations/[id]/photo-url. The route
// keeps its own checks (write token, rate limit, id shape, request) and then makes
// one store call; in a demo that store is the memory store, which has no file
// storage. The routes read the real environment, so each test sets it.

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
function call(
  method: string,
  path: string,
  body?: string,
  contentType = "application/json",
): NextRequest {
  address++;
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": contentType,
      "x-forwarded-for": `10.2.${Math.floor(address / 250)}.${address % 250}`,
    },
    ...(body === undefined ? {} : { body }),
  });
}

const at = (id: string) => ({ params: Promise.resolve({ id }) });

/** What AdminPanel sends first: a request for a place to upload to. */
const askForUpload = (id: string) =>
  createUpload(call("POST", `/api/locations/${id}/photo-url`), at(id));
/** What AdminPanel sends after the upload: the path it was given. */
const register = (id: string, path: unknown) =>
  registerPhoto(
    call("POST", `/api/locations/${id}/photo`, JSON.stringify({ path })),
    at(id),
  );
/** No name removes the cover, as AdminPanel's older callers did. */
const remove = (id: string, filename?: string) =>
  deletePhoto(
    call(
      "DELETE",
      filename === undefined
        ? `/api/locations/${id}/photo`
        : `/api/locations/${id}/photo?filename=${encodeURIComponent(filename)}`,
    ),
    at(id),
  );

async function photosOf(id: string): Promise<string[]> {
  const res = await listPhotos(call("GET", `/api/locations/${id}/photo`), at(id));
  expect(res.status).toBe(200);
  return ((await res.json()) as { photos: string[] }).photos;
}

/** The stored object name of a demo picture, as the page sends it. */
const nameOf = (photo: string): string => photo.split("/").pop() ?? "";

const place = (index: number) => {
  const found = DEMO_LOCATIONS[index];
  const photos = found.photos ?? [];
  expect(photos.length).toBeGreaterThan(0);
  return { id: found.id, photos, name: nameOf(photos[0]) };
};

test.describe("the read only demo", () => {
  test("refuses every photo write with 403 demo_read_only, and nothing changes", async () => {
    readOnly();
    const own = place(2);

    for (const res of [
      await askForUpload(own.id),
      await register(own.id, `${own.id}-1700000009999.jpg`),
      await remove(own.id, own.name),
      await remove(own.id),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "demo_read_only" });
      expect(res.headers.get("cache-control")).toBeNull();
    }
    expect(await photosOf(own.id)).toEqual(own.photos);
  });
});

test.describe("the writable demo", () => {
  test("an upload answers 501 not_supported_in_demo: the demo has no file storage", async () => {
    writable();
    const own = place(2);

    // AdminPanel reads only the status here: anything but 2xx ends in its usual
    // "Upload failed" message.
    for (const res of [
      await askForUpload(own.id),
      await register(own.id, `${own.id}-1700000009999.jpg`),
    ]) {
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: "not_supported_in_demo" });
      expect(res.headers.get("cache-control")).toBeNull();
    }
    expect(await photosOf(own.id)).toEqual(own.photos);
  });

  test("a path that is not in this place's namespace is refused before the store", async () => {
    writable();
    const own = place(2);
    const other = place(3);
    for (const path of [other.name, "photo.jpg", 42, undefined]) {
      const res = await register(own.id, path);
      expect(res.status, String(path)).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid path" });
    }
  });

  test("a delete of a photo named for another place removes nothing in either place", async () => {
    writable();
    const own = place(2);
    const other = place(3);

    const res = await remove(own.id, other.name);
    expect(res.status).toBe(200);
    // The answer keeps the shape lib/api-client.ts reads (PhotoSaveResponse).
    expect(await res.json()).toEqual({
      photos: own.photos,
      photo_url: own.photos[0],
      thumbs: own.photos.map(() => ""),
      cards: own.photos.map(() => ""),
    });
    expect(await photosOf(own.id)).toEqual(own.photos);
    expect(await photosOf(other.id)).toEqual(other.photos);
  });

  test("a name that cleans down to nothing is never taken as the cover", async () => {
    writable();
    const own = place(2);
    for (const filename of ["!!!", "?token=abc", "%%%"]) {
      const res = await remove(own.id, filename);
      expect(res.status, filename).toBe(200);
      expect(await photosOf(own.id)).toEqual(own.photos);
    }
  });

  test("a delete of this place's own photo removes it, and the answer has the same shape", async () => {
    writable();
    const own = place(11);
    const res = await remove(own.id, own.name);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(await res.json()).toEqual({
      photos: own.photos.slice(1),
      photo_url: own.photos[1] ?? null,
      thumbs: own.photos.slice(1).map(() => ""),
      cards: own.photos.slice(1).map(() => ""),
    });
    expect(await photosOf(own.id)).toEqual(own.photos.slice(1));
  });

  test("a delete with no name removes the cover", async () => {
    writable();
    const own = place(10);
    const res = await remove(own.id);
    expect(res.status).toBe(200);
    expect(await photosOf(own.id)).toEqual(own.photos.slice(1));
  });

  test("the older upload through the server is gone: anything but JSON answers 415", async () => {
    writable();
    const own = place(2);
    const res = await registerPhoto(
      call(
        "POST",
        `/api/locations/${own.id}/photo`,
        "--x\r\nContent-Disposition: form-data; name=\"photo\"\r\n\r\nbytes\r\n--x--\r\n",
        "multipart/form-data; boundary=x",
      ),
      at(own.id),
    );
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "Send JSON with the uploaded path" });
    expect(await photosOf(own.id)).toEqual(own.photos);
  });

  test("an id that is not a UUID is refused before the store", async () => {
    writable();
    for (const res of [
      await askForUpload("not-a-uuid"),
      await register("not-a-uuid", "not-a-uuid-1.jpg"),
      await remove("not-a-uuid", "not-a-uuid-1.jpg"),
    ]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid id format" });
    }
  });
});

test.describe("the scheduler", () => {
  test("a cron caller is refused every photo write, and the store does not change", async () => {
    const store = demoStore("demo-writable");
    const own = place(2);
    const before = await store.listPhotos(own.id);
    const scheduler = storeFor("cron", store);
    const refusal = { ok: false, error: { code: "unauthorized" } };

    expect(await scheduler.createPhotoUpload(own.id)).toEqual(refusal);
    expect(await scheduler.registerPhoto(own.id, `${own.id}-1.jpg`)).toEqual(refusal);
    expect(await scheduler.deletePhoto(own.id, own.name)).toEqual(refusal);
    expect(await scheduler.deletePhoto(own.id)).toEqual(refusal);
    expect(await store.listPhotos(own.id)).toEqual(before);
  });
});

test.describe("live mode", () => {
  test("a photo write without a session and its token is refused with 403 before any store is opened", async () => {
    env.SESSION_SECRET = KEY;
    env.SITE_PASSWORD_HASH = HASH;
    const own = place(2);
    for (const res of [
      await askForUpload(own.id),
      await register(own.id, `${own.id}-1.jpg`),
      await remove(own.id, own.name),
      await remove(own.id),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "CSRF token missing or invalid" });
    }
  });
});
