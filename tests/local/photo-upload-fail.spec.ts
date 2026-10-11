import { test, expect } from "@playwright/test";

/**
 * Verification of the photo-upload partial-failure handling.
 *
 * In AdminPanel.handleSave's create flow, when one photo's registration fails
 * mid-multi-upload, `uploadPhotoDirect` returns { photos: [] } (storage ok, DB
 * registration failed). That empty array must not replace the accumulated
 * successes, and the panel must not close as if everything had worked.
 * Failure model: COMMIT-SUCCESSES-AND-REPORT-FAILURES.
 *
 * Two tests, both against the dev server, its database and its storage, using
 * throwaway rows hard-deleted in `finally`:
 *
 *   A) Server contract: a failed 3rd registration leaves photos 1 & 2 intact in
 *      the DB AND storage (nothing lost); the happy path then appends the 3rd.
 *   B) Client behavior (drives the create UI): with the 3rd photo's
 *      registration forced to fail, the two successes are committed, the panel
 *      STAYS OPEN (switched to edit mode showing both), an error NAMES the failed
 *      photo, and it does NOT close-as-success.
 *
 * Localhost-guarded so it can never mutate a deployed DB. Skipped unless
 * SITE_PASSWORD is present (loaded from .env.local via @next/env in
 * playwright.local.config.ts).
 */

const PW = process.env.SITE_PASSWORD;

const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

// Minimal valid 1x1 JPEG.
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

