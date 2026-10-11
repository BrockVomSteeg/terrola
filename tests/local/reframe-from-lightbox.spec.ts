import { test, expect, type Page } from "@playwright/test";

/**
 * The reframe editor must be reachable from the LIGHTBOX (without entering edit
 * mode), and the result must persist + render on the card exactly like the
 * edit-mode path. Verified on touch (375x812) AND desktop (1280x900). The
 * lightbox itself stays a full-photo viewer.
 *
 * Self-contained: creates a throwaway + photo, exercises it, and hard-deletes in
 * finally.
 */

const PW = process.env.SITE_PASSWORD;
const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

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

async function login(page: Page) {
  await page.goto("/");
  await page.fill('input[type="password"]', PW!);
  await page.click('button[aria-label="Submit password"]');
  await expect(page).toHaveURL(/\/map/, { timeout: 15_000 });
}

async function runReframeFromLightbox(page: Page, base: string) {
  await login(page);
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === "app_csrf")?.value ?? "";
  const headers = { "X-CSRF-Token": csrf, "Content-Type": "application/json" };
  const req = page.request;

  const created: { id: string | null; files: string[] } = {
    id: null,
    files: [],
  };
  try {
    const loc = await (
      await req.post(`${base}/api/locations`, {
        headers,
        data: {
          title: "__pwlb__",
          date_label: "2020-01-01",
          lat: 0,
          lng: 0,
          category: "everyday",
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

    // -- Open the card, tap the cover -> lightbox --
    await page.goto("/map");
    await page.waitForTimeout(800);
    // On mobile the sidebar list lives in the bottom sheet - open it first.
    // (No-op on desktop, where the sidebar is always visible.)
    const placesBtn = page.locator(".mobile-places-btn");
    if (await placesBtn.isVisible().catch(() => false)) {
      await placesBtn.click();
      await page.waitForTimeout(400);
    }
    await page
      .locator(`[data-testid="sidebar-loc-${created.id}"]:visible`)
      .first()
      .click();
    const card = page.locator(".location-card");
    await expect(card).toBeVisible({ timeout: 6000 });
    await card.locator("img:not([aria-hidden])").first().click();

    const lightbox = page.locator(".photo-lightbox");
    await expect(lightbox).toBeVisible({ timeout: 5000 });

    // -- The explicit reframe entry must be present in the lightbox --
    const reframeBtn = page.locator('[data-testid="lightbox-reframe"]');
    await expect(reframeBtn).toBeVisible();
    await reframeBtn.click();

    // -- Reframe editor opens (NOT in edit mode) --
    const frame = page.locator('[data-testid="reframe-frame"]');
    await expect(frame).toBeVisible({ timeout: 5000 });

    // Wait for the photo to load (the slider is disabled until then), set zoom->2.
    const zoom = page.locator('[data-testid="reframe-zoom"]');
    await expect(zoom).toBeEnabled({ timeout: 6000 });
    await zoom.evaluate((el) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.locator('[data-testid="reframe-save"]').click();

    // -- Editor closes; framing persisted --
    await expect(frame).toBeHidden({ timeout: 6000 });
    const detail = await (
      await req.get(`${base}/api/locations/${created.id}`, { headers })
    ).json();
    expect(
      detail.photo_offsets?.[A],
      "persisted scale from the lightbox",
    ).toEqual({ x: 0, y: 0, scale: 2 });

    // -- Renders identically on the card cover (zoom transform) --
    await expect(card).toBeVisible();
    const coverImg = card.locator("img:not([aria-hidden])").first();
    await expect
      .poll(
        async () => coverImg.evaluate((el) => getComputedStyle(el).transform),
        { timeout: 6000, message: "card cover zoom transform" },
      )
      .toBe("matrix(2, 0, 0, 2, 0, 0)");
  } finally {
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
}

test("mobile: reframe is reachable from the lightbox + persists + renders", async ({
  page,
  baseURL,
}) => {
  test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
  await page.setViewportSize({ width: 375, height: 812 });
  await runReframeFromLightbox(page, baseURL || "http://localhost:3000");
});

test("desktop: reframe is reachable from the lightbox + persists + renders", async ({
  page,
  baseURL,
}) => {
  test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
  await page.setViewportSize({ width: 1280, height: 900 });
  await runReframeFromLightbox(page, baseURL || "http://localhost:3000");
});
