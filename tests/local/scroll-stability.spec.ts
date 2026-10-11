import { test, expect } from "@playwright/test";

/**
 * Scroll/pan stability. Locks in:
 *   1. the map fills the viewport via 100dvh, NOT a JS `style.height = innerHeight`
 *      pin (a pinned height makes the map resize/jump when the visual viewport
 *      changes, e.g. iOS toolbar / on-screen keyboard);
 *   2. the named scroll sections (admin panel, mobile sheet) CONTAIN their scroll
 *      so reaching an edge doesn't rubber-band the section;
 *   3. the location card has a small dead-zone before swipe-to-dismiss engages,
 *      so an incidental touch doesn't slide the whole card.
 *
 * Local-only (needs SITE_PASSWORD + localhost). Throwaways hard-deleted in finally.
 */

const PW = process.env.SITE_PASSWORD;
const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.fill('input[type="password"]', PW!);
  await page.click('button[aria-label="Submit password"]');
  await expect(page).toHaveURL(/\/map/, { timeout: 15_000 });
}

test.describe("scroll/pan stability (mobile)", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("map fills the viewport via 100dvh, not a JS innerHeight pin", async ({
    page,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
    await login(page);
    await page.goto("/map");
    await page.waitForTimeout(2000);

    const read = () =>
      page.evaluate(() => {
        const el = document.querySelector(".map-container") as HTMLElement;
        const r = el.getBoundingClientRect();
        return {
          inlineHeight: el.style.height,
          rectH: Math.round(r.height),
          innerH: window.innerHeight,
        };
      });

    const a = await read();
    // The map must NOT carry a JS-set inline pixel height (an innerHeight pin).
    expect(a.inlineHeight).toBe("");
    // It still fills the screen (via inset:0 inside the 100dvh parent).
    expect(Math.abs(a.rectH - a.innerH)).toBeLessThanOrEqual(2);

    // Shrinking the viewport must not leave a stale pinned px height; the map
    // tracks the viewport through CSS (dvh), with no JS-driven snap.
    await page.setViewportSize({ width: 375, height: 680 });
    await page.waitForTimeout(300);
    const b = await read();
    expect(b.inlineHeight).toBe("");
    expect(Math.abs(b.rectH - b.innerH)).toBeLessThanOrEqual(2);
  });

  test("admin panel + mobile sheet contain their scroll", async ({ page }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
    await login(page);
    await page.goto("/map");
    await page.waitForTimeout(1200);

    await page.getByTestId("admin-fab").click();
    const panel = page.locator(".admin-panel");
    await expect(panel).toBeVisible();
    expect(
      await panel.evaluate((el) => getComputedStyle(el).overscrollBehaviorY),
    ).toBe("contain");

    // Close admin, open the mobile sheet, check its inner scroller is contained.
    await page.locator(".admin-panel button", { hasText: "×" }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".mobile-places-btn").click();
    await page.waitForTimeout(400);
    const innerOB = await page.evaluate(() => {
      const sheet = document.querySelector(".sidebar-mobile");
      const scroller = sheet
        ? ([...sheet.querySelectorAll("div")].find(
            (d) => getComputedStyle(d).overflowY === "auto",
          ) as HTMLElement | undefined)
        : undefined;
      return scroller
        ? getComputedStyle(scroller).overscrollBehaviorY
        : "(none)";
    });
    expect(innerOB).toBe("contain");
  });

  test("location card ignores a sub-threshold down-drag, follows a real swipe", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD + localhost");
    const base = baseURL || "http://localhost:3000";
    await login(page);
    const cookies = await context.cookies();
    const csrf = cookies.find((c) => c.name === "app_csrf")?.value ?? "";
    const headers = {
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    };
    const loc = await (
      await page.request.post(`${base}/api/locations`, {
        headers,
        data: {
          title: "__pwcard__",
          date_label: "2020-01-01",
          lat: 0,
          lng: 0,
          category: "everyday",
        },
      })
    ).json();
    try {
      await page.goto("/map");
      await page.waitForTimeout(1000);
      await page.locator(".mobile-places-btn").click();
      await page.waitForTimeout(400);
      await page
        .locator(`[data-testid="sidebar-loc-${loc.id}"]:visible`)
        .first()
        .click();
      const card = page.locator(".location-card");
      await expect(card).toBeVisible({ timeout: 6000 });
      await page.waitForTimeout(400);

      // Synthetic single-finger drag on the card body (TouchEvent - the card's
      // dismiss handler reads e.touches, which page.mouse can't produce). We
      // dispatch touchstart+touchmove, then let React re-render before reading
      // the transform (setDragY is async), then touchend to release.
      const SEL = ".location-card";
      const startDrag = (startY: number, dy: number) =>
        page.evaluate(
          ({ sel, startY, dy }) => {
            const el = document.querySelector(sel) as HTMLElement;
            const r = el.getBoundingClientRect();
            const x = r.x + r.width / 2;
            const mk = (type: string, y: number, end = false) => {
              const t = new Touch({
                identifier: 1,
                target: el,
                clientX: x,
                clientY: y,
              });
              return new TouchEvent(type, {
                cancelable: true,
                bubbles: true,
                touches: end ? [] : [t],
                targetTouches: end ? [] : [t],
                changedTouches: [t],
              });
            };
            el.dispatchEvent(mk("touchstart", startY));
            el.dispatchEvent(mk("touchmove", startY + dy));
            (window as unknown as { __endY: number }).__endY = startY + dy;
          },
          { sel: SEL, startY, dy },
        );
      const endDrag = () =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement;
          const r = el.getBoundingClientRect();
          const x = r.x + r.width / 2;
          const y = (window as unknown as { __endY: number }).__endY ?? r.y;
          const t = new Touch({
            identifier: 1,
            target: el,
            clientX: x,
            clientY: y,
          });
          el.dispatchEvent(
            new TouchEvent("touchend", {
              cancelable: true,
              bubbles: true,
              touches: [],
              targetTouches: [],
              changedTouches: [t],
            }),
          );
        }, SEL);
      const translateY = () =>
        card.evaluate(
          (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42,
        );

      const box = (await card.boundingBox())!;
      const startY = box.y + box.height * 0.55;

      // 6px down (<= 8px dead-zone) -> card must NOT move.
      await startDrag(startY, 6);
      await page.waitForTimeout(150);
      expect(Math.abs(await translateY())).toBeLessThanOrEqual(1);
      await endDrag();
      await page.waitForTimeout(150);

      // 30px down -> card follows (~ 30 - 8 dead-zone = 22px).
      await startDrag(startY, 30);
      await page.waitForTimeout(150);
      expect(await translateY()).toBeGreaterThan(10);
      await endDrag();
    } finally {
      await page.request
        .delete(`${base}/api/locations/${loc.id}`, { headers })
        .catch(() => {});
    }
  });
});
