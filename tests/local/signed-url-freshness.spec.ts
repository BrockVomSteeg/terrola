import { test, expect } from "@playwright/test";
import { signedUrlExpiryMs, isFreshSignedUrl } from "../../lib/photos";

/**
 * Pure unit tests for the signed-URL freshness helpers that back the long-TTL
 * REUSED signed URL scheme (lib/photos.ts -> lib/supabase-server.ts). No browser,
 * no network, no Supabase - safe to run anywhere, zero egress.
 *
 * The scheme: the server reuses a persisted/cached signed URL while its token
 * has comfortably more than the re-sign threshold of TTL left; anything
 * unparseable must read as NOT fresh so it gets re-signed (fail-safe).
 */

const b64url = (s: string) =>
  Buffer.from(s)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const signedUrl = (payload: Record<string, unknown>) =>
  "https://xyz.supabase.co/storage/v1/object/sign/location-photos/" +
  `abc-123.jpg?token=${b64url('{"alg":"HS256"}')}.${b64url(
    JSON.stringify(payload),
  )}.${b64url("sig")}`;

const DAY_MS = 24 * 60 * 60 * 1000;

test.describe("signed-url freshness helpers (pure, zero egress)", () => {
  test("parses exp (seconds) from the token JWT into ms", () => {
    const expSec = 1_800_000_000;
    expect(signedUrlExpiryMs(signedUrl({ exp: expSec }))).toBe(expSec * 1000);
  });

  test("null for URLs without a parseable token", () => {
    expect(signedUrlExpiryMs(null)).toBeNull();
    expect(signedUrlExpiryMs(undefined)).toBeNull();
    expect(signedUrlExpiryMs("")).toBeNull();
    // no token param at all
    expect(
      signedUrlExpiryMs("https://xyz.supabase.co/location-photos/a.jpg"),
    ).toBeNull();
    // token that isn't a 3-part JWT
    expect(signedUrlExpiryMs("https://x.co/a.jpg?token=not-a-jwt")).toBeNull();
    // valid JWT shape but no exp claim
    expect(signedUrlExpiryMs(signedUrl({ iat: 123 }))).toBeNull();
    // exp present but not a number
    expect(signedUrlExpiryMs(signedUrl({ exp: "soon" }))).toBeNull();
    // garbage base64 payload
    expect(
      signedUrlExpiryMs("https://x.co/a.jpg?token=a.!!!not-base64!!!.c"),
    ).toBeNull();
  });

  test("handles base64url payloads that need padding", () => {
    // Vary payload length so the base64url form exercises 0/1/2 pad chars.
    for (const pad of ["", "x", "xx", "xxx"]) {
      const expSec = 1_700_000_000;
      const url = signedUrl({ exp: expSec, p: pad });
      expect(signedUrlExpiryMs(url)).toBe(expSec * 1000);
    }
  });

  test("isFreshSignedUrl: fresh only when MORE than the threshold remains", () => {
    const now = 1_750_000_000_000;
    const threshold = 3 * DAY_MS;
    const at = (remainingMs: number) =>
      signedUrl({ exp: (now + remainingMs) / 1000 });

    // Comfortably inside the TTL -> fresh.
    expect(isFreshSignedUrl(at(29 * DAY_MS), threshold, now)).toBe(true);
    expect(isFreshSignedUrl(at(threshold + 1000), threshold, now)).toBe(true);
    // At or below the threshold -> NOT fresh (must re-sign).
    expect(isFreshSignedUrl(at(threshold), threshold, now)).toBe(false);
    expect(isFreshSignedUrl(at(DAY_MS), threshold, now)).toBe(false);
    // Already expired -> NOT fresh.
    expect(isFreshSignedUrl(at(-1000), threshold, now)).toBe(false);
    // Unparseable -> NOT fresh (fail-safe: re-sign, never serve).
    expect(isFreshSignedUrl(null, threshold, now)).toBe(false);
    expect(isFreshSignedUrl("https://x.co/a.jpg", threshold, now)).toBe(false);
  });

  test("legacy 1h-TTL URLs read as NOT fresh under a multi-day threshold", () => {
    // A URL carrying a 1h token must be classified as needing a re-sign.
    const now = Date.now();
    const legacy = signedUrl({ exp: (now + 3600 * 1000) / 1000 });
    expect(isFreshSignedUrl(legacy, 3 * DAY_MS, now)).toBe(false);
  });
});
