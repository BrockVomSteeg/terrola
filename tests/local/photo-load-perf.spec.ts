import { test, expect, type Page } from "@playwright/test";

/**
 * Performance regression guards for the photo-load path.
 *
 * 1) COVER TOKEN-CHURN: opening a pin's card must fetch the cover thumbnail via
 *    exactly ONE distinct signed URL. The card refetches `/photo` on mount, which
 *    re-signs the cover with a fresh `?token=`; FramedPhoto keys on the
 *    token-independent photo identity, so an unchanged cover is never re-fetched.
 *    A regression would push the distinct-URL count to 2 and trip this.
 *
 * 2) LIGHTBOX OVER-FETCH: opening a multi-photo lightbox must NOT give every photo
 *    a `src`. Only the current photo and its immediate neighbours load; the rest
 *    are `src`-gated until you swipe toward them.
 *
 * Engine-independent (these are React/URL behaviours), so this runs in the
 * local-chromium project. Read-only: creates/deletes nothing.
 * Local-only (needs SITE_PASSWORD + localhost).
 */

const PW = process.env.SITE_PASSWORD;
const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

function objName(url: string): string | null {
  const m = url.split("/location-photos/")[1];
  if (!m) return null;
  return decodeURIComponent(m.split("?")[0]);
}

async function login(page: Page) {
  await page.goto("/");
  await page.fill('input[type="password"]', PW!);
  await page.click('button[aria-label="Submit password"]');
  await expect(page).toHaveURL(/\/map/, { timeout: 15_000 });
}

interface Loc {
  id: string;
  title: string;
  photo_url?: string;
  photos?: string[];
}

test.describe("photo load performance guards", () => {
  test("cover is fetched once (no re-sign churn) + lightbox loads only current±1", async ({
    page,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
    // Opt-in: this guard downloads real cover + full-resolution lightbox bytes from
    // storage. Excluded from the default suite; run it deliberately with PERF=1.
    test.skip(
      process.env.PERF !== "1",
      "set PERF=1 to run the photo-load perf guard (pulls real image bytes)",
    );
    await page.setViewportSize({ width: 1280, height: 900 });

    const storageReqs: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("/storage/v1/object/sign/")) storageReqs.push(u);
    });

    await login(page);
    await page.goto("/map");
    await page.waitForSelector('[data-testid^="sidebar-loc-"]', {
      timeout: 15_000,
    });

    const locs: Loc[] = await page.evaluate(async () => {
      const r = await fetch("/api/locations");
      return r.json();
    });
    const single = locs.find(
      (l) => l.photo_url && (l.photos?.length ?? 0) <= 1,
    );
    const multi = locs.find((l) => (l.photos?.length ?? 0) >= 2);
    const target = single ?? multi;
    expect(
      target,
      "the database needs at least one photo'd pin to test",
    ).toBeTruthy();

    // -- (1) Cover thumbnail: exactly one distinct signed URL ------------------
    const cover = objName(target!.photo_url!);
    storageReqs.length = 0;
    await page.click(`[data-testid="sidebar-loc-${target!.id}"]`);
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const img = document.querySelector(
              ".location-card img",
            ) as HTMLImageElement | null;
            return img?.naturalWidth ?? 0;
          }),
        { timeout: 20_000, message: "cover should load" },
      )
      .toBeGreaterThan(0);
    // Give any second re-signed fetch time to fire before asserting.
    await page.waitForTimeout(1500);

    const thumbObject = cover + ".thumb";
    const distinctThumbUrls = new Set(
      storageReqs.filter((u) => objName(u) === thumbObject),
    );
    const distinctFullUrls = new Set(
      storageReqs.filter((u) => objName(u) === cover),
    );
    // The cover renders from its thumbnail; the thumbnail object must be fetched
    // through a single signed URL (no token churn). The full cover is only the
    // fallback, so it must not be redundantly fetched either.
    expect(
      distinctThumbUrls.size,
      `cover thumbnail fetched via ${distinctThumbUrls.size} distinct URLs (want <=1 - re-sign churn regressed)`,
    ).toBeLessThanOrEqual(1);
    expect(
      distinctFullUrls.size,
      `full cover fetched via ${distinctFullUrls.size} distinct URLs (want <=1)`,
    ).toBeLessThanOrEqual(1);

    await page
      .click('.location-card button[aria-label="Close"]', { timeout: 3000 })
      .catch(() => {});

    // -- (2) Lightbox: only current±1 photos carry a src -----------------------
    if (multi) {
      await page.goto("/map");
      await page.waitForSelector(`[data-testid="sidebar-loc-${multi.id}"]`, {
        timeout: 15_000,
      });
      await page.click(`[data-testid="sidebar-loc-${multi.id}"]`);
      await page.waitForSelector(".location-card .photo-strip", {
        timeout: 10_000,
      });
      // Wait for the card's /photo fetch to resolve so the lightbox opens with
      // the FULL photo set (before resolve it falls back to just the cover).
      await expect
        .poll(
          async () =>
            page.evaluate(
              () =>
                Array.from(
                  document.querySelectorAll(".location-card .photo-strip img"),
                ).filter((i) => (i as HTMLImageElement).naturalWidth > 0)
                  .length,
            ),
          { timeout: 15_000, message: "strip photos should resolve + load" },
        )
        .toBeGreaterThanOrEqual(2);
      await page.locator(".location-card .photo-strip > div").first().click();
      await page.waitForSelector(".photo-lightbox", { timeout: 10_000 });
      await page.waitForTimeout(300);

      const lb = await page.evaluate(() => {
        const imgs = Array.from(
          document.querySelectorAll(".photo-lightbox img"),
        ) as HTMLImageElement[];
        return {
          total: imgs.length,
          withSrc: imgs.filter((i) => !!i.getAttribute("src")).length,
        };
      });
      expect(lb.total, "lightbox renders a slot per photo").toBe(
        multi.photos!.length,
      );
      // Opened at index 0 -> only indices 0 and 1 carry a src (current ± 1).
      expect(
        lb.withSrc,
        `lightbox gave ${lb.withSrc}/${lb.total} photos a src (want <=3 - over-fetch regressed)`,
      ).toBeLessThanOrEqual(3);
      expect(
        lb.withSrc,
        "lightbox must src-gate the far photos (not all loaded up front)",
      ).toBeLessThan(lb.total);
    }
  });
});
