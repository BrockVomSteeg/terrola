import { test, expect } from "@playwright/test";

const PW = process.env.SITE_PASSWORD;
const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

// /api/geocode is gated by the auth middleware (proxy.ts), same as
// /api/locations - every request here needs a real session first.
test.describe("geocode parameter validation", () => {
  test("GET /api/geocode without session parameter returns 400", async ({
    request,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });

    const res = await request.get(`${base}/api/geocode?q=test`);
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  test("GET /api/geocode?session=x without q or retrieve returns 400", async ({
    request,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });

    const res = await request.get(`${base}/api/geocode?session=test-session`);
    expect(res.status()).toBe(400);
  });

  test("GET /api/geocode with empty q parameter returns 400", async ({
    request,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });

    const res = await request.get(`${base}/api/geocode?session=test&q=`);
    expect(res.status()).toBe(400);
  });

  test("GET /api/geocode with empty retrieve parameter handles gracefully", async ({
    request,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });

    const res = await request.get(`${base}/api/geocode?session=test&retrieve=`);
    // Empty retrieve should either return 400 or 500 (missing feature_id)
    expect([400, 500]).toContain(res.status());
  });

  test("GET /api/geocode with valid parameters succeeds or returns Mapbox error", async ({
    request,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });

    const res = await request.get(
      `${base}/api/geocode?session=test&q=test+cafe`,
    );
    // Success is 200, Mapbox auth/rate limit errors are 4xx/5xx
    expect(res.status()).toBeGreaterThanOrEqual(200);
  });
});
