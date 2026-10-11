import { test, expect } from "@playwright/test";

/**
 * Local verification for the per-photo ZOOM/SCALE feature.
 * Proves, against the dev server and its database, that a `{x, y, scale}` framing:
 *   1. PERSISTS across a fresh detail read (reload sim) and the list read (poll sim),
 *   2. is correctly VALIDATED (scale-range reject, scale-1 normalization, key reject),
 *   3. RENDERS on the map-card cover: `object-position` (pan) + `transform` (zoom).
 *
 * Self-contained: creates a throwaway, exercises it, and HARD-DELETES the row +
 * storage object in `finally`. Localhost-guarded so it can never mutate a
 * deployed DB. Skipped unless SITE_PASSWORD is present (loaded from `.env.local`
 * via @next/env in playwright.local.config.ts).
 */

const PW = process.env.SITE_PASSWORD;

const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

// Minimal valid 1x1 JPEG.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AfwD/2Q==",
  "base64",
);

const nameOf = (u?: string | null) =>
  !u
    ? null
    : (u.includes("/location-photos/")
        ? u.split("/location-photos/")[1].split("?")[0]
        : u.split("?")[0]) || null;

// Desktop viewport so the sidebar list is visible and the throwaway pin can be
// selected by id to open its card.
test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false });

