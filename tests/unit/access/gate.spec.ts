import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { storeError } from "@/app/api/_lib/store-response";
import { DEMO_LOCATIONS } from "@/lib/demo/fixtures";
import { buildCheck, getStore } from "@/lib/demo/gate";
import { demoStore } from "@/lib/demo/memory-store";
import type { Credential, ReadStore, StoreResult } from "@/lib/demo/store";

// The data layer gate (SPEC R17, R3): a demo gets the in-memory store and never even
// loads the live one; live mode hands the caller's credential to the live store, which
// checks it. Every case passes its own environment.

type Env = Record<string, string | undefined>;

const KEY = "unit-test-signing-key-0123456789abcdef";
// Shaped like bcrypt output, built at run time. Never a real hash.
const HASH = "$2b$04$" + "a".repeat(53);
const VALUE = "unit-test-value-that-must-never-be-printed";
const LIVE: Env = { SESSION_SECRET: KEY, SITE_PASSWORD_HASH: HASH, NODE_ENV: "test" };

const DEMOS: [Env, "demo-readonly" | "demo-writable"][] = [
  [{ DEMO_MODE: "1" }, "demo-readonly"],
  [{ DEMO_MODE: "1", NODE_ENV: "production" }, "demo-readonly"],
  [{ DEMO_MODE: "true", NODE_ENV: "production", VERCEL: "1" }, "demo-readonly"],
  [{ DEMO_MODE: "writable", NODE_ENV: "test" }, "demo-writable"],
];

const REFUSED: Env[] = [
  { DEMO_MODE: "1", SESSION_SECRET: KEY },
  { DEMO_MODE: "1", SUPABASE_SERVICE_KEY: VALUE },
  { DEMO_MODE: "writable", NODE_ENV: "production" },
  { DEMO_MODE: "writable", NODE_ENV: "test", VERCEL: "1" },
];

const CREDENTIALS: Credential[] = [
  { kind: "session", token: undefined },
  { kind: "session", token: "not-a-session" },
  { kind: "cron", authorization: null },
  { kind: "cron", authorization: "Bearer not-the-secret" },
];

