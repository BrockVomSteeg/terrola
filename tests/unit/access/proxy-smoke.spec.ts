import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "@/proxy";
import { COOKIE_NAME, createSessionToken } from "@/lib/session";

// Proves the unit harness can drive the proxy in plain Node: no browser, no
// server, no network. The full route, method and mode matrix (SPEC R4) builds
// on these two calls.

const KEYS = ["SESSION_SECRET", "SITE_PASSWORD_HASH", "NODE_ENV"] as const;
const TEST_KEY = "unit-test-signing-key-0123456789abcdef";
const OTHER_KEY = "another-unit-test-key-fedcba9876543210";
// Shaped like bcrypt output, built at run time. Never a real hash.
const TEST_HASH = "$2b$04$" + "a".repeat(53);

// The proxy reads the real environment, so these tests set it.
const env = process.env as Record<string, string | undefined>;

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
    saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]));
    delete env.SESSION_SECRET;
    delete env.SITE_PASSWORD_HASH;
  });

  test.afterEach(() => {
    for (const k of KEYS) {
      const value = saved[k];
      if (value === undefined) delete env[k];
      else env[k] = value;
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
    env.SESSION_SECRET = TEST_KEY;
    env.SITE_PASSWORD_HASH = TEST_HASH;
    const token = await createSessionToken();
    expect(token).toBeTruthy();
    const res = await proxy(withSession("/api/locations", token ?? ""));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  test("a forged, tampered or wrongly signed session is refused", async () => {
    env.SITE_PASSWORD_HASH = TEST_HASH;
    env.SESSION_SECRET = OTHER_KEY;
    const signedWithOtherKey = (await createSessionToken()) ?? "";
    env.SESSION_SECRET = TEST_KEY;
    const token = (await createSessionToken()) ?? "";
    expect(token).toBeTruthy();
    expect(signedWithOtherKey).toBeTruthy();
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
    env.SESSION_SECRET = TEST_KEY;
    env.SITE_PASSWORD_HASH = TEST_HASH;
    const res = await proxy(new NextRequest("http://localhost/api/locations"));
    expect(res.status).toBe(401);
    expect(await res.json()).toHaveProperty("error");
  });

  test("a page request with no session is sent to the login page", async () => {
    env.SESSION_SECRET = TEST_KEY;
    env.SITE_PASSWORD_HASH = TEST_HASH;
    const res = await proxy(new NextRequest("http://localhost/map"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/");
  });

  // SPEC R18: a missing or short key fails closed in every environment. The
  // old proxy let every request through outside production.
  for (const nodeEnv of ["production", "development", "test"]) {
    for (const [label, secret] of [
      ["no", undefined],
      ["a short", "only-sixteen-chr"],
    ] as const) {
      test(`${label} signing key fails closed with NODE_ENV=${nodeEnv}`, async () => {
        env.NODE_ENV = nodeEnv;
        env.SITE_PASSWORD_HASH = TEST_HASH;
        if (secret) env.SESSION_SECRET = secret;

        const api = await proxy(new NextRequest("http://localhost/api/locations"));
        expect(api.status).toBe(503);
        expect(api.headers.get("x-middleware-next")).toBeNull();
        expect(api.headers.get("cache-control")).toBe("no-store");
        const body = JSON.stringify(await api.json());
        expect(body).toContain("SESSION_SECRET");
        if (secret) expect(body).not.toContain(secret);
        expect(body).not.toContain(TEST_HASH);

        const page = await proxy(new NextRequest("http://localhost/map"));
        expect(page.status).toBe(307);
        expect(page.headers.get("x-middleware-next")).toBeNull();
        expect(new URL(page.headers.get("location") ?? "").pathname).toBe("/");
      });
    }
  }

  test("a session signed with the password hash is refused", async () => {
    // The old fallback: no SESSION_SECRET, so the hash signed the session.
    // Build exactly the token the old code minted (version 1, hash as key)
    // and the same in today's version, and present both.
    env.SITE_PASSWORD_HASH = TEST_HASH;
    expect(await createSessionToken()).toBeNull();
    const iat = Math.floor(Date.now() / 1000);
    for (const v of [1, 2]) {
      const body = Buffer.from(
        JSON.stringify({ v, iat, exp: iat + 60 * 60 * 24 * 30 }),
      ).toString("base64url");
      const sig = createHmac("sha256", TEST_HASH)
        .update(body)
        .digest("base64url");
      const res = await proxy(withSession("/api/locations", `${body}.${sig}`));
      expect(res.status, `version ${v}`).toBe(503);
      expect(res.headers.get("x-middleware-next")).toBeNull();
    }
  });
});
