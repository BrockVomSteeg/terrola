import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "@/proxy";
import { COOKIE_NAME, createSessionToken } from "@/lib/session";

// Proves the unit harness can drive the proxy in plain Node: no browser, no
// server, no network. The full route, method and mode matrix (SPEC R4) builds
// on these two calls.

const KEYS = ["SESSION_SECRET", "SITE_PASSWORD_HASH"] as const;
const TEST_KEY = "unit-test-signing-key-0123456789abcdef";
const OTHER_KEY = "another-unit-test-key-fedcba9876543210";

function withSession(path: string, token: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { cookie: `${COOKIE_NAME}=${token}` },
  });
}

// These tests set process.env, so they must not interleave.
test.describe.configure({ mode: "serial" });

test.describe("proxy harness", () => {
  let saved: Record<string, string | undefined> = {};

  test.beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });

  test.afterEach(() => {
    for (const k of KEYS) {
      const value = saved[k];
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  });

  test("the matcher covers the map and the data routes", () => {
    for (const url of [
      "/map",
      "/api/locations",
      "/api/locations/abc/photo",
      "/api/geocode",
    ]) {
      expect(
        unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }),
        url,
      ).toBe(true);
    }
  });

  test("the matcher leaves static files alone", () => {
    for (const url of ["/_next/static/chunks/app.js", "/favicon.ico"]) {
      expect(
        unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }),
        url,
      ).toBe(false);
    }
  });

  test("a request with a valid session passes", async () => {
    process.env.SESSION_SECRET = TEST_KEY;
    const token = await createSessionToken();
    expect(token).toBeTruthy();
    const res = await proxy(withSession("/api/locations", token ?? ""));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  test("a forged, tampered or wrongly signed session is refused", async () => {
    process.env.SESSION_SECRET = OTHER_KEY;
    const signedWithOtherKey = (await createSessionToken()) ?? "";
    process.env.SESSION_SECRET = TEST_KEY;
    const token = (await createSessionToken()) ?? "";
    const payload = token.split(".")[0];
    const forged = [
      "garbage",
      `${payload}.not-the-real-signature`,
      `${token}x`,
      signedWithOtherKey,
    ];
    for (const bad of forged) {
      const res = await proxy(withSession("/api/locations", bad));
      expect(res.status, bad.slice(0, 12)).toBe(401);
    }
  });

  test("a data request with no session gets 401 JSON", async () => {
    process.env.SESSION_SECRET = TEST_KEY;
    const res = await proxy(new NextRequest("http://localhost/api/locations"));
    expect(res.status).toBe(401);
    expect(await res.json()).toHaveProperty("error");
  });

  test("a page request with no session is sent to the login page", async () => {
    process.env.SESSION_SECRET = TEST_KEY;
    const res = await proxy(new NextRequest("http://localhost/map"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/");
  });
});
