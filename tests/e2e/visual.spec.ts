import { test, expect } from "@playwright/test";

test.skip(
  !!process.env.CI,
  "Visual snapshots run locally only, OS font rendering differs between macOS and Linux CI",
);

// Visual regression baselines. Animations are disabled and dynamic regions
// (map tiles, photos, sidebar location list) are masked so the snapshots
// reflect only structural UI that we want to catch regressions in.
//
// Regenerate baselines locally with: npx playwright test --update-snapshots
// Tolerances are intentionally generous, these guard against layout shifts,
// not pixel-perfect rendering.

const SCREENSHOT_OPTIONS = {
  animations: "disabled" as const,
  maxDiffPixelRatio: 0.05,
};

test.describe("visual snapshots", () => {
  test("desktop, map loaded view (header + sidebar shell)", async ({
    page,
  }) => {
    await page.goto("/map");
    // Wait for the map to initialize
    await page
      .locator("button")
      .filter({ hasText: "Satellite" })
      .waitFor({ timeout: 20_000 });
    // Mask the map tiles, the location list (data-driven), and the satellite toggle
    await expect(page).toHaveScreenshot("map-desktop.png", {
      ...SCREENSHOT_OPTIONS,
      mask: [
        page.locator(".mapboxgl-canvas-container"),
        page.locator('.sidebar-desktop div[tabindex="-1"]'),
        page.locator(".stats-bar"),
      ],
    });
  });

  test("desktop, filter popover open", async ({ page }) => {
    await page.goto("/map");
    await page
      .locator("button")
      .filter({ hasText: "Satellite" })
      .waitFor({ timeout: 20_000 });
    const filterBtn = page
      .locator(".sidebar-desktop button")
      .filter({ hasText: "Filter" });
    test.skip(
      !(await filterBtn.isVisible()),
      "No locations in DB, filter hidden",
    );
    await filterBtn.click();
    await expect(page.getByText("All places")).toBeVisible();
    // Snapshot the popover region only
    const popover = page.locator(".sidebar-desktop").locator("..").first();
    await expect(popover).toHaveScreenshot("filter-popover-desktop.png", {
      ...SCREENSHOT_OPTIONS,
      mask: [
        page.locator(".mapboxgl-canvas-container"),
        page.locator('.sidebar-desktop div[tabindex="-1"]'),
      ],
    });
  });

  test("desktop, location card open", async ({ page }) => {
    await page.goto("/map");
    await page
      .locator("button")
      .filter({ hasText: "Satellite" })
      .waitFor({ timeout: 20_000 });
    const items = page.locator('.sidebar-desktop div[tabindex="-1"]');
    test.skip((await items.count()) === 0, "No locations in DB");
    await items.first().click();
    await expect(page.locator(".location-card")).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(400); // wait for fade-in
    // Mask the photo strip (signed URLs change every hour)
    await expect(page.locator(".location-card")).toHaveScreenshot(
      "location-card-desktop.png",
      {
        ...SCREENSHOT_OPTIONS,
        mask: [page.locator(".location-card img")],
      },
    );
  });
});

test.describe("visual snapshots, mobile", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("mobile, sheet open", async ({ page }) => {
    await page.goto("/map");
    await page
      .locator("button")
      .filter({ hasText: "Satellite" })
      .waitFor({ timeout: 20_000 });
    await page.locator(".mobile-places-btn").click();
    await expect(page.locator(".sidebar-mobile")).toBeVisible({
      timeout: 3_000,
    });
    await page.waitForTimeout(400); // sheet height transition
    await expect(page.locator(".sidebar-mobile")).toHaveScreenshot(
      "sheet-mobile.png",
      {
        ...SCREENSHOT_OPTIONS,
        mask: [
          page.locator('.sidebar-mobile div[tabindex="-1"]'),
          page.locator(".stats-bar"),
        ],
      },
    );
  });

  test("mobile, lightbox open", async ({ page }) => {
    await page.goto("/map");
    await page
      .locator("button")
      .filter({ hasText: "Satellite" })
      .waitFor({ timeout: 20_000 });
    await page.locator(".mobile-places-btn").click();
    const items = page.locator('.sidebar-mobile div[tabindex="-1"]');
    test.skip((await items.count()) === 0, "No locations in DB");
    await items.first().click();
    await expect(page.locator(".location-card")).toBeVisible({
      timeout: 5_000,
    });
    await page
      .locator(".location-card img")
      .first()
      .waitFor({ state: "attached", timeout: 8_000 })
      .catch(() => {});
    test.skip(
      (await page.locator(".location-card img").count()) === 0,
      "First location has no photos",
    );
    await expect(page.locator(".location-card img").first()).toBeVisible({
      timeout: 8_000,
    });
    const imgBBox = await page
      .locator(".location-card img")
      .first()
      .boundingBox();
    expect(imgBBox).not.toBeNull();
    await page.mouse.move(
      imgBBox!.x + imgBBox!.width / 2,
      imgBBox!.y + imgBBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator(".photo-lightbox")).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(300); // fade-in
    // Mask the actual photo (signed URL content varies)
    await expect(page.locator(".photo-lightbox")).toHaveScreenshot(
      "lightbox-mobile.png",
      {
        ...SCREENSHOT_OPTIONS,
        mask: [page.locator(".photo-lightbox img")],
      },
    );
  });
});