/** Stands in for the live store's opener and records every call. */
function liveOpener(answer: StoreResult<ReadStore> | Error) {
  const calls: { credential: Credential; env: Env }[] = [];
  return {
    calls,
    openLive: async (credential: Credential, env: Env) => {
      calls.push({ credential, env });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const FAKE_LIVE: ReadStore = demoStore("demo-readonly");

test.describe("the gate in a demo", () => {
  for (const [env, mode] of DEMOS) {
    test(`${JSON.stringify(env)} gets the memory store and never opens the live one`, async () => {
      for (const credential of CREDENTIALS) {
        const live = liveOpener({ ok: true, data: FAKE_LIVE });
        const result = await getStore(credential, { env, openLive: live.openLive });
        expect(result.ok && result.data).toBe(demoStore(mode));
        expect(live.calls).toEqual([]);
      }
    });
  }

  test("works with no live store to load at all", async () => {
    // No opener is passed. If the gate tried to load the real live store here, the
    // load would fail in this test run and the answer would be `failed`.
    const result = await getStore({ kind: "session", token: undefined }, { env: { DEMO_MODE: "1" } });
    expect(result.ok).toBe(true);
    const listed = result.ok ? await result.data.listLocations() : null;
    expect(listed?.ok && listed.data.map((l) => l.id)).toEqual(
      DEMO_LOCATIONS.map((l) => l.id),
    );
  });
});

test.describe("the gate in live mode", () => {
  test("hands the credential to the live store once and passes its answer on", async () => {
    for (const credential of CREDENTIALS) {
      const live = liveOpener({ ok: true, data: FAKE_LIVE });
      const result = await getStore(credential, { env: LIVE, openLive: live.openLive });
      expect(result).toEqual({ ok: true, data: FAKE_LIVE });
      expect(live.calls).toEqual([{ credential, env: LIVE }]);
    }
  });

  test("passes a refusal on, and never falls back to the demo data", async () => {
    const live = liveOpener({ ok: false, error: { code: "unauthorized" } });
    const result = await getStore(
      { kind: "session", token: "not-a-session" },
      { env: LIVE, openLive: live.openLive },
    );
    expect(result).toEqual({ ok: false, error: { code: "unauthorized" } });
  });

  test("answers failed, and does not throw, when the live store cannot be opened", async () => {
    const live = liveOpener(new Error("the database is unreachable: " + VALUE));
    const result = await getStore(
      { kind: "session", token: "x" },
      { env: LIVE, openLive: live.openLive },
    );
    expect(result).toEqual({ ok: false, error: { code: "failed" } });
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  test("an unset or switched off DEMO_MODE is live, never the demo", async () => {
    for (const DEMO_MODE of [undefined, "", "0", "false", "off"]) {
      const live = liveOpener({ ok: false, error: { code: "unauthorized" } });
      const result = await getStore(
        { kind: "session", token: undefined },
        { env: { ...LIVE, DEMO_MODE }, openLive: live.openLive },
      );
      expect(result.ok, String(DEMO_MODE)).toBe(false);
      expect(live.calls, String(DEMO_MODE)).toHaveLength(1);
    }
  });
});

test.describe("a refused configuration", () => {
  for (const env of REFUSED) {
    test(`${JSON.stringify(Object.keys(env))} gets no store of either kind`, async () => {
      for (const credential of CREDENTIALS) {
        const live = liveOpener({ ok: true, data: FAKE_LIVE });
        const result = await getStore(credential, { env, openLive: live.openLive });
        expect(result).toEqual({ ok: false, error: { code: "failed" } });
        expect(live.calls).toEqual([]);
      }
    });
  }
});

test.describe("the build check", () => {
  test("stops a demo next to a live variable and names it without its value", () => {
    let message = "";
    try {
      buildCheck({ DEMO_MODE: "1", SUPABASE_URL: VALUE });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("SUPABASE_URL");
    expect(message).not.toContain(VALUE);
  });

  test("lets a live build and a writable demo build through", () => {
    expect(() => buildCheck({})).not.toThrow();
    expect(() => buildCheck(LIVE)).not.toThrow();
    // A build always runs as production; the runtime rule is not asked here.
    expect(() => buildCheck({ DEMO_MODE: "writable", NODE_ENV: "production" })).not.toThrow();
  });

  test("runs when the gate module is loaded", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "lib/demo/gate.ts"), "utf8");
    expect(source.split("\n")).toContain("buildCheck();");
  });
});

test.describe("a store refusal as an HTTP answer", () => {
  const CASES: [Parameters<typeof storeError>[0], number, string][] = [
    ["not_found", 404, "Location not found"],
    ["read_only", 403, "demo_read_only"],
    ["unauthorized", 401, "Session expired. Please re-enter the password."],
    ["unsupported", 501, "not_supported_in_demo"],
    ["failed", 500, "Failed to load things"],
  ];

  for (const [code, status, error] of CASES) {
    test(`${code} answers ${status} and is never cached`, async () => {
      const res = storeError(code, "Failed to load things");
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  }
});

// A text check, so it is a tripwire and not a proof: the read paths go through the
// gate and do not reach for the database themselves.
test.describe("the read paths ask the gate", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

  /** The source of one exported handler, up to the next export. */
  function handler(source: string, name: string): string {
    const start = source.indexOf(`export async function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const next = source.indexOf("\nexport ", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  for (const file of [
    "app/api/locations/route.ts",
    "app/api/locations/[id]/route.ts",
    "app/api/locations/[id]/photo/route.ts",
    "app/api/keep-alive/route.ts",
  ]) {
    test(`GET in ${file}`, () => {
      const get = handler(read(file), "GET");
      expect(get).toContain("getStore(");
      expect(get).not.toContain("getSupabaseAdmin");
      expect(get).not.toMatch(/supabase/i);
    });
  }

  test("the map page", () => {
    const page = read("app/map/page.tsx");
    expect(page).toContain("getStore(");
    expect(page).not.toMatch(/supabase/i);
    expect(page).toContain('export const dynamic = "force-dynamic";');
    expect(page).not.toContain("revalidate");
  });
});
