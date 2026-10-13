import { test, expect } from "@playwright/test";
import {
  addressBucket,
  createLimiter,
  trustedClientBucket,
} from "@/app/api/_lib/rate-limit";

const WINDOW = 15 * 60 * 1000;

function clock(start = 1_000_000) {
  const state = { at: start };
  return { state, now: () => state.at };
}

test.describe("limiter", () => {
  test("allows the limit, then refuses with the time left", () => {
    const { state, now } = clock();
    const limiter = createLimiter({ limit: 3, windowMs: WINDOW, now });
    for (let i = 0; i < 3; i++) expect(limiter.take("a")).toEqual({ ok: true });
    state.at += 60_000;
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSec: 14 * 60 });
    // A refused attempt does not extend the wait.
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSec: 14 * 60 });
  });

  test("keys are counted apart", () => {
    const limiter = createLimiter({ limit: 1, windowMs: WINDOW });
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
    expect(limiter.take("b").ok).toBe(true);
  });

  test("the window ends exactly on time and starts a fresh count", () => {
    const { state, now } = clock();
    const limiter = createLimiter({ limit: 1, windowMs: WINDOW, now });
    expect(limiter.take("a").ok).toBe(true);
    state.at += WINDOW - 1;
    expect(limiter.take("a").ok).toBe(false);
    state.at += 1;
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
  });

  test("clear forgets one key only", () => {
    const limiter = createLimiter({ limit: 1, windowMs: WINDOW });
    limiter.take("a");
    limiter.take("b");
    limiter.clear("a");
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("b").ok).toBe(false);
  });

  test("a full table refuses new keys instead of growing", () => {
    const { state, now } = clock();
    const limiter = createLimiter({ limit: 5, windowMs: WINDOW, maxKeys: 3, now });
    for (const key of ["a", "b", "c"]) expect(limiter.take(key).ok).toBe(true);
    for (let i = 0; i < 100; i++) {
      expect(limiter.take(`made-up-${i}`).ok).toBe(false);
    }
    expect(limiter.size()).toBe(3);
    // A key already in the table still works.
    expect(limiter.take("a").ok).toBe(true);
    // Expired keys are swept, then new keys fit again.
    state.at += WINDOW;
    expect(limiter.take("d").ok).toBe(true);
    expect(limiter.size()).toBe(1);
  });

  test("a limit of zero refuses everything", () => {
    const limiter = createLimiter({ limit: 0, windowMs: WINDOW });
    expect(limiter.take("a").ok).toBe(false);
    expect(limiter.size()).toBe(0);
  });
});

test.describe("address buckets", () => {
  test("an IPv4 address is its own bucket", () => {
    expect(addressBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(addressBucket(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(addressBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  test("every address in one IPv6 /64 shares a bucket", () => {
    const same = [
      "2001:db8:1:2::1",
      "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
      "2001:0DB8:0001:0002:0000:0000:0000:0001",
      "2001:db8:1:2:ffff::",
    ].map(addressBucket);
    expect(new Set(same).size).toBe(1);
    expect(same[0]).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:db8:1:3::1")).not.toBe(same[0]);
    expect(addressBucket("::1")).toBe("0:0:0:0::/64");
  });

  test("anything that is not an address has no bucket", () => {
    for (const bad of [
      "",
      "unknown",
      "1.2.3",
      "2001:db8",
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      "12345::1",
      "2001:db8::g",
      "a".repeat(200),
      "203.0.113.7, 198.51.100.1",
    ]) {
      expect(addressBucket(bad), bad.slice(0, 20)).toBeNull();
    }
  });
});

test.describe("which client address is trusted", () => {
  const forged = new Headers({
    "x-forwarded-for": "198.51.100.1",
    "x-real-ip": "198.51.100.2",
    "x-vercel-forwarded-for": "198.51.100.3",
  });

  test("off Vercel no header is trusted", () => {
    for (const env of [{}, { VERCEL: "" }, { VERCEL: "0" }, { VERCEL: "true" }]) {
      expect(trustedClientBucket(forged, env)).toBeNull();
    }
  });

  test("on Vercel the platform headers are used, in order", () => {
    const env = { VERCEL: "1" };
    expect(trustedClientBucket(forged, env)).toBe("198.51.100.3");
    expect(
      trustedClientBucket(new Headers({ "x-real-ip": "198.51.100.2" }), env),
    ).toBe("198.51.100.2");
    expect(
      trustedClientBucket(
        new Headers({ "x-vercel-forwarded-for": "2001:db8:1:2::9, 10.0.0.1" }),
        env,
      ),
    ).toBe("2001:db8:1:2::/64");
  });

  test("x-forwarded-for is never read, even on Vercel", () => {
    expect(
      trustedClientBucket(
        new Headers({ "x-forwarded-for": "198.51.100.1" }),
        { VERCEL: "1" },
      ),
    ).toBeNull();
  });
});
