import { test, expect } from "@playwright/test";
import { getMembers } from "../../lib/members";

const [MEMBER_A, MEMBER_B] = getMembers();

const PW = process.env.SITE_PASSWORD;
const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

// Choosing which member you are is a plain claim carried in the session
// cookie (see app/api/identity/route.ts). These tests cover CSRF, an existing
// session, input validation, and that the claim round-trips. Valid ids come
// from getMembers() (the MEMBERS setting, or its defaults).
const getAuthHeaders = async (request: any) => {
  const state = await request.storageState();
  const csrf =
    state.cookies.find((c: any) => c.name === "app_csrf")?.value || "";
  return {
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
  };
};

test.describe("POST /api/identity", () => {
  test("without a session returns 403 (no CSRF cookie exists to check either)", async ({
    request,
    baseURL,
  }) => {
    test.skip(!IS_LOCAL, "local-only");
    const base = baseURL || "http://localhost:3000";
    // CSRF is checked before the session, same ordering as every other
    // protected route (e.g. app/api/locations/route.ts); a request with
    // no session also has no app_csrf cookie, so it fails there first.
    const res = await request.post(`${base}/api/identity`, {
      data: { person: MEMBER_A },
    });
    expect(res.status()).toBe(403);
  });

  test("with a session but no CSRF header returns 403", async ({
    request,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });

    const res = await request.post(`${base}/api/identity`, {
      data: { person: MEMBER_A },
    });
    expect(res.status()).toBe(403);
  });

  test("choosing the first member identifies as that member", async ({
    request,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const res = await request.post(`${base}/api/identity`, {
      headers,
      data: { person: MEMBER_A },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).person).toBe(MEMBER_A);
  });

  test("choosing the second member identifies as that member", async ({
    request,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const res = await request.post(`${base}/api/identity`, {
      headers,
      data: { person: MEMBER_B },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).person).toBe(MEMBER_B);
  });

  // The route writes `person` straight into a signed session token, so it must
  // only ever accept a configured member id.
  for (const bad of [
    "not-a-member",
    "",
    MEMBER_A.toUpperCase() === MEMBER_A
      ? MEMBER_A.toLowerCase()
      : MEMBER_A.toUpperCase(),
    `${MEMBER_A} `,
    null,
    42,
    [MEMBER_A],
  ]) {
    test(`rejects ${JSON.stringify(bad)} as a person`, async ({
      request,
      baseURL,
    }) => {
      test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
      const base = baseURL || "http://localhost:3000";
      await request.post(`${base}/api/auth`, { data: { password: PW } });
      const headers = await getAuthHeaders(request);

      const res = await request.post(`${base}/api/identity`, {
        headers,
        data: { person: bad },
      });
      expect(res.status()).toBe(400);
    });
  }

  test("switching from the first member to the second on the same session is allowed", async ({
    request,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    await request.post(`${base}/api/identity`, {
      headers,
      data: { person: MEMBER_A },
    });
    const res = await request.post(`${base}/api/identity`, {
      headers,
      data: { person: MEMBER_B },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).person).toBe(MEMBER_B);
  });

  test("DELETE clears identity and returns success", async ({
    request,
    baseURL,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";
    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    await request.post(`${base}/api/identity`, {
      headers,
      data: { person: MEMBER_A },
    });
    const res = await request.delete(`${base}/api/identity`, { headers });
    expect(res.status()).toBe(200);
  });
});
