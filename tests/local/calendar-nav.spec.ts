import { test, expect, type Page } from "@playwright/test";

/**
 * Tapping a date in the calendar/timeline must, in ONE action, close the sheet
 * (mobile), fly the map there, and OPEN that location's card.
 *
 * On mobile the timeline row tap both closes the sheet and selects the row; the
 * close must be deterministic so a batched toggle cannot flip the sheet back open
 * and clear the selection (which would leave the card unopened).
 *
 * Local-only (needs SITE_PASSWORD + localhost). Throwaway hard-deleted in finally.
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

async function createRow(
  page: Page,
  base: string,
  headers: Record<string, string>,
) {
  const loc = await (
    await page.request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pwcal__",
        date_label: "2099-12-31", // sorts to the top of the timeline
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    })
  ).json();
  return loc.id as string;
}

test.describe("timeline date tap flies + opens the card", () => {
  test("mobile: tap a date closes the sheet and opens that pin's card", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
    await page.setViewportSize({ width: 375, height: 812 });
    const base = baseURL || "http://localhost:3000";
    await login(page);
    const cookies = await context.cookies();
    const csrf = cookies.find((c) => c.name === "app_csrf")?.value ?? "";
    const headers = {
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    };

    const id = await createRow(page, base, headers);
    try {
      expect(id, "throwaway created").toBeTruthy();
      await page.goto("/map");
      await page.waitForTimeout(1000);

      // Open the mobile sheet, switch to the timeline view.
      await page.locator(".mobile-places-btn").click();
      await page.waitForTimeout(400);
      await page.locator('button[aria-label="Timeline view"]:visible').click();
      await page.waitForTimeout(300);

      const row = page.locator(`[data-testid="timeline-row-${id}"]:visible`);
      await expect(row).toBeVisible({ timeout: 6000 });

      // Tap the date.
      await row.click();
      await page.waitForTimeout(600);

      // The card for THIS location is open...
      const card = page.locator(".location-card");
      await expect(card).toBeVisible({ timeout: 6000 });
      await expect(card.getByText("__pwcal__")).toBeVisible();
      // ...and the sheet closed (did NOT flip back open). The places button
      // renders ONLY when the mobile sheet is closed, so its return is the
      // semantic proof the sheet collapsed.
      await expect(page.locator(".mobile-places-btn")).toBeVisible({
        timeout: 4000,
      });
    } finally {
      await page.request
        .delete(`${base}/api/locations/${id}`, { headers })
        .catch(() => {});
    }
  });

  test("desktop: tap a date opens that pin's card (no regression)", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
    await page.setViewportSize({ width: 1280, height: 900 });
    const base = baseURL || "http://localhost:3000";
    await login(page);
    const cookies = await context.cookies();
    const csrf = cookies.find((c) => c.name === "app_csrf")?.value ?? "";
    const headers = {
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    };

    const id = await createRow(page, base, headers);
    try {
      expect(id, "throwaway created").toBeTruthy();
      await page.goto("/map");
      await page.waitForTimeout(1000);

      // Desktop sidebar is always visible - switch to timeline + tap the row.
      await page.locator('button[aria-label="Timeline view"]:visible').click();
      await page.waitForTimeout(300);
      const row = page.locator(`[data-testid="timeline-row-${id}"]:visible`);
      await expect(row).toBeVisible({ timeout: 6000 });
      await row.click();
      await page.waitForTimeout(500);

      const card = page.locator(".location-card");
      await expect(card).toBeVisible({ timeout: 6000 });
      await expect(card.getByText("__pwcal__")).toBeVisible();
    } finally {
      await page.request
        .delete(`${base}/api/locations/${id}`, { headers })
        .catch(() => {});
    }
  });
});
