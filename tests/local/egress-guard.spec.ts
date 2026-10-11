import { test, expect, type Page } from "@playwright/test";
import { signedUrlExpiryMs } from "../../lib/photos";

/**
 * EGRESS GUARD (regression). A cold `/map` load must fire ZERO full-resolution
 * image GETs (only the small prefetch thumbnails) and trip if any change
 * introduces full-cover fetching on load, which would re-download every full
 * cover from storage on each mount.
 *
 * Pulls ZERO real image bytes: every storage object GET is intercepted and
 * fulfilled with a 1x1 stub. The only real database egress is the tiny
 * `/api/locations` JSON read.
 *
 * Local-only (needs SITE_PASSWORD + localhost), engine-independent.
 */

const PW = process.env.SITE_PASSWORD;
const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

// 1x1 transparent PNG - enough for an <img> to "load" without pulling real bytes.
const STUB_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function classifyTier(url: string): "thumb" | "card" | "full" | "other" {
  const path = url.split("?")[0];
  if (!path.includes("/location-photos/")) return "other";
  if (path.endsWith(".thumb")) return "thumb";
  if (path.endsWith(".card")) return "card";
  return "full";
}

async function login(page: Page) {
  await page.goto("/");
  await page.fill('input[type="password"]', PW!);
  await page.click('button[aria-label="Submit password"]');
  await expect(page).toHaveURL(/\/map/, { timeout: 15_000 });
}

test.describe("egress guard - no full-image fetch on /map load", () => {
  test("cold /map idle fires ZERO full-resolution Supabase image GETs", async ({
    page,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");

    const gets = { thumb: 0, card: 0, full: 0, other: 0 };
    const fullPaths: string[] = [];

    // Intercept ALL Supabase Storage object requests BEFORE any navigation, count
    // GETs by tier, and fulfill each with a 1x1 stub so NO real image bytes flow.
    await page.route("**/storage/v1/object/**", async (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        const k = classifyTier(req.url());
        gets[k]++;
        if (k === "full") fullPaths.push(req.url().split("?")[0]);
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          body: STUB_PNG,
        });
        return;
      }
      await route.continue();
    });

    await login(page);
    await page.goto("/map");
    // Wait past the prefetch (600 ms) and any idle-time work so a regression that
    // fetches a full cover on idle is caught.
    await page.waitForTimeout(6000);

    console.log(
      `[[egress-guard]] /map GETs by tier: ${JSON.stringify(gets)}` +
        (fullPaths.length ? ` fullPaths=${JSON.stringify(fullPaths)}` : ""),
    );

    expect(
      gets.full,
      `cold /map load fetched ${gets.full} FULL-resolution image(s) - a ` +
        `full-image-on-load path regressed: ${fullPaths.join(", ")}`,
    ).toBe(0);
  });

  /**
   * Long-TTL REUSED signed URLs: two consecutive `/api/locations` reads must
   * return BYTE-IDENTICAL cover/thumb/card URL strings (same `?token=`), and the
   * tokens must be long-lived, so the browser HTTP cache can serve them.
   * Zero image bytes: only the small JSON list read, twice.
   */
  test("signed READ URLs are long-TTL and REUSED across consecutive reads", async ({
    page,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");

    await login(page);
    type Row = {
      id: string;
      photo_url?: string | null;
      photo_thumb_url?: string | null;
      photo_card_url?: string | null;
    };
    const read = async (): Promise<Row[]> => {
      const res = await page.request.get("/api/locations");
      expect(res.ok()).toBe(true);
      return res.json();
    };

    const first = await read();
    const withCover = first.filter((l) => l.photo_url);
    expect(
      withCover.length,
      "need at least one cover to prove reuse",
    ).toBeGreaterThan(0);

    const second = await read();
    const secondById = new Map(second.map((l) => [l.id, l]));
    for (const l of withCover) {
      const again = secondById.get(l.id);
      expect(again, `location ${l.id} vanished between reads`).toBeTruthy();
      expect(again!.photo_url, `cover URL rotated for ${l.id}`).toBe(
        l.photo_url,
      );
      expect(again!.photo_thumb_url, `thumb URL rotated for ${l.id}`).toBe(
        l.photo_thumb_url,
      );
      expect(again!.photo_card_url, `card URL rotated for ${l.id}`).toBe(
        l.photo_card_url,
      );
    }

    // Tokens must be long-lived (30d, re-signed under 3d left), not 1h.
    //
    // The bar is the re-sign threshold, not ">20 days": a persisted URL is served
    // back byte-identical until it is nearly expired, so a healthy URL spends most
    // of its life between 3 and 30 days remaining. 1 hour is far below this bar,
    // so a short-TTL regression is still caught.
    const RESIGN_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
    const exp = signedUrlExpiryMs(withCover[0].photo_url);
    expect(exp, "cover URL must carry a parseable token expiry").not.toBeNull();
    expect(
      exp! - Date.now(),
      "cover token TTL must be long-lived and above the re-sign threshold, not a 1h token",
    ).toBeGreaterThan(RESIGN_THRESHOLD_MS);
    expect(
      exp! - Date.now(),
      "cover token TTL cannot exceed the 30-day mint",
    ).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000);
  });
});
