import { test, expect } from "@playwright/test";
import { BRAND } from "../../lib/brand";

// ─── Password gate (unauthenticated) ────────────────────────────────────────

test.describe("password gate", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("shows password input on homepage", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(
      page.locator('button[aria-label="Submit password"]'),
    ).toBeVisible();
  });

  test("rejects wrong password, input clears", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[type="password"]', "thisisnotthepassword");
    await page.click('button[aria-label="Submit password"]');
    // On wrong password the component clears the input (shake + reset)
    await expect(page.locator('input[type="password"]')).toHaveValue("", {
      timeout: 5_000,
    });
    // Should remain on homepage, not redirected
    await expect(page).toHaveURL("/");
  });

  test("redirects to /map after correct password", async ({ page }) => {
    const password = process.env.SITE_PASSWORD;
    test.skip(!password, "SITE_PASSWORD not set");
    await page.goto("/");
    await page.fill('input[type="password"]', password!);
    await page.click('button[aria-label="Submit password"]');
    await expect(page).toHaveURL(/\/map/, { timeout: 10_000 });
  });
});

// ─── Map (authenticated via storageState from setup project) ────────────────

test.describe("map", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/map");
  });

  test("header and map container render", async ({ page }) => {
    await expect(page.locator("header.map-header")).toBeVisible();
    await expect(page.locator(".map-with-drawer")).toBeVisible();
    // Mobile title button + desktop h1 both show the product name
    await expect(page.locator("header.map-header")).toContainText(BRAND.name);
  });

  test("map fully initializes, satellite toggle appears", async ({ page }) => {
    // Satellite button is rendered only after mapLoaded=true
    await expect(
      page.getByRole("button", { name: /switch to (satellite|map) view/i }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("satellite toggle switches map style and back", async ({ page }) => {
    const satBtn = page.getByRole("button", {
      name: /switch to (satellite|map) view/i,
    });
    await satBtn.waitFor({ timeout: 20_000 });
    await satBtn.click();
    // After toggle the style button's label flips to "Switch to map view".
    // Use the precise "switch to ..." name so it doesn't also match the Sidebar's
    // "Map view" (Map/Timeline) button.
    const mapBtn = page.getByRole("button", { name: /switch to map view/i });
    await expect(mapBtn).toBeVisible({ timeout: 10_000 });
    // Toggle back
    await mapBtn.click();
    await expect(
      page.getByRole("button", { name: /switch to (satellite|map) view/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("desktop sidebar shows product name heading", async ({ page }) => {
    await expect(page.locator(".sidebar-desktop h1")).toHaveText(BRAND.name);
  });

  test("filter button opens category popover", async ({ page }) => {
    // Wait for map to finish loading first
    await page
      .getByRole("button", { name: /switch to (satellite|map) view/i })
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
    // Dismiss
    await page.keyboard.press("Escape");
  });

  test("clicking a sidebar location opens location card", async ({ page }) => {
    await page
      .getByRole("button", { name: /switch to (satellite|map) view/i })
      .waitFor({ timeout: 20_000 });
    const sidebarItems = page.locator('.sidebar-desktop div[tabindex="-1"]');
    test.skip((await sidebarItems.count()) === 0, "No locations in DB");
    const first = sidebarItems.first();
    const titleText = await first.locator("p").first().textContent();
    await first.click();
    // Location card is fixed over the map, the title appears in it
    if (titleText?.trim()) {
      await expect(
        page.locator(`text="${titleText.trim()}"`).last(),
      ).toBeVisible({ timeout: 5_000 });
    }
  });

  test("photo strip renders inside location card", async ({ page }) => {
    await page
      .getByRole("button", { name: /switch to (satellite|map) view/i })
      .waitFor({ timeout: 20_000 });
    const sidebarItems = page.locator('.sidebar-desktop div[tabindex="-1"]');
    test.skip((await sidebarItems.count()) === 0, "No locations in DB");
    await sidebarItems.first().click();
    // Wait for LocationCard to animate in (visible=true after 10ms)
    await page.waitForTimeout(500);
    // Photo strip container, only present when photos exist
    const photoStrip = page.locator(".photo-strip");
    if (await photoStrip.isVisible()) {
      await expect(photoStrip).toBeVisible();
      await expect(photoStrip.locator("img").first()).toBeVisible();
    } else {
      // No photos on this location, still a valid state
      test.skip(true, "First location has no photos");
    }
  });
});

// ─── Mobile viewport ─────────────────────────────────────────────────────────

test.describe("mobile viewport", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await page.goto("/map");
    // Wait for map to fully initialize before each test
    await page
      .getByRole("button", { name: /switch to (satellite|map) view/i })
      .waitFor({ timeout: 20_000 });
  });

  test("photo strip click opens lightbox", async ({ page }) => {
    // Open the mobile bottom sheet
    await page.locator(".mobile-places-btn").click();
    await expect(page.locator(".sidebar-mobile")).toBeVisible({
      timeout: 3_000,
    });

    const items = page.locator('.sidebar-mobile div[tabindex="-1"]');
    test.skip((await items.count()) === 0, "No locations in DB");

    // Select first location, closes sheet, renders LocationCard
    await items.first().click();
    await expect(page.locator(".location-card")).toBeVisible({
      timeout: 5_000,
    });

    // LocationCard fetches signed photo URLs async; wait for at least one img to attach
    await page
      .locator(".location-card img")
      .first()
      .waitFor({ state: "attached", timeout: 8_000 })
      .catch(() => {});
    test.skip(
      (await page.locator(".location-card img").count()) === 0,
      "First location has no photos",
    );

    // Wait for image to load (opacity flips 0→1 after onLoad)
    await expect(page.locator(".location-card img").first()).toBeVisible({
      timeout: 8_000,
    });

    // CDP-injected mouse events are trusted and reliably fire pointerdown/pointerup
    // in Chrome touch-emulation mode; untrusted dispatchEvent() PointerEvents
    // are silently ignored by React's delegation in hasTouch contexts.
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
  });

  test("places sheet opens and closes via downward drag", async ({ page }) => {
    // Sheet is closed initially. Playwright's isVisible() returns true even when
    // height:0 because rect.width>0. toHaveCSS returns "1px" (not "0px") due to
    // box-sizing:border-box + border-top:1px. Check the DOM style attribute
    // directly, that is what React writes, unaffected by layout resolution.
    await expect(page.locator(".sidebar-mobile")).toHaveAttribute(
      "style",
      /height:\s*0px/,
    );

    // Tap the floating pill to open the sheet
    await page.locator(".mobile-places-btn").click();
    await expect(page.locator(".sidebar-mobile")).not.toHaveAttribute(
      "style",
      /height:\s*0px/,
      { timeout: 3_000 },
    );

    // Simulate a 150px downward touch drag, exceeds the 120px dismiss threshold
    const box = await page.locator(".sidebar-mobile").boundingBox();
    const cx = box!.x + box!.width / 2;
    const startY = box!.y + 60; // start near the top of the sheet

    await page.evaluate(
      ({ cx, startY }) => {
        const el = document.querySelector(".sidebar-mobile")!;
        const mk = (y: number) =>
          new Touch({
            identifier: 1,
            target: el,
            clientX: cx,
            clientY: y,
            radiusX: 1,
            radiusY: 1,
            rotationAngle: 0,
            force: 1,
          });
        // touchstart sets dragStartY ref in React handler
        el.dispatchEvent(
          new TouchEvent("touchstart", {
            bubbles: true,
            cancelable: true,
            touches: [mk(startY)],
          }),
        );
        // touchmove updates dragYRef (raw listener, passive:false)
        el.dispatchEvent(
          new TouchEvent("touchmove", {
            bubbles: true,
            cancelable: true,
            touches: [mk(startY + 150)],
          }),
        );
        // touchend: dragYRef > 120 → onMobileToggle() → sidebarMobileOpen=false
        el.dispatchEvent(
          new TouchEvent("touchend", {
            bubbles: true,
            cancelable: true,
            changedTouches: [mk(startY + 150)],
          }),
        );
      },
      { cx, startY },
    );

    // After dismiss React sets height:"0px" in the inline style (CSS transition
    // takes 300ms to animate but the attribute flips immediately on render).
    await expect(page.locator(".sidebar-mobile")).toHaveAttribute(
      "style",
      /height:\s*0px/,
      { timeout: 3_000 },
    );
  });

  test("filter popover shows all 8 category rows and closes on outside tap", async ({
    page,
  }) => {
    // Open mobile sheet and wait for the CSS height transition to complete
    await page.locator(".mobile-places-btn").click();
    await expect(page.locator(".sidebar-mobile")).not.toHaveCSS(
      "height",
      "0px",
      {
        timeout: 3_000,
      },
    );

    const filterBtn = page
      .locator(".sidebar-mobile button")
      .filter({ hasText: "Filter" });
    // count() === 0 means no locations in DB (filter only renders when locations exist)
    test.skip(
      (await filterBtn.count()) === 0,
      "No locations in DB, filter hidden",
    );

    // Open the filter popover (Playwright waits for button to be stable/actionable)
    await filterBtn.click({ timeout: 5_000 });
    await expect(
      page.locator(".sidebar-mobile").getByText("All places", { exact: true }),
    ).toBeVisible();

    // All 8 category label spans must be visible (each label lives in its own span)
    for (const label of [
      "Food",
      "Night Out",
      "Everyday",
      "Beach",
      "Adventure",
      "Trip",
      "Celebration",
      "Milestone",
    ]) {
      await expect(
        page.locator(".sidebar-mobile").getByText(label, { exact: true }),
      ).toBeVisible();
    }

    // Tap the product name heading (outside filterRef) to close the popover
    await page.locator(".sidebar-mobile h1").click();
    await expect(
      page.locator(".sidebar-mobile").getByText("All places", { exact: true }),
    ).not.toBeVisible({ timeout: 3_000 });
  });

  // Root cause of the original failure was an AMBIGUOUS locator, NOT the
  // viewport (this describe already runs at 375px). `/satellite view|map view/i`
  // also matches the Sidebar's "Map view" (Map/Timeline) button, so boundingBox()
  // resolved to the wrong element on the right (x≈294) and the assertion failed.
  // The MapCanvas style toggle carries the unique "Switch to ..." label, target it
  // precisely. On mobile it sits top-left (measured x≈12, y≈64).
  test("satellite (map-style) toggle is top-left on mobile viewport", async ({
    page,
  }) => {
    const styleToggle = page.getByRole("button", {
      name: /switch to (satellite|map) view/i,
    });
    await styleToggle.waitFor({ timeout: 20_000 });
    const box = await styleToggle.boundingBox();
    expect(box).not.toBeNull();
    // mobile breakpoint → rendered at left:12px, not right-side
    expect(box!.x).toBeLessThan(375 / 2);
    // near the top (52px header + 12px gap), not in the bottom sheet zone
    expect(box!.y).toBeLessThan(400);
  });
});
