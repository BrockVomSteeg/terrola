import { test, expect } from "@playwright/test";

const PW = process.env.SITE_PASSWORD;
const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

const getAuthHeaders = async (request: any) => {
  const state = await request.storageState();
  const csrf =
    state.cookies.find((c: any) => c.name === "app_csrf")?.value || "";
  return {
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
  };
};

test.describe("UUID format validation", () => {
  test("GET /api/locations/invalid-uuid returns 400", async ({
    request,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });

    const res = await request.get(`${base}/api/locations/not-a-uuid`);
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  test("GET /api/locations/123 returns 400", async ({ request, baseURL }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });

    const res = await request.get(`${base}/api/locations/123`);
    expect(res.status()).toBe(400);
  });

  test("GET /api/locations/00000000-0000-0000-0000-000000000000 returns 404 (valid format, no row)", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const res = await request.get(
      `${base}/api/locations/00000000-0000-0000-0000-000000000000`,
      { headers },
    );
    expect(res.status()).toBe(404);
  });

  test("POST /api/locations/invalid-uuid/photo-url returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const res = await request.post(
      `${base}/api/locations/not-a-uuid/photo-url`,
      { headers },
    );
    expect(res.status()).toBe(400);
  });

  test("PATCH /api/locations/invalid-uuid returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const res = await request.patch(`${base}/api/locations/not-a-uuid`, {
      headers,
      data: { title: "__pw_input_validation__" },
    });
    expect(res.status()).toBe(400);
  });

  test("DELETE /api/locations/invalid-uuid returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const res = await request.delete(`${base}/api/locations/not-a-uuid`, {
      headers,
    });
    expect(res.status()).toBe(400);
  });
});
