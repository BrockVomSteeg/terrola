import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// SPEC R13: automated accessibility checks on the live demo, on load and after the
// interactions a visitor makes. Runs with playwright.e2e.config.ts against the deployed
// demo (the map needs the demo token). See docs/accessibility.md for what this misses.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

// Nodes inside the map library's own canvas or controls that we cannot change. Add a
// selector here only for a violation seen in a real run that comes from that code, with
// a comment naming the rule and the run. Empty on purpose: nothing is excluded until a
// run shows the need.
const THIRD_PARTY_EXCLUDES: readonly string[] = [];

/** Runs axe on the whole page and fails on any violation, with a readable list. */
async function expectNoViolations(page: Page, state: string) {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  for (const selector of THIRD_PARTY_EXCLUDES) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();

  await test.info().attach(`axe-${state}.json`, {
    body: JSON.stringify(violations, null, 2),
    contentType: "application/json",
  });

  const summary = violations.map(
    (v) =>
      `${v.id} (${v.impact ?? "unknown"}): ${v.help}. Nodes: ${v.nodes
        .map((n) => n.target.join(" "))
        .join(", ")}`,
  );
  expect(summary, `axe violations on "${state}"`).toEqual([]);
}

/** The style toggle renders only after the map has loaded, so it proves the map drew. */
async function waitForMap(page: Page) {
  await page.goto("/map");
  await expect(
    page.getByRole("button", { name: /switch to (satellite|map) view/i }),
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * Waits until an element is fully shown: present, opacity 1 and no running animation or
 * transition in it. Contrast checks on a half faded element give false results.
 */
async function settle(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      if (getComputedStyle(el).opacity !== "1") return false;
      return el
        .getAnimations({ subtree: true })
        .every((a) => a.playState !== "running");
    },
    selector,
    { timeout: 10_000 },
  );
}

const placeRows = (page: Page, list: ".sidebar-desktop" | ".sidebar-mobile") =>
  page.locator(`${list} [data-testid^="sidebar-loc-"]`);

test.describe("desktop", () => {
  test("map page on load", async ({ page }) => {
    await waitForMap(page);
    await expectNoViolations(page, "desktop-map-load");
  });

  test("place card opened from the list", async ({ page }) => {
    await waitForMap(page);
    const rows = placeRows(page, ".sidebar-desktop");
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await expect(page.locator(".location-card")).toBeVisible({ timeout: 5_000 });
    await settle(page, ".location-card");
    await expectNoViolations(page, "desktop-place-card");
  });

  test("photo lightbox", async ({ page }) => {
    await waitForMap(page);
    const rows = placeRows(page, ".sidebar-desktop");
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await expect(page.locator(".location-card")).toBeVisible({ timeout: 5_000 });

    const photo = page.locator(".location-card img").first();
    await photo.waitFor({ state: "attached", timeout: 8_000 }).catch(() => {});
    test.skip(
      (await page.locator(".location-card img").count()) === 0,
      "The first place has no photo, so the lightbox cannot be reached",
    );
    await photo.click();
    await expect(page.locator(".photo-lightbox")).toBeVisible({ timeout: 5_000 });
    await settle(page, ".photo-lightbox");
    await expectNoViolations(page, "desktop-lightbox");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("map page on load", async ({ page }) => {
    await waitForMap(page);
    await expectNoViolations(page, "phone-map-load");
  });

  test("list view", async ({ page }) => {
    await waitForMap(page);
    await page.locator(".mobile-places-btn").click();
    // React writes height 0px while the sheet is closed (see tests/e2e/map.spec.ts).
    await expect(page.locator(".sidebar-mobile")).not.toHaveAttribute(
      "style",
      /height:\s*0px/,
      { timeout: 3_000 },
    );
    await settle(page, ".sidebar-mobile");
    await expect(placeRows(page, ".sidebar-mobile").first()).toBeVisible();
    await expectNoViolations(page, "phone-list");
  });

  test("place card opened from the list", async ({ page }) => {
    await waitForMap(page);
    await page.locator(".mobile-places-btn").click();
    const rows = placeRows(page, ".sidebar-mobile");
    await expect(rows.first()).toBeVisible({ timeout: 3_000 });
    await rows.first().click();
    await expect(page.locator(".location-card")).toBeVisible({ timeout: 5_000 });
    await settle(page, ".location-card");
    await expectNoViolations(page, "phone-place-card");
  });
});
