import { test, expect } from "@playwright/test";
import { CRON_SECRET_MIN_LENGTH, keepAlive } from "@/app/api/_lib/cron";

// SPEC R19: keep-alive needs a cron secret and returns no error text.

type Env = Record<string, string | undefined>;

const SECRET = "unit-test-cron-secret-0123456789";
const ENV: Env = { CRON_SECRET: SECRET };

function pinger(fail?: string) {
  const state = { calls: 0 };
  return {
    state,
    ping: async () => {
      state.calls++;
      if (fail) throw new Error(fail);
    },
  };
}

test.describe("keep-alive (R19)", () => {
  test("the right secret reaches the database and answers alive, nothing else", async () => {
    const { state, ping } = pinger();
    const res = await keepAlive(`Bearer ${SECRET}`, { env: ENV, ping });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "alive" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.calls).toBe(1);
  });

  const REFUSED: [string, string | null][] = [
    ["no header", null],
    ["an empty header", ""],
    ["the bare secret", SECRET],
    ["another scheme", `Basic ${SECRET}`],
    ["a wrong secret", `Bearer ${SECRET.slice(0, -1)}x`],
    ["a longer secret", `Bearer ${SECRET}x`],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, 16)}`],
    ["a lower case scheme", `bearer ${SECRET}`],
  ];

  for (const [label, header] of REFUSED) {
    test(`${label} gets 401 with an empty body and never reaches the database`, async () => {
      const { state, ping } = pinger();
      const res = await keepAlive(header, { env: ENV, ping });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
      expect(state.calls).toBe(0);
    });
  }

  test("with no secret configured nothing matches, not even the text a missing value prints as", async () => {
    for (const env of [{}, { CRON_SECRET: "" }]) {
      for (const header of [null, "Bearer ", "Bearer undefined", "Bearer null"]) {
        const { state, ping } = pinger();
        const res = await keepAlive(header, { env, ping });
        expect(res.status, String(header)).toBe(401);
        expect(await res.text()).toBe("");
        expect(state.calls).toBe(0);
      }
    }
  });

  test("a secret that is too short is treated as no secret", async () => {
    const short = "s".repeat(CRON_SECRET_MIN_LENGTH - 1);
    const { state, ping } = pinger();
    const res = await keepAlive(`Bearer ${short}`, {
      env: { CRON_SECRET: short },
      ping,
    });
    expect(res.status).toBe(401);
    expect(state.calls).toBe(0);
  });

  test("a failure answers 500 with a fixed body and no error text", async () => {
    const reason = "connection refused at db.internal:5432 for role admin";
    const { ping } = pinger(reason);
    const res = await keepAlive(`Bearer ${SECRET}`, { env: ENV, ping });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "error" });
    expect(text).not.toContain("refused");
    expect(text).not.toContain(SECRET);
  });

  test("a demo has no database: 404 after the secret check, and no ping", async () => {
    for (const DEMO_MODE of ["1", "writable"]) {
      const env: Env = { ...ENV, DEMO_MODE, NODE_ENV: "test" };
      const { state, ping } = pinger();
      const unknown = await keepAlive("Bearer wrong", { env, ping });
      expect(unknown.status).toBe(401);
      const res = await keepAlive(`Bearer ${SECRET}`, { env, ping });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
      expect(state.calls).toBe(0);
    }
  });

  test("a configuration that must not run answers the fixed error, with no names or values", async () => {
    const { state, ping } = pinger();
    const res = await keepAlive(`Bearer ${SECRET}`, {
      env: { ...ENV, DEMO_MODE: "1", SESSION_SECRET: "a-live-value-next-to-a-demo" },
      ping,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: "error" });
    expect(state.calls).toBe(0);
  });
});
