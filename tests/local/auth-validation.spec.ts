import { test, expect } from "@playwright/test";

const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

test.describe("auth validation", () => {
  test("POST /api/auth with empty password returns 400", async ({
    request,
    baseURL,
  }) => {
    test.skip(!IS_LOCAL, "local-only");
    const base = baseURL || "http://localhost:3000";

    const res = await request.post(`${base}/api/auth`, {
      data: { password: "" },
    });
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  test("POST /api/auth with null password returns 400", async ({
    request,
    baseURL,
  }) => {
    test.skip(!IS_LOCAL, "local-only");
    const base = baseURL || "http://localhost:3000";

    const res = await request.post(`${base}/api/auth`, {
      data: { password: null },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/auth with numeric password returns 400", async ({
    request,
    baseURL,
  }) => {
    test.skip(!IS_LOCAL, "local-only");
    const base = baseURL || "http://localhost:3000";

    const res = await request.post(`${base}/api/auth`, {
      data: { password: 123456 },
    });
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("required");
  });

  test("POST /api/auth with undefined password returns 400", async ({
    request,
    baseURL,
  }) => {
    test.skip(!IS_LOCAL, "local-only");
    const base = baseURL || "http://localhost:3000";

    const res = await request.post(`${base}/api/auth`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test("POST /api/auth with very long password does not crash the server", async ({
    request,
    baseURL,
  }) => {
    test.skip(!IS_LOCAL, "local-only");
    const base = baseURL || "http://localhost:3000";

    const longPassword = "a".repeat(100000);
    const res = await request.post(`${base}/api/auth`, {
      data: { password: longPassword },
    });
    // 401: body parsed fine, bcrypt correctly rejected the wrong password.
    // 400/413: a size limit rejected it first. 500 would be a real bug.
    expect([400, 401, 413]).toContain(res.status());
  });

  test("POST /api/auth with invalid request body returns 400", async ({
    request,
    baseURL,
  }) => {
    test.skip(!IS_LOCAL, "local-only");
    const base = baseURL || "http://localhost:3000";

    const res = await request.post(`${base}/api/auth`, {
      data: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe("auth rate limiting", () => {
  test("POST /api/auth shows rate limiting after multiple failed attempts", async ({
    request,
    baseURL,
  }) => {
    test.skip(!IS_LOCAL, "local-only");
    const base = baseURL || "http://localhost:3000";

    // Make 5 failed auth attempts (MAX_ATTEMPTS = 5)
    const results = [];
    for (let i = 0; i < 6; i++) {
      const res = await request.post(`${base}/api/auth`, {
        data: { password: `wrong-password-${i}` },
      });
      results.push(res.status());
    }

    // First 5 should be 401 (invalid password), 6th should be 429 (rate limited)
    expect(results[results.length - 1]).toBe(429);
  });
});
