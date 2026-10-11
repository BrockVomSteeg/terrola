import { test, expect, type Page } from "@playwright/test";

/**
 * Blur-up regression guards. The card-photo load must:
 *   (i)   NEVER show the category emoji for a pin that HAS a photo (a transient
 *         load error must not collapse the photo to the emoji);
 *   (ii)  ALWAYS replace its placeholder with the sharp image - no stuck-blur
 *         (the sharp <img> loads and reaches opacity 1; any LQIP fades to 0);
 *   (iii) end on a RIGHT-SIZED image (the ~1152px `.card`, or the full as a
 *         pre-backfill fallback) - NEVER stuck on the 600px thumb.
 *
 * Engine-independent (React/URL/DOM behaviour), so these run in the default
 * local-chromium gate. Read-only - opens existing photo'd pins, creates nothing.
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
  lat?: number;
  lng?: number;
}

// A seeded pin, never a sibling test's throwaway (`__pw...__`), whose photo
// objects may be mid-delete and would (correctly) error to the emoji.
function isReal(l: Loc): boolean {
  return !(l.title ?? "").startsWith("__pw") && !(l.lat === 0 && l.lng === 0);
}

async function realLocations(page: Page): Promise<Loc[]> {
  const locs: Loc[] = await page.evaluate(async () => {
    const r = await fetch("/api/locations");
    return r.json();
  });
  return locs.filter(isReal);
}

async function firstPhotoPin(page: Page): Promise<Loc> {
  const locs = await realLocations(page);
  // Prefer a single-photo pin (simplest DOM); fall back to any photo'd pin.
  const single = locs.find((l) => l.photo_url && (l.photos?.length ?? 0) <= 1);
  const target = single ?? locs.find((l) => !!l.photo_url);
  expect(
    target,
    "the database needs at least one photo'd pin to test",
  ).toBeTruthy();
  return target!;
}

test.describe("photo blur-up", () => {
  test("photo'd pin: no category-emoji placeholder, no stuck-blur, right-sized sharp", async ({
    page,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
    // Real Supabase image downloads + a possible first-run `.card`/`.thumb`
    // backfill storm (saturates bandwidth) make this legitimately slow on a cold
    // run; it is fast once derivatives exist.
    test.slow();
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

    const target = await firstPhotoPin(page);
    const cover = objName(target.photo_url!);
    storageReqs.length = 0;
    await page.click(`[data-testid="sidebar-loc-${target.id}"]`);

    // The SHARP image is the only non-aria-hidden <img> in the card (the LQIP +
    // thumb placeholder are aria-hidden). Wait for it to actually decode.
    const sharp = page.locator(".location-card img:not([aria-hidden])").first();
    await expect
      .poll(
        async () =>
          sharp.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 45_000, message: "sharp card image should load" },
      )
      .toBeGreaterThan(0);

    // (ii) no stuck-blur - the sharp image is fully opaque (faded in), and any
    // LQIP placeholder has faded out.
    await expect
      .poll(
        async () =>
          sharp.evaluate((el) =>
            parseFloat(getComputedStyle(el as HTMLImageElement).opacity),
          ),
        { timeout: 5_000, message: "sharp image should fade fully in" },
      )
      .toBeGreaterThan(0.99);

    // LQIP is OFF by default -> no framed-lqip element. Check count FIRST so we
    // never call locator.evaluate() on an absent element (it auto-waits for the
    // whole test budget). When present (LQIP enabled), it must have faded to 0.
    const lqipLoc = page.locator('.location-card [data-testid="framed-lqip"]');
    const lqipOpacity =
      (await lqipLoc.count()) === 0
        ? 0
        : await lqipLoc
            .first()
            .evaluate((el) => parseFloat(getComputedStyle(el).opacity));
    expect(lqipOpacity, "LQIP blur must fade out once the sharp loads").toBe(0);

    // (i) the category emoji must NEVER appear for a photo'd pin.
    expect(
      await page.locator('.location-card [data-testid="framed-emoji"]').count(),
      "a photo'd pin must never fall back to the category emoji",
    ).toBe(0);

    // (iii) right-sized - the final sharp image is NOT the 600px thumb. The
    // `.card` tier is ~1152px; the full fallback is larger still. The thumb
    // (600px longest side) would fail this.
    const sharpW = await sharp.evaluate(
      (el) => (el as HTMLImageElement).naturalWidth,
    );
    expect(
      sharpW,
      `card sharp image is ${sharpW}px - want >700 (stuck on the 600px thumb = regression)`,
    ).toBeGreaterThan(700);

    // ...and the card actually fetched a sharp tier (the `.card` image when it
    // exists, else the full) - not ONLY the tiny thumb.
    const sharpTierFetched = storageReqs.some((u) => {
      const n = objName(u);
      return n === cover || n === cover + ".card";
    });
    expect(
      sharpTierFetched,
      "the card must fetch a sharp tier (.card or full), not only the thumb",
    ).toBe(true);
  });

  test("multi-photo strip: cover sharpens, no emoji on any visible slot", async ({
    page,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
    test.slow();
    await page.setViewportSize({ width: 1280, height: 900 });

    await login(page);
    await page.goto("/map");
    await page.waitForSelector('[data-testid^="sidebar-loc-"]', {
      timeout: 15_000,
    });

    const locs = await realLocations(page);
    const multi = locs.find((l) => (l.photos?.length ?? 0) >= 2);
    test.skip(!multi, "no multi-photo pin to test");

    await page.click(`[data-testid="sidebar-loc-${multi!.id}"]`);
    await page.waitForSelector(".location-card .photo-strip", {
      timeout: 10_000,
    });

    // The first (visible) strip slot sharpens to its card image (>700px) - the
    // active slot upgrades; off-screen slots stay on the cheap thumb.
    const firstSharp = page
      .locator(".location-card .photo-strip img:not([aria-hidden])")
      .first();
    await expect
      .poll(
        async () =>
          firstSharp.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 45_000, message: "visible strip cover should sharpen" },
      )
      .toBeGreaterThan(700);

    expect(
      await page.locator('.location-card [data-testid="framed-emoji"]').count(),
      "no visible strip slot may show the category emoji",
    ).toBe(0);
  });
});