// ---------------------------------------------------------------------------
// A) Server contract - a failed registration never loses earlier photos.
//    Desktop viewport (irrelevant here; this test is API-only).
// ---------------------------------------------------------------------------
test("a failed photo registration never loses earlier photos (DB + storage)", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    !PW || !IS_LOCAL,
    "local-only write suite - needs SITE_PASSWORD and a localhost target",
  );
  const base = baseURL || "http://localhost:3000";

  await page.goto("/");
  await page.fill('input[type="password"]', PW!);
  await page.click('button[aria-label="Submit password"]');
  await expect(page).toHaveURL(/\/map/, { timeout: 10_000 });

  const cookies = await context.cookies();
  const csrf = cookies.find((c) => c.name === "app_csrf")?.value ?? "";
  const headers = { "X-CSRF-Token": csrf, "Content-Type": "application/json" };
  const req = page.request;

  // existing-location-untouched: snapshot a real (non-throwaway) row's photos.
  const before = await (
    await req.get(`${base}/api/locations`, { headers })
  ).json();
  const witness = (before as { id: string; photos?: string[] }[]).find(
    (l) => l.id,
  );
  const witnessPhotosBefore = JSON.stringify(witness?.photos ?? null);

  const created: { id: string | null; files: string[] } = {
    id: null,
    files: [],
  };

  try {
    const loc = await (
      await req.post(`${base}/api/locations`, {
        headers,
        data: {
          title: "__pwupfail_api__",
          date_label: "2020-01-01",
          lat: 0,
          lng: 0,
          category: "everyday",
        },
      })
    ).json();
    created.id = loc.id;
    expect(created.id, "throwaway created").toBeTruthy();

    // Register a photo the real way: photo-url -> PUT signed -> POST /photo.
    async function registerReal(): Promise<string> {
      const { signedUrl, path } = await (
        await req.post(`${base}/api/locations/${created.id}/photo-url`, {
          headers,
        })
      ).json();
      await req.put(signedUrl, {
        headers: { "Content-Type": "image/jpeg" },
        data: JPEG,
      });
      const r = await req.post(`${base}/api/locations/${created.id}/photo`, {
        headers,
        data: { path },
      });
      expect(r.status(), "real registration ok").toBe(200);
      created.files.push(path);
      return path as string;
    }

    const A = nameOf(await registerReal())!;
    await page.waitForTimeout(40);
    const B = nameOf(await registerReal())!;

    // DB now has exactly [A, B].
    const afterTwo = await (
      await req.get(`${base}/api/locations/${created.id}/photo`, { headers })
    ).json();
    expect(afterTwo.photos.map(nameOf), "DB has both photos in order").toEqual([
      A,
      B,
    ]);
    // Storage retained: the signed cover URL resolves to real bytes (200).
    const coverGet = await req.get(afterTwo.photos[0]);
    expect(coverGet.status(), "photo A bytes exist in storage").toBe(200);

    // -- Phase 1: a registration that NEVER reaches storage fails cleanly --
    // Foreign-path POST -> the IDOR guard rejects (400). No storage object is
    // written, so the next read is EXACTLY [A, B] - earlier photos retained,
    // nothing lost.
    const cleanFail = await req.post(
      `${base}/api/locations/${created.id}/photo`,
      { headers, data: { path: `someone-elses-location-${Date.now()}.jpg` } },
    );
    expect(cleanFail.status(), "foreign-path registration rejected").toBe(400);
    const afterClean = await (
      await req.get(`${base}/api/locations/${created.id}/photo`, { headers })
    ).json();
    expect(
      afterClean.photos.map(nameOf),
      "earlier photos retained after a failed registration",
    ).toEqual([A, B]);
    const stillThere = await req.get(afterClean.photos[1]);
    expect(stillThere.status(), "photo B bytes still in storage").toBe(200);

    // -- Phase 2: a photo whose BYTES reached storage but whose registration
    // failed is NOT lost - resolvePhotoOrder reconciles the persisted list
    // against storage and re-appends it on the next read. This is the stronger
    // 'nothing lost' guarantee that backs the client fix: even the failure case
    // that produced uploadPhotoDirect's { photos: [] } self-heals server-side. --
    const p3 = await (
      await req.post(`${base}/api/locations/${created.id}/photo-url`, {
        headers,
      })
    ).json();
    await req.put(p3.signedUrl, {
      headers: { "Content-Type": "image/jpeg" },
      data: JPEG,
    });
    created.files.push(p3.path);
    const orphanFail = await req.post(
      `${base}/api/locations/${created.id}/photo`,
      { headers, data: { path: `someone-elses-location-${Date.now()}.jpg` } },
    );
    expect(orphanFail.status(), "foreign-path registration rejected").toBe(400);
    const afterOrphan = await (
      await req.get(`${base}/api/locations/${created.id}/photo`, { headers })
    ).json();
    expect(
      afterOrphan.photos.map(nameOf),
      "a storage-resident photo self-heals onto the read (never lost)",
    ).toEqual([A, B, nameOf(p3.path)]);

    // -- Phase 3: the happy path (valid registration) persists cleanly --
    const ok = await req.post(`${base}/api/locations/${created.id}/photo`, {
      headers,
      data: { path: p3.path },
    });
    expect(ok.status(), "valid registration accepted").toBe(200);
    const afterThree = await (
      await req.get(`${base}/api/locations/${created.id}/photo`, { headers })
    ).json();
    expect(
      afterThree.photos.map(nameOf),
      "happy path keeps all three photos in order",
    ).toEqual([A, B, nameOf(p3.path)]);

    // existing-location-untouched.
    const after = await (
      await req.get(`${base}/api/locations`, { headers })
    ).json();
    const witnessAfter = (after as { id: string; photos?: string[] }[]).find(
      (l) => l.id === witness?.id,
    );
    expect(
      JSON.stringify(witnessAfter?.photos ?? null),
      "an existing location was not touched",
    ).toBe(witnessPhotosBefore);
  } finally {
    if (created.id) {
      for (const p of created.files) {
        await req
          .delete(
            `${base}/api/locations/${created.id}/photo?filename=${encodeURIComponent(
              nameOf(p)!,
            )}`,
            { headers },
          )
          .catch(() => {});
      }
      await req
        .delete(`${base}/api/locations/${created.id}`, { headers })
        .catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// B) Client behavior - drive the REAL create UI and force the 3rd photo to fail
//    two distinct ways:
//      B1) TOTAL failure (never reached storage) -> keep successes, stay OPEN,
//          name the failed photo, do NOT close-as-success.
//      B2) registration failure but the bytes DID reach storage -> the empty
//          { photos: [] } must NOT clobber; it self-heals and all 3 photos are
//          saved; the panel closes cleanly.
//    Both inject a fixed test location via a mocked geocode search.
// ---------------------------------------------------------------------------
test.describe("create-flow photo failures (real UI)", () => {
  test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false });

  const TITLE = "__pwupfail_ui__";
  type Row = { id: string; title: string; photos?: string[] };

  // Capture every object name created so cleanup removes them all (including a
  // storage orphan whose name lives only inside uploadPhotoDirect).
  function captureUploadedPaths(page: import("@playwright/test").Page) {
    const paths: string[] = [];
    page.on("response", async (resp) => {
      try {
        if (
          new URL(resp.url()).pathname.endsWith("/photo-url") &&
          resp.request().method() === "POST" &&
          resp.ok()
        ) {
          const body = await resp.json();
          if (body?.path) paths.push(body.path as string);
        }
      } catch {
        /* ignore */
      }
    });
    return paths;
  }

  async function login(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.fill('input[type="password"]', PW!);
    await page.click('button[aria-label="Submit password"]');
    await expect(page).toHaveURL(/\/map/, { timeout: 10_000 });
  }

  async function apiHeaders(
    context: import("@playwright/test").BrowserContext,
  ) {
    const c = await context.cookies();
    return {
      "X-CSRF-Token": c.find((x) => x.name === "app_csrf")?.value ?? "",
      "Content-Type": "application/json",
    };
  }

  async function mockGeocode(
    page: import("@playwright/test").Page,
  ) {
    await page.route("**/api/geocode**", async (route) => {
      if (route.request().url().includes("retrieve=")) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            geometry: { coordinates: [9.0, 45.0] },
            properties: { name: TITLE, place_formatted: "Test Cafe" },
          }),
        });
      } else {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify([
            {
              mapbox_id: "test.place",
              name: TITLE,
              place_formatted: "Test Cafe",
              feature_type: "place",
            },
          ]),
        });
      }
    });
  }

  async function openCreateAndStageThree(
    page: import("@playwright/test").Page,
  ) {
    await page.goto("/map");
    await page.getByTestId("admin-fab").click();
    await page.getByTestId("admin-search").fill("test cafe");
    await page.getByTestId("admin-suggestion-0").click();
    await page.getByTestId("admin-name").fill(TITLE);
    await page.getByTestId("admin-date").fill("2020-01-01");
    const fileInput = page.locator('input[type="file"]');
    for (let i = 1; i <= 3; i++) {
      await fileInput.setInputFiles({
        name: `p${i}.jpg`,
        mimeType: "image/jpeg",
        buffer: JPEG,
      });
      await expect(page.getByTestId("pending-photo")).toHaveCount(i, {
        timeout: 10_000,
      });
    }
  }

  async function cleanupByTitle(
    page: import("@playwright/test").Page,
    base: string,
    headers: Record<string, string>,
    uploadedPaths: string[],
  ) {
    const all = await (
      await page.request.get(`${base}/api/locations`, { headers })
    )
      .json()
      .catch(() => [] as Row[]);
    for (const row of (all as Row[]).filter((l) => l.title === TITLE)) {
      for (const p of uploadedPaths) {
        const fn = nameOf(p);
        if (!fn) continue;
        await page.request
          .delete(
            `${base}/api/locations/${row.id}/photo?filename=${encodeURIComponent(fn)}`,
            { headers },
          )
          .catch(() => {});
      }
      await page.request
        .delete(`${base}/api/locations/${row.id}`, { headers })
        .catch(() => {});
    }
  }

  // B1 - a TOTAL failure of the 3rd photo: fail its photo-url so it never even
  // reaches storage. uploadPhotoDirect returns null -> reported as failed.
  test("total upload failure keeps successes, stays open, names the failed photo", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(
      !PW || !IS_LOCAL,
      "local-only write suite - needs SITE_PASSWORD and a localhost target",
    );
    const base = baseURL || "http://localhost:3000";
    const uploadedPaths = captureUploadedPaths(page);
    await login(page);
    const headers = await apiHeaders(context);
    await mockGeocode(page);

    let urlPost = 0;
    await page.route("**/api/locations/**", async (route) => {
      const r = route.request();
      const path = new URL(r.url()).pathname;
      if (r.method() === "POST" && /\/photo-url$/.test(path)) {
        urlPost++;
        if (urlPost >= 3) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "forced failure" }),
          });
          return;
        }
      }
      await route.continue();
    });

    try {
      await openCreateAndStageThree(page);
      await page.getByTestId("admin-save").click();

      // 1. An error NAMES the failed photo and reassures the rest is saved.
      const err = page.getByTestId("photo-error");
      await expect(err).toBeVisible({ timeout: 20_000 });
      await expect(err).toContainText("Photo 3");
      await expect(err).toContainText(/saved/i);

      // 2. Panel STAYED OPEN (switched to edit mode) showing BOTH successes -
      //    it did NOT close-as-success.
      await expect(page.getByTestId("edit-photo-thumb")).toHaveCount(2, {
        timeout: 10_000,
      });

      // 3. The two successful photos are saved; nothing was clobbered.
      const list = (await (
        await page.request.get(`${base}/api/locations`, { headers })
      ).json()) as Row[];
      const row = list.find((l) => l.title === TITLE);
      expect(row, "created row exists").toBeTruthy();
      const read = await (
        await page.request.get(`${base}/api/locations/${row!.id}/photo`, {
          headers,
        })
      ).json();
      expect(read.photos.length, "two successful photos retained").toBe(2);
    } finally {
      await cleanupByTitle(page, base, headers, uploadedPaths);
    }
  });

  // B2 - the 3rd photo's bytes reach storage but its registration POST 500s, so
  // uploadPhotoDirect returns { photos: [] }. Earlier successes must not be
  // clobbered; the 3rd photo self-heals, all three are saved, and the panel
  // closes cleanly.
  test("registration failure self-heals - no clobber, all photos saved, panel closes", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(
      !PW || !IS_LOCAL,
      "local-only write suite - needs SITE_PASSWORD and a localhost target",
    );
    const base = baseURL || "http://localhost:3000";
    const uploadedPaths = captureUploadedPaths(page);
    await login(page);
    const headers = await apiHeaders(context);
    await mockGeocode(page);

    let photoPost = 0;
    await page.route("**/api/locations/**", async (route) => {
      const r = route.request();
      const path = new URL(r.url()).pathname;
      if (
        r.method() === "POST" &&
        /\/api\/locations\/[^/]+\/photo$/.test(path)
      ) {
        photoPost++;
        if (photoPost >= 3) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "forced failure" }),
          });
          return;
        }
      }
      await route.continue();
    });

    try {
      await openCreateAndStageThree(page);
      await page.getByTestId("admin-save").click();

      // The panel CLOSES cleanly (success) - no failure to report because the
      // 3rd photo's bytes are safe in storage and self-heal onto the read.
      await expect(page.getByTestId("admin-save")).toHaveCount(0, {
        timeout: 20_000,
      });
      expect(await page.getByTestId("photo-error").count()).toBe(0);

      // All THREE photos are present on the read (none clobbered) - the proof
      // the empty { photos: [] } never overwrote the earlier successes.
      const list = (await (
        await page.request.get(`${base}/api/locations`, { headers })
      ).json()) as Row[];
      const row = list.find((l) => l.title === TITLE);
      expect(row, "created row exists").toBeTruthy();
      await expect(async () => {
        const read = await (
          await page.request.get(`${base}/api/locations/${row!.id}/photo`, {
            headers,
          })
        ).json();
        expect(
          read.photos.length,
          "all three photos present (self-healed)",
        ).toBe(3);
      }).toPass({ timeout: 8_000 });
    } finally {
      await cleanupByTitle(page, base, headers, uploadedPaths);
    }
  });
});
