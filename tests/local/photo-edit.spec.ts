import { test, expect } from "@playwright/test";

/**
 * Local gesture coverage for the photo reframe overlay + drag-reorder, against
 * the dev server. Drives the real browser gestures (pointer drag), then asserts
 * the resulting state persisted via the API. Self-contained: creates a throwaway
 * location + photos, exercises the UI, and hard-deletes everything in `finally`.
 *
 * Skipped automatically unless SITE_PASSWORD is present in the environment.
 */

const PW = process.env.SITE_PASSWORD;

// HARD GUARD: this suite creates AND hard-deletes real rows + storage objects.
// It must NEVER run against a deployed/prod DB. The local config targets
// localhost; refuse to run if pointed anywhere else - belt-and-suspenders so a
// stray E2E_BASE or a CI misconfiguration can never mutate a deployed DB.
// (CI safety is layered: this suite lives in tests/local/, which runs only
// through playwright.local.config.ts; this guard is the second line of
// defense.)
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

test("reframe overlay + drag-reorder persist via the UI", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    !PW || !IS_LOCAL,
    "local-only write suite - needs SITE_PASSWORD and a localhost target",
  );
  const base = baseURL || "http://localhost:3000";

  // -- Login via the password page so the context holds app_session + app_csrf --
  await page.goto("/");
  await page.fill('input[type="password"]', PW!);
  await page.click('button[aria-label="Submit password"]');
  await expect(page).toHaveURL(/\/map/, { timeout: 10_000 });

  const cookies = await context.cookies();
  const csrfToken = cookies.find((c) => c.name === "app_csrf")?.value ?? "";
  const headers = {
    "X-CSRF-Token": csrfToken,
    "Content-Type": "application/json",
  };
  const req = page.request;

  const created: { id: string | null; files: string[] } = {
    id: null,
    files: [],
  };

  try {
    // -- Seed: a throwaway location + 2 photos via the real API paths --
    const loc = await (
      await req.post(`${base}/api/locations`, {
        headers,
        data: {
          title: "__pwtest__",
          date_label: "2020-01-01",
          lat: 0,
          lng: 0,
          category: "concert",
        },
      })
    ).json();
    created.id = loc.id;
    expect(created.id).toBeTruthy();

    async function upload() {
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
      return path as string;
    }
    created.files.push(await upload());
    await page.waitForTimeout(60);
    created.files.push(await upload());
    const A = nameOf(created.files[0])!;
    const B = nameOf(created.files[1])!;

    // -- Open the map fresh so SSR includes the new location, then edit it --
    await page.goto("/map");
    await page.getByTestId("admin-fab").click();
    await page
      .getByTestId(`manage-row-${created.id}`)
      .getByTitle("Edit this place")
      .click();

    // Edit grid renders the two photos.
    const thumbs = page.getByTestId("edit-photo-thumb");
    await expect(thumbs).toHaveCount(2, { timeout: 10_000 });

    // -- Reframe: tap the first thumb -> drag inside the overlay -> save --
    await thumbs.first().click(); // quick tap -> reframe (not long-press)
    const frame = page.getByTestId("reframe-frame");
    await expect(frame).toBeVisible({ timeout: 5_000 });
    // Wait for the overlay IMAGE to load: ReframeOverlay.onPointerDown bails
    // while !loaded, so a drag fired before the image decodes registers no pan
    // and the offset would persist as {0,0}. This removes a flaky timing window.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const img = document.querySelector(
              '[data-testid="reframe-frame"] img',
            ) as HTMLImageElement | null;
            return img?.naturalWidth ?? 0;
          }),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    const box = (await frame.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // Drag left+up so the image pans -> a non-zero normalized offset.
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(cx - i * 6, cy - i * 4);
    }
    await page.mouse.up();
    await page.getByTestId("reframe-save").click();
    await expect(frame).toBeHidden({ timeout: 5_000 });

    // Assert the offset persisted for photo A.
    const afterReframe = await (
      await req.get(`${base}/api/locations/${created.id}`, { headers })
    ).json();
    const off = afterReframe.photo_offsets?.[A];
    expect(off, "photo_offsets[A] persisted").toBeTruthy();
    expect(Number.isFinite(off.x) && Number.isFinite(off.y)).toBeTruthy();
    expect(Math.abs(off.x) + Math.abs(off.y)).toBeGreaterThan(0);

    // -- Reorder: long-press the first thumb and drag it past the second --
    const t0 = (await thumbs.nth(0).boundingBox())!;
    const t1 = (await thumbs.nth(1).boundingBox())!;
    await page.mouse.move(t0.x + t0.width / 2, t0.y + t0.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(350); // exceed the 250ms long-press threshold
    // Move past the second thumb's center to drop after it.
    const tx = t1.x + t1.width * 0.9;
    const ty = t1.y + t1.height / 2;
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(
        t0.x + ((tx - t0.x) * i) / 8,
        t0.y + ((ty - t0.y) * i) / 8,
      );
    }
    await page.mouse.up();

    // Assert the new order persisted: cover is now B.
    await expect(async () => {
      const afterReorder = await (
        await req.get(`${base}/api/locations/${created.id}`, { headers })
      ).json();
      expect(nameOf(afterReorder.photos?.[0])).toBe(B);
    }).toPass({ timeout: 6_000 });
  } finally {
    // -- Hard cleanup: storage objects, then the row --
    if (created.id) {
      for (const path of created.files) {
        await req
          .delete(
            `${base}/api/locations/${created.id}/photo?filename=${encodeURIComponent(
              nameOf(path)!,
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

// ---------------------------------------------------------------------------
// Delete persistence + image loading state. Desktop viewport
// so the sidebar list is visible and a specific pin can be selected to open its
// card. Self-contained throwaways, hard-deleted in finally.
// ---------------------------------------------------------------------------
test.describe("delete + loading state (desktop)", () => {
  test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false });

  async function login(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.fill('input[type="password"]', PW!);
    await page.click('button[aria-label="Submit password"]');
    await expect(page).toHaveURL(/\/map/, { timeout: 10_000 });
  }
  async function apiHeaders(
    context: import("@playwright/test").BrowserContext,
  ) {
    const c = await context.cookies();
    return {
      "X-CSRF-Token": c.find((x) => x.name === "app_csrf")?.value ?? "",
      "Content-Type": "application/json",
    };
  }

  test("card-trash delete persists (stays gone across refetch)", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(
      !PW || !IS_LOCAL,
      "local-only write suite - needs SITE_PASSWORD and a localhost target",
    );
    const base = baseURL || "http://localhost:3000";
    await login(page);
    const headers = await apiHeaders(context);
    // Throwaway with no photo_url and empty photos.
    const loc = await (
      await page.request.post(`${base}/api/locations`, {
        headers,
        data: {
          title: "__pwdel__",
          date_label: "2020-01-01",
          lat: 0,
          lng: 0,
          category: "everyday",
        },
      })
    ).json();
    let deleted = false;
    try {
      await page.goto("/map");
      await page
        .locator(`[data-testid="sidebar-loc-${loc.id}"]:visible`)
        .first()
        .click();
      const card = page.locator(".location-card");
      await expect(card).toBeVisible({ timeout: 5_000 });
      await card.getByTitle("Remove this place").click();
      // Soft-delete fires the real DELETE after 5s - wait it out, then assert.
      await expect(async () => {
        const r = await page.request.get(`${base}/api/locations/${loc.id}`, {
          headers,
        });
        expect(r.status()).toBe(404); // row hard-deleted (CSRF was sent)
      }).toPass({ timeout: 12_000 });
      // And it must not be in the list (stays gone across a refetch).
      const list = await (
        await page.request.get(`${base}/api/locations`, { headers })
      ).json();
      expect(list.some((l: { id: string }) => l.id === loc.id)).toBe(false);
      deleted = true;
    } finally {
      if (!deleted)
        await page.request
          .delete(`${base}/api/locations/${loc.id}`, { headers })
          .catch(() => {});
    }
  });

  const IMG_GLOB = "**/storage/v1/object/sign/location-photos/**";

  async function seedWithPhoto(
    page: import("@playwright/test").Page,
    base: string,
    headers: Record<string, string>,
    title: string,
  ) {
    const loc = await (
      await page.request.post(`${base}/api/locations`, {
        headers,
        data: {
          title,
          date_label: "2020-01-01",
          lat: 0,
          lng: 0,
          category: "nightout",
        },
      })
    ).json();
    const { signedUrl, path } = await (
      await page.request.post(`${base}/api/locations/${loc.id}/photo-url`, {
        headers,
      })
    ).json();
    await page.request.put(signedUrl, {
      headers: { "Content-Type": "image/jpeg" },
      data: JPEG,
    });
    await page.request.post(`${base}/api/locations/${loc.id}/photo`, {
      headers,
      data: { path },
    });
    return { id: loc.id as string, path: path as string };
  }
  async function cleanup(
    page: import("@playwright/test").Page,
    base: string,
    headers: Record<string, string>,
    id: string,
    path: string,
  ) {
    await page.request
      .delete(
        `${base}/api/locations/${id}/photo?filename=${encodeURIComponent(nameOf(path)!)}`,
        { headers },
      )
      .catch(() => {});
    await page.request
      .delete(`${base}/api/locations/${id}`, { headers })
      .catch(() => {});
  }

  test("photo shows a loading state (spinner), never the emoji, while the image loads", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(
      !PW || !IS_LOCAL,
      "local-only write suite - needs SITE_PASSWORD and a localhost target",
    );
    const base = baseURL || "http://localhost:3000";
    await login(page);
    const headers = await apiHeaders(context);
    const seed = await seedWithPhoto(page, base, headers, "__pwload__");
    try {
      // Delay the image so the loading state is observable and the emoji never shows.
      await page.route(IMG_GLOB, async (route) => {
        await new Promise((r) => setTimeout(r, 3000));
        await route.continue();
      });
      await page.goto("/map");
      await page
        .locator(`[data-testid="sidebar-loc-${seed.id}"]:visible`)
        .first()
        .click();
      const card = page.locator(".location-card");
      await expect(card).toBeVisible({ timeout: 5_000 });
      await expect(card.getByTestId("framed-spinner")).toBeVisible({
        timeout: 4_000,
      });
      expect(await card.getByTestId("framed-emoji").count()).toBe(0); // NEVER emoji while loading
    } finally {
      await cleanup(page, base, headers, seed.id, seed.path);
    }
  });

  test("photo falls back to the category emoji only on a real load error", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(
      !PW || !IS_LOCAL,
      "local-only write suite - needs SITE_PASSWORD and a localhost target",
    );
    const base = baseURL || "http://localhost:3000";
    await login(page);
    const headers = await apiHeaders(context);
    const seed = await seedWithPhoto(page, base, headers, "__pwerr__");
    try {
      // Abort every image request -> a genuine onerror -> the emoji fallback.
      await page.route(IMG_GLOB, (route) => route.abort());
      await page.goto("/map");
      await page
        .locator(`[data-testid="sidebar-loc-${seed.id}"]:visible`)
        .first()
        .click();
      const card = page.locator(".location-card");
      await expect(card).toBeVisible({ timeout: 5_000 });
      await expect(card.getByTestId("framed-emoji")).toBeVisible({
        timeout: 6_000,
      });
    } finally {
      await cleanup(page, base, headers, seed.id, seed.path);
    }
  });
});