test("per-photo zoom {x,y,scale} persists + validates + renders on the map card", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    !PW || !IS_LOCAL,
    "local-only write suite - needs SITE_PASSWORD and a localhost target",
  );
  const base = baseURL || "http://localhost:3000";

  // -- Login so the context holds app_session + app_csrf --
  await page.goto("/");
  await page.fill('input[type="password"]', PW!);
  await page.click('button[aria-label="Submit password"]');
  await expect(page).toHaveURL(/\/map/, { timeout: 10_000 });

  const cookies = await context.cookies();
  const csrf = cookies.find((c) => c.name === "app_csrf")?.value ?? "";
  const headers = { "X-CSRF-Token": csrf, "Content-Type": "application/json" };
  const req = page.request;

  const created: { id: string | null; files: string[] } = {
    id: null,
    files: [],
  };

  try {
    // -- Seed a throwaway with one photo --
    const loc = await (
      await req.post(`${base}/api/locations`, {
        headers,
        data: {
          title: "__pwzoom__",
          date_label: "2020-01-01",
          lat: 0,
          lng: 0,
          category: "concert",
        },
      })
    ).json();
    created.id = loc.id;
    expect(created.id, "throwaway created").toBeTruthy();

    const { signedUrl, path } = await (
      await req.post(`${base}/api/locations/${created.id}/photo-url`, {
        headers,
      })
    ).json();
    await req.put(signedUrl, {
      headers: { "Content-Type": "image/jpeg" },
      data: JPEG,
    });
    await req.post(`${base}/api/locations/${created.id}/photo`, {
      headers,
      data: { path },
    });
    created.files.push(path);
    const A = nameOf(path)!;
    expect(A, "stable object name").toBeTruthy();
    expect(
      A.startsWith(created.id + "-"),
      "object name carries the id prefix",
    ).toBe(true);

    // -- WRITE the zoom framing --
    const OFF = { x: 0.4, y: -0.3, scale: 2 };
    const patch = await req.patch(`${base}/api/locations/${created.id}`, {
      headers,
      data: { photo_offsets: { [A]: OFF } },
    });
    expect(patch.status(), "setPhotoOffsets accepted").toBe(200);

    // -- PERSIST across a fresh detail read (reload sim) --
    const detail = await (
      await req.get(`${base}/api/locations/${created.id}`, { headers })
    ).json();
    expect(detail.photo_offsets?.[A], "persisted on detail GET").toEqual({
      x: 0.4,
      y: -0.3,
      scale: 2,
    });

    // -- PERSIST across the list read (poll-cycle sim) --
    const list = await (
      await req.get(`${base}/api/locations`, { headers })
    ).json();
    const row = list.find((l: { id: string }) => l.id === created.id);
    expect(row?.photo_offsets?.[A], "persisted on list GET (poll)").toEqual({
      x: 0.4,
      y: -0.3,
      scale: 2,
    });

    // -- VALIDATOR: scale out of [1,3] -> 400 --
    const badScale = await req.patch(`${base}/api/locations/${created.id}`, {
      headers,
      data: { photo_offsets: { [A]: { x: 0, y: 0, scale: 5 } } },
    });
    expect(badScale.status(), "scale 5 rejected").toBe(400);

    // -- VALIDATOR: scale === 1 normalizes to {x,y} (scale dropped) --
    const norm = await req.patch(`${base}/api/locations/${created.id}`, {
      headers,
      data: { photo_offsets: { [A]: { x: 0.1, y: 0.2, scale: 1 } } },
    });
    expect(norm.status(), "scale 1 accepted").toBe(200);
    const afterNorm = await (
      await req.get(`${base}/api/locations/${created.id}`, { headers })
    ).json();
    expect(afterNorm.photo_offsets?.[A], "scale:1 normalized to {x,y}").toEqual(
      {
        x: 0.1,
        y: 0.2,
      },
    );

    // -- VALIDATOR: a foreign key (doesn't start with this location's id) -> 400.
    // Tests the IDOR/key-discipline guard (`key.startsWith(id + "-")`).
    const foreignKey = await req.patch(`${base}/api/locations/${created.id}`, {
      headers,
      data: { photo_offsets: { "not-this-location.jpg": { x: 0, y: 0 } } },
    });
    expect(foreignKey.status(), "foreign key rejected").toBe(400);

    // -- VALIDATOR: a real __proto__ key via RAW JSON -> 400. (A JS object literal
    // `{ __proto__: ... }` sets the prototype and never sends a "__proto__" key,
    // so the literal key must go over the wire as a raw string.)
    const protoKey = await req.patch(`${base}/api/locations/${created.id}`, {
      headers,
      data: '{"photo_offsets":{"__proto__":{"x":0,"y":0}}}',
    });
    expect(protoKey.status(), "__proto__ key rejected").toBe(400);

    // -- Restore the zoom framing for the render assertion --
    await req.patch(`${base}/api/locations/${created.id}`, {
      headers,
      data: { photo_offsets: { [A]: OFF } },
    });

    // -- RENDER on the map card: select the pin by id, read the cover <img> --
    await page.goto("/map");
    await page
      .locator(`[data-testid="sidebar-loc-${created.id}"]:visible`)
      .first()
      .click();
    const card = page.locator(".location-card");
    await expect(card).toBeVisible({ timeout: 5_000 });

    // The real photo <img> (not the aria-hidden LQIP/placeholder) must carry the
    // framing: object-position from {x:0.4,y:-0.3} -> "70% 35%", and the zoom from
    // scale 2 -> matrix(2,0,0,2,0,0).
    const coverImg = card.locator("img:not([aria-hidden])").first();
    await expect(coverImg).toBeVisible({ timeout: 6_000 });
    await expect
      .poll(
        async () =>
          coverImg.evaluate((el) => getComputedStyle(el).objectPosition),
        { timeout: 6_000, message: "map-card cover object-position" },
      )
      .toBe("70% 35%");
    await expect
      .poll(
        async () => coverImg.evaluate((el) => getComputedStyle(el).transform),
        { timeout: 6_000, message: "map-card cover zoom transform" },
      )
      .toBe("matrix(2, 0, 0, 2, 0, 0)");
  } finally {
    // -- Hard cleanup: storage object(s), then the row --
    if (created.id) {
      for (const p of created.files) {
        await req
          .delete(
            `${base}/api/locations/${created.id}/photo?filename=${encodeURIComponent(
              nameOf(p)!,
            )}`,
            { headers },
          )
          .catch(() => {});
      }
      await req
        .delete(`${base}/api/locations/${created.id}`, { headers })
        .catch(() => {});
    }
  }
});
