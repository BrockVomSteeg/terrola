import { test, expect } from "@playwright/test";
import {
  createSessionToken,
  decodeSessionPayload,
  verifySessionToken,
} from "../../lib/session";
import { getPerson } from "../../lib/identity";
import { getMembers } from "../../lib/members";

const [MEMBER_A, MEMBER_B] = getMembers();

/**
 * Pure unit tests for the person-field session extension. No browser, no
 * network, no Supabase - needs only a signing key (SESSION_SECRET or
 * SITE_PASSWORD_HASH) from .env.local, same as the app.
 */

test.describe("session person-field extension (pure)", () => {
  test("a token minted with no args has no person, still verifies", async () => {
    const token = await createSessionToken();
    test.skip(!token, "no signing key configured locally");
    expect(await verifySessionToken(token)).toBe(true);
    const payload = await decodeSessionPayload(token);
    expect(payload?.person).toBeUndefined();
    expect(await getPerson(token)).toBeNull();
  });

  test("a token minted with a person round-trips correctly", async () => {
    const token = await createSessionToken({ person: MEMBER_A });
    test.skip(!token, "no signing key configured locally");
    const payload = await decodeSessionPayload(token);
    expect(payload?.person).toBe(MEMBER_A);
    expect(await getPerson(token)).toBe(MEMBER_A);
  });

  test("re-signing with an explicit iat preserves it, doesn't reset to now", async () => {
    // One hour in the past - proves iat isn't reset to "now" without
    // accidentally landing outside the 30-day expiry window (which a fixed
    // old epoch would, once enough real time has passed).
    const originalIat = Math.floor(Date.now() / 1000) - 3600;
    const token = await createSessionToken({
      person: MEMBER_B,
      iat: originalIat,
    });
    test.skip(!token, "no signing key configured locally");
    const payload = await decodeSessionPayload(token);
    expect(payload?.iat).toBe(originalIat);
    expect(payload?.exp).toBe(originalIat + 60 * 60 * 24 * 30);
  });

  test("getPerson returns null for a garbage token, never throws", async () => {
    expect(await getPerson("not-a-real-token")).toBeNull();
    expect(await getPerson(null)).toBeNull();
    expect(await getPerson(undefined)).toBeNull();
  });

  test("decodeSessionPayload returns null for a tampered signature", async () => {
    const token = await createSessionToken({ person: MEMBER_A });
    test.skip(!token, "no signing key configured locally");
    const [payloadPart] = token!.split(".");
    const tampered = `${payloadPart}.not-the-real-signature`;
    expect(await decodeSessionPayload(tampered)).toBeNull();
    expect(await verifySessionToken(tampered)).toBe(false);
  });
});
