import { test, expect } from "@playwright/test";

/**
 * Reframe WYSIWYG. The editor preview frame must match the aspect of the surface
 * the photo actually lands on (single-photo card cover ~2.1:1), so "what you
 * frame" is "what you see". Also locks per-photo persistence for a NON-cover
 * photo reframed via the real gesture (the "multi-photo offsets" path).
 *
 * Local-only (needs SITE_PASSWORD + localhost). Throwaways hard-deleted in finally.
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

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.fill('input[type="password"]', PW!);
  await page.click('button[aria-label="Submit password"]');
  await expect(page).toHaveURL(/\/map/, { timeout: 15_000 });
}

// Desktop so the throwaway pin is selectable by sidebar id.
test.use({ viewport: { width: 1280, height: 900 }, hasTouch: true });

test("reframe preview frame matches the single-photo card cover aspect (WYSIWYG)", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
  const base = baseURL || "http://localhost:3000";
  await login(page);
  const cookies = await context.cookies();
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
          title: "__pwasp__",
          date_label: "2020-01-01",
          lat: 0,
          lng: 0,
          category: "beach",
        },
      })
    ).json();
    created.id = loc.id;
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

    await page.goto("/map");
    await page
      .locator(`[data-testid="sidebar-loc-${created.id}"]:visible`)
      .first()
      .click();
    const card = page.locator(".location-card");
    await expect(card).toBeVisible({ timeout: 6000 });
    const coverBox = (await card
      .locator("img:not([aria-hidden])")
      .first()
      .boundingBox())!;
    const cardAspect = coverBox.width / coverBox.height;

    await card.getByTitle("Edit this place").click();
    const thumbs = page.getByTestId("edit-photo-thumb");
    await expect(thumbs.first()).toBeVisible({ timeout: 6000 });
    await thumbs.first().click();
    const frame = page.getByTestId("reframe-frame");
    await expect(frame).toBeVisible({ timeout: 5000 });
    const fb = (await frame.boundingBox())!;
    const frameAspect = fb.width / fb.height;

    // The reframe frame must match the card cover aspect within tolerance, so the
    // crop you set is the crop the card renders. (A fixed 1.65:1 frame against
    // the ~2.1:1 cover would be a ~28% mismatch.)
    const relErr = Math.abs(frameAspect - cardAspect) / cardAspect;
    expect(
      relErr,
      `frameAspect=${frameAspect.toFixed(3)} cardAspect=${cardAspect.toFixed(3)}`,
    ).toBeLessThan(0.08);
  } finally {
    if (created.id) {
      for (const p of created.files)
        await req
          .delete(
            `${base}/api/locations/${created.id}/photo?filename=${encodeURIComponent(nameOf(p)!)}`,
            { headers },
          )
          .catch(() => {});
      await req
        .delete(`${base}/api/locations/${created.id}`, { headers })
        .catch(() => {});
    }
  }
});

test("reframing a NON-cover photo persists under that photo's key only", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
  const base = baseURL || "http://localhost:3000";
  await login(page);
  const cookies = await context.cookies();
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
          title: "__pwnoncover__",
          date_label: "2020-01-01",
          lat: 0,
          lng: 0,
          category: "concert",
        },
      })
    ).json();
    created.id = loc.id;
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

    await page.goto("/map");
    await page.getByTestId("admin-fab").click();
    await page
      .getByTestId(`manage-row-${created.id}`)
      .getByTitle("Edit this place")
      .click();
    const thumbs = page.getByTestId("edit-photo-thumb");
    await expect(thumbs).toHaveCount(2, { timeout: 10_000 });

    // Reframe the SECOND thumb (photo B, not the cover) via a real drag.
    await thumbs.nth(1).click(); // quick tap -> reframe
    const frame = page.getByTestId("reframe-frame");
    await expect(frame).toBeVisible({ timeout: 5000 });
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
    for (let i = 1; i <= 8; i++) await page.mouse.move(cx - i * 7, cy - i * 3);
    await page.mouse.up();
    await page.getByTestId("reframe-save").click();
    await expect(frame).toBeHidden({ timeout: 5000 });

    const after = await (
      await req.get(`${base}/api/locations/${created.id}`, { headers })
    ).json();
    // Offset persisted for B...
    const offB = after.photo_offsets?.[B];
    expect(offB, "photo_offsets[B] persisted").toBeTruthy();
    expect(Math.abs(offB.x) + Math.abs(offB.y)).toBeGreaterThan(0);
    // ...and the cover (A) was NOT touched.
    expect(after.photo_offsets?.[A], "cover A untouched").toBeFalsy();
  } finally {
    if (created.id) {
      for (const p of created.files)
        await req
          .delete(
            `${base}/api/locations/${created.id}/photo?filename=${encodeURIComponent(nameOf(p)!)}`,
            { headers },
          )
          .catch(() => {});
      await req
        .delete(`${base}/api/locations/${created.id}`, { headers })
        .catch(() => {});
    }
  }
});
