import { test, expect } from "@playwright/test";
import { getMode, isDemo, isReadOnlyDemo } from "@/lib/mode";

// SPEC R3 and section 4. Every case passes its own env object, so nothing here
// reads or changes the real process environment.

const LIVE = [undefined, "", "  ", "0", "false", "FALSE", "off", " Off "];
const READ_ONLY = ["1", "true", "readonly", "yes", "anything"];

test.describe("lib/mode", () => {
  for (const raw of LIVE) {
    test(`DEMO_MODE ${JSON.stringify(raw)} means live`, () => {
      expect(getMode({ DEMO_MODE: raw })).toBe("live");
    });
  }

  for (const raw of READ_ONLY) {
    test(`DEMO_MODE ${JSON.stringify(raw)} means demo-readonly`, () => {
      expect(getMode({ DEMO_MODE: raw })).toBe("demo-readonly");
    });
  }

  test("DEMO_MODE writable means demo-writable, in any case", () => {
    expect(getMode({ DEMO_MODE: "writable" })).toBe("demo-writable");
    expect(getMode({ DEMO_MODE: " Writable " })).toBe("demo-writable");
  });

  test("a demo refuses to start next to the service key and never prints its value", () => {
    const secret = "unit-test-service-key-value";
    for (const raw of ["1", "writable"]) {
      let message = "";
      try {
        getMode({ DEMO_MODE: raw, SUPABASE_SERVICE_KEY: secret });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, `DEMO_MODE=${raw}`).toContain("SUPABASE_SERVICE_KEY");
      expect(message, `DEMO_MODE=${raw}`).not.toContain(secret);
    }
  });

  test("a writable demo refuses a Vercel production deployment", () => {
    expect(() =>
      getMode({ DEMO_MODE: "writable", VERCEL_ENV: "production" }),
    ).toThrow();
    expect(getMode({ DEMO_MODE: "1", VERCEL_ENV: "production" })).toBe(
      "demo-readonly",
    );
  });

  test("live mode is not affected by the service key", () => {
    expect(getMode({ SUPABASE_SERVICE_KEY: "unit-test-service-key-value" })).toBe(
      "live",
    );
  });

  test("isDemo and isReadOnlyDemo follow getMode", () => {
    expect(isDemo({})).toBe(false);
    expect(isReadOnlyDemo({})).toBe(false);
    expect(isDemo({ DEMO_MODE: "1" })).toBe(true);
    expect(isReadOnlyDemo({ DEMO_MODE: "1" })).toBe(true);
    expect(isDemo({ DEMO_MODE: "writable" })).toBe(true);
    expect(isReadOnlyDemo({ DEMO_MODE: "writable" })).toBe(false);
  });
});
