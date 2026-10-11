import { test, expect, type Page } from "@playwright/test";

/**
 * Regression: the calendar/timeline view must show a PREVIEW THUMBNAIL for every
 * date that has a photo.
 *
 * On Safari/WebKit over a slow network, lazy-loaded timeline thumbnails never
 * fetch while off-screen: `img.decode()` rejects on cross-origin images, so
 * FramedPhoto falls back to the <img> `onLoad` event, which never fires for a lazy
 * image the browser has not fetched. Below-the-fold rows would stay on a spinner.
 *
 * The timeline therefore loads its small thumbnails EAGERLY. This test locks that
 * in (the engine-independent guard) AND asserts the previews actually render for
 * photo'd locations, on both mobile and desktop.
 *
 * Read-only (existing photo'd pins); creates + deletes nothing.
 * Local-only (needs SITE_PASSWORD + localhost).
 */

const PW = process.env.SITE_PASSWORD;
const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

async function login(page: Page) {
  await page.goto("/");
  await page.fill('input[type="password"]', PW!);
  await page.click('button[aria-label="Submit password"]');
  await expect(page).toHaveURL(/\/map/, { timeout: 15_000 });
}

/** All timeline preview <img>s currently visible, with their key state. */
async function previewImages(page: Page) {
  return page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('[data-testid^="timeline-row-"]'),
    ).filter((r) => (r as HTMLElement).offsetParent !== null);
    return rows.map((r, i) => {
      const img = r.querySelector("img") as HTMLImageElement | null;
      const rect = (img ?? r).getBoundingClientRect();
      return {
        index: i,
        hasImg: !!img,
        loading: img?.loading ?? null,
        naturalWidth: img?.naturalWidth ?? 0,
        offScreen: rect.top >= window.innerHeight || rect.bottom <= 0,
      };
    });
  });
}

async function assertTimelinePreviews(page: Page) {
  // The photo'd rows render an <img> (vs the category-emoji fallback for a
  // photo-less pin).
  const photoRows = (await previewImages(page)).filter((r) => r.hasImg);
  expect(
    photoRows.length,
    "timeline should show at least one photo preview",
  ).toBeGreaterThan(0);

  // (1) Every timeline thumbnail loads EAGERLY, never lazily. Lazy loading would
  // leave off-screen rows stuck on a spinner in Safari.
  for (const r of photoRows) {
    expect(
      r.loading,
      `timeline preview #${r.index} must be eager, not lazy`,
    ).toBe("eager");
  }

  // (2) Behavioral proof: every photo'd row's preview actually loads - including
  // the below-the-fold rows - WITHOUT any scrolling. Poll to allow the network.
  await expect
    .poll(
      async () =>
        (await previewImages(page)).filter(
          (r) => r.hasImg && r.naturalWidth > 0,
        ).length,
      { timeout: 20_000, message: "all timeline previews should load" },
    )
    .toBe(photoRows.length);

  // When there are more rows than fit on screen, EVERY below-the-fold photo
  // row must also have loaded - without any scrolling. Guarded by a count check
  // so the assertion only applies when some rows are off-screen (a list that
  // fits entirely on screen has nothing off-screen to test).
  const finalState = await previewImages(page);
  const offScreenPhotoRows = finalState.filter((r) => r.hasImg && r.offScreen);
  if (offScreenPhotoRows.length > 0) {
    const loadedOffScreen = offScreenPhotoRows.filter(
      (r) => r.naturalWidth > 0,
    );
    expect(
      loadedOffScreen.length,
      "below-the-fold timeline previews must load eagerly, without scrolling",
    ).toBe(offScreenPhotoRows.length);
  }
}

test.describe("Timeline preview thumbnails render (Safari off-screen regression)", () => {
  test("mobile: every date shows its preview thumbnail", async ({ page }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto("/map");
    await page.waitForTimeout(1000);
    await page.locator(".mobile-places-btn").click();
    await page.waitForTimeout(300);
    await page.locator('button[aria-label="Timeline view"]:visible').click();
    await page.waitForTimeout(500);
    await assertTimelinePreviews(page);
  });

  test("desktop: every date shows its preview thumbnail", async ({ page }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page);
    await page.goto("/map");
    await page.waitForTimeout(1000);
    await page.locator('button[aria-label="Timeline view"]:visible').click();
    await page.waitForTimeout(500);
    await assertTimelinePreviews(page);
  });
});
