import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as placeSearch } from "@/app/api/geocode/route";
import { LIVE_VARS } from "@/lib/mode";
import { COOKIE_NAME, createSessionToken } from "@/lib/session";

// What a stranger on the public demo can reach beyond the map itself (SPEC R4, R14).
// The server side refusals are the real control and are tested in proxy-matrix,
// memory-store and gate. Here: place search is closed in a demo, and the screen does
// not offer controls that could never work.

const env = process.env as Record<string, string | undefined>;
const MANAGED = [
  ...LIVE_VARS,
  "DEMO_MODE",
  "NODE_ENV",
  "VERCEL",
  "VERCEL_ENV",
  "NEXT_PUBLIC_MAPBOX_TOKEN",
];
const KEY = "unit-test-signing-key-0123456789abcdef";
// Shaped like a public map token, built at run time. Never a real one.
const MAP_TOKEN = "pk." + "unit-test-map-token".repeat(3);
// Shaped like bcrypt output, built at run time. Never a real hash.
const HASH = "$2b$04$" + "a".repeat(53);

let saved: Record<string, string | undefined> = {};
let realFetch: typeof fetch;
let fetched: unknown[] = [];

test.beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((name) => [name, env[name]]));
  for (const name of MANAGED) delete env[name];
  env.NODE_ENV = "test";
  realFetch = globalThis.fetch;
  fetched = [];
  globalThis.fetch = (async (...args: unknown[]) => {
    fetched.push(args[0]);
    throw new Error("no network in the unit tests");
  }) as typeof fetch;
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of MANAGED) {
    const value = saved[name];
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
});

const search = (query: string) =>
  placeSearch(new NextRequest(`http://localhost/api/geocode?${query}`));

/** The same search, sent with a session cookie. */
const searchAs = (cookie: string, query: string) =>
  placeSearch(
    new NextRequest(`http://localhost/api/geocode?${query}`, {
      headers: { cookie: `${COOKIE_NAME}=${cookie}` },
    }),
  );

/** A session that verifies under the environment the test has set. */
async function liveSession(): Promise<string> {
  const token = await createSessionToken();
  if (!token) throw new Error("the test environment cannot sign a session");
  return token;
}

test.describe("place search in a demo", () => {
  const QUERIES = [
    "q=lisbon&session=00000000-0000-4000-8000-000000000001",
    "retrieve=some-id&session=00000000-0000-4000-8000-000000000001",
    "lat=38.7&lng=-9.1",
    "",
  ];

  for (const DEMO_MODE of ["1", "true", "writable"]) {
    test(`DEMO_MODE=${DEMO_MODE}: every query answers 404 and nothing is sent on`, async () => {
      env.DEMO_MODE = DEMO_MODE;
      // Even with a map token configured, which a demo needs to draw the map.
      env.NEXT_PUBLIC_MAPBOX_TOKEN = MAP_TOKEN;
      for (const query of QUERIES) {
        const res = await search(query);
        expect(res.status, query).toBe(404);
        expect(res.headers.get("cache-control"), query).toBe("no-store");
        expect(await res.text(), query).not.toContain(MAP_TOKEN);
      }
      expect(fetched).toEqual([]);
    });
  }

  test("a refused configuration is closed too", async () => {
    env.DEMO_MODE = "1";
    env.SESSION_SECRET = KEY;
    env.NEXT_PUBLIC_MAPBOX_TOKEN = MAP_TOKEN;
    const res = await search("q=lisbon");
    expect(res.status).toBe(404);
    expect(fetched).toEqual([]);
  });

  test("live mode gets past this check (and stops at the missing token, with no network call)", async () => {
    env.SESSION_SECRET = KEY;
    env.SITE_PASSWORD_HASH = HASH;
    const res = await searchAs(await liveSession(), "q=lisbon");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Mapbox token not configured" });
    expect(fetched).toEqual([]);
  });
});

test.describe("place search in live mode", () => {
  test("checks the session itself: no valid session cookie answers 401 and nothing is sent on", async () => {
    env.SESSION_SECRET = KEY;
    env.SITE_PASSWORD_HASH = HASH;
    env.NEXT_PUBLIC_MAPBOX_TOKEN = MAP_TOKEN;
    for (const cookie of [undefined, "", "not-a-session", (await liveSession()) + "x"]) {
      const res =
        cookie === undefined
          ? await search("q=lisbon&session=00000000-0000-4000-8000-000000000001")
          : await searchAs(cookie, "q=lisbon&session=00000000-0000-4000-8000-000000000001");
      expect(res.status, String(cookie)).toBe(401);
      expect(await res.text(), String(cookie)).not.toContain(MAP_TOKEN);
    }
    expect(fetched).toEqual([]);
  });

  test("a valid session gets past the check", async () => {
    env.SESSION_SECRET = KEY;
    env.SITE_PASSWORD_HASH = HASH;
    env.NEXT_PUBLIC_MAPBOX_TOKEN = MAP_TOKEN;
    const res = await searchAs(
      await liveSession(),
      "q=lisbon&session=00000000-0000-4000-8000-000000000001",
    );
    // The stubbed network refuses, so the route answers its own failure.
    expect(res.status).toBe(500);
    expect(fetched.length).toBe(1);
  });
});

// Text tripwires, not proofs: they stop a control from being put back on the demo's
// screen without anyone noticing. Whether a write works is decided on the server.
test.describe("the demo's screen", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const squash = (text: string) => text.replace(/\s+/g, " ");

  test("the map page tells the map when it is the read only demo", () => {
    const page = read("app/map/page.tsx");
    expect(page).toContain('getMode() === "demo-readonly"');
    expect(squash(page)).toContain("readOnly={isReadOnly()}");
  });

  test("the map offers no add button and no edit panel when read only", () => {
    const map = squash(read("components/Map/MapCanvas.tsx"));
    // The add button sits inside the read only switch.
    const addButton = map.indexOf('data-testid="admin-fab"');
    const guard = map.lastIndexOf("{!readOnly && (", addButton);
    expect(addButton).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(addButton - guard).toBeLessThan(260);
    expect(map).toContain("{adminOpen && !readOnly && (");
    expect(map).toContain("{readOnly && <DemoBanner />}");
    expect(map).toContain("readOnly={readOnly}");
  });

  test("the read only map does not poll and does not warm up the write route", () => {
    const map = squash(read("components/Map/MapCanvas.tsx"));
    expect(map).toContain("if (!mapLoaded || readOnly) return;");
    expect(map).toContain('if (mapLoaded && !readOnly) fetch("/api/locations")');
  });

  test("the place card offers no edit, remove or reframe when read only", () => {
    const card = squash(read("components/Map/LocationCard.tsx"));
    const guard = card.indexOf("{!readOnly && (");
    const edit = card.indexOf('title="Edit this place"');
    const remove = card.indexOf('title="Remove this place"');
    expect(guard).toBeGreaterThan(-1);
    expect(edit).toBeGreaterThan(guard);
    expect(remove).toBeGreaterThan(edit);
    expect(card).toContain("onReframe={ readOnly ? undefined :");
  });

  // SPEC R16: text a visitor reads has no em dash and no en dash.
  test("the banner says what the demo is, in plain characters", () => {
    const banner = read("components/UI/DemoBanner.tsx");
    expect(banner).toContain("Demo: made up data, read only.");
    expect(banner).not.toMatch(/[–—]/);
  });
});
