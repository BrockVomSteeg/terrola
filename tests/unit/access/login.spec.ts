import { test, expect } from "@playwright/test";
import bcrypt from "bcryptjs";
import {
  LOGIN_LIMITS,
  PASSWORD_MAX_BYTES,
  login,
  type LoginDeps,
} from "@/app/api/_lib/login";
import { CSRF_COOKIE } from "@/app/api/_lib/csrf";
import { createLimiter } from "@/app/api/_lib/rate-limit";
import { verifySessionToken } from "@/lib/session";

// The login decision (SPEC R18, ADR 0001 item 6), driven directly: no server,
// no network. Every case builds its own environment, limits and password check.

type Env = Record<string, string | undefined>;

const KEY = "unit-test-signing-key-0123456789abcdef";
const PASSWORD = "correct horse battery staple";
// Shaped like bcrypt output, built at run time. Never a real hash.
const HASH = "$2b$04$" + "a".repeat(53);
const LIVE: Env = { SESSION_SECRET: KEY, SITE_PASSWORD_HASH: HASH, NODE_ENV: "test" };
const ON_VERCEL: Env = { ...LIVE, VERCEL: "1" };
const CLIENT_A = { "x-vercel-forwarded-for": "203.0.113.7" };
const CLIENT_B = { "x-vercel-forwarded-for": "203.0.113.8" };

function setup(env: Env, verify?: LoginDeps["verifyPassword"]) {
  const seen: string[] = [];
  const deps: LoginDeps = {
    env,
    perClient: createLimiter(LOGIN_LIMITS.perClient),
    everyone: createLimiter(LOGIN_LIMITS.everyone),
    verifyPassword: async (submitted, storedHash) => {
      seen.push(submitted);
      return verify ? verify(submitted, storedHash) : submitted === PASSWORD;
    },
  };
  return { deps, seen };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const attempt = (
  deps: LoginDeps,
  password: unknown,
  headers: Record<string, string> = {},
) =>
  login(post({ password }, headers), deps);

test.describe("login: what is checked before the password", () => {
  for (const DEMO_MODE of ["1", "writable"]) {
    test(`DEMO_MODE=${DEMO_MODE} has no login: 404 and no password check`, async () => {
      const { deps, seen } = setup({ DEMO_MODE, NODE_ENV: "test" });
      const res = await attempt(deps, PASSWORD);
      expect(res.status).toBe(404);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(seen).toEqual([]);
    });
  }

  test("a demo next to a live variable answers 503 with names only", async () => {
    const { deps, seen } = setup({ ...LIVE, DEMO_MODE: "1" });
    const res = await attempt(deps, PASSWORD);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("SESSION_SECRET");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(HASH);
    expect(seen).toEqual([]);
  });

  for (const [label, secret] of [
    ["missing", undefined],
    ["short", "only-sixteen-chr"],
  ] as const) {
    test(`a ${label} signing key answers 503 before the password is looked at (R18)`, async () => {
      const { deps, seen } = setup({ ...LIVE, SESSION_SECRET: secret });
      const res = await attempt(deps, PASSWORD);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain("SESSION_SECRET");
      if (secret) expect(text).not.toContain(secret);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(res.headers.get("cache-control")).toBe("no-store");
      // The right password was sent and never checked.
      expect(seen).toEqual([]);
    });
  }

  test("a body that is not a short JSON object with a password is refused", async () => {
    const { deps, seen } = setup(LIVE);
    const bad: [unknown, number][] = [
      ["{not json", 400],
      ["", 400],
      ["null", 400],
      ['"just a string"', 400],
      [{}, 400],
      [{ password: "" }, 400],
      [{ password: 12345 }, 400],
      [{ password: [PASSWORD] }, 400],
      [{ password: null }, 400],
      [{ password: "x".repeat(5000) }, 400],
    ];
    for (const [body, status] of bad) {
      const res = await login(post(body), deps);
      expect(res.status, JSON.stringify(body).slice(0, 30)).toBe(status);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    // A body with no declared length is dropped once it passes the cap: the
    // stream below would go on for 400 MB if it were read to the end.
    let pulled = 0;
    const endless = new Request("http://localhost/api/auth", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          if (pulled > 100_000) controller.close();
          else controller.enqueue(new Uint8Array(4096).fill(120));
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect((await login(endless, deps)).status).toBe(400);
    expect(pulled).toBeLessThan(10);

    // A body that declares itself too long is refused without being read.
    const oversized = {
      headers: new Headers({ "content-length": "999999" }),
      text: async () => {
        throw new Error("the body must not be read");
      },
    } as unknown as Request;
    const declared = await login(oversized, deps);
    expect(declared.status).toBe(400);
    expect(await declared.json()).toEqual({ error: "Invalid request" });
    expect(seen).toEqual([]);
  });

  test("a password over 72 bytes is refused, counted in bytes, not characters", async () => {
    const { deps, seen } = setup(LIVE);
    const fits = "x".repeat(PASSWORD_MAX_BYTES);
    expect((await attempt(deps, fits)).status).toBe(401);
    expect(seen).toEqual([fits]);

    for (const tooLong of [
      "x".repeat(PASSWORD_MAX_BYTES + 1),
      "é".repeat(37), // 37 characters, 74 bytes
      PASSWORD + " ".repeat(60),
    ]) {
      const res = await attempt(deps, tooLong);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("72");
    }
    expect(seen).toEqual([fits]);
  });

  test("no password hash configured answers 503 naming the variable", async () => {
    const { deps, seen } = setup({ ...LIVE, SITE_PASSWORD_HASH: undefined });
    const res = await attempt(deps, PASSWORD);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("SITE_PASSWORD_HASH");
    expect(seen).toEqual([]);
  });
});

test.describe("login: the password and the session", () => {
  test("a wrong password answers 401 and sets nothing", async () => {
    const { deps } = setup(LIVE);
    const res = await attempt(deps, "wrong");
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("a check that does not answer exactly true is not a login", async () => {
    for (const result of ["yes", 1, {}, null, undefined]) {
      const { deps } = setup(LIVE, async () => result as unknown as boolean);
      const res = await attempt(deps, PASSWORD);
      expect(res.status, String(result)).toBe(401);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    const { deps } = setup(LIVE, async () => {
      throw new Error("the hash is damaged: " + HASH);
    });
    const res = await attempt(deps, PASSWORD);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("damaged");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("the right password opens a session that verifies", async () => {
    const { deps } = setup(LIVE);
    const res = await attempt(deps, PASSWORD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(res.headers.get("cache-control")).toBe("no-store");

    const session = res.cookies.get("app_session");
    expect(await verifySessionToken(session?.value, LIVE)).toBe(true);
    const header =
      res.headers.getSetCookie().find((c) => c.startsWith("app_session=")) ?? "";
    expect(header).toMatch(/;\s*HttpOnly/i);
    expect(header).toMatch(/;\s*SameSite=strict/i);
    expect(header).toMatch(/;\s*Path=\/(;|$)/i);
    expect(header).toMatch(/;\s*Max-Age=2592000/i);
    expect(header).not.toMatch(/;\s*Domain=/i);

    const csrf = res.cookies.get(CSRF_COOKIE);
    expect(csrf?.value).toMatch(/^[0-9a-f]{64}$/);
    // The password, the key and the hash appear nowhere in the answer.
    const everything = JSON.stringify([...res.headers.entries()]);
    for (const secret of [PASSWORD, KEY, HASH]) {
      expect(everything).not.toContain(secret);
    }
  });

  test("in production the session cookie has the __Host- name and is secure", async () => {
    const env: Env = { ...LIVE, NODE_ENV: "production" };
    const { deps } = setup(env);
    const res = await attempt(deps, PASSWORD);
    expect(res.status).toBe(200);
    const header =
      res.headers
        .getSetCookie()
        .find((c) => c.startsWith("__Host-app_session=")) ?? "";
    expect(header).toMatch(/;\s*Secure/i);
    expect(header).toMatch(/;\s*Path=\/(;|$)/i);
    expect(header).not.toMatch(/;\s*Domain=/i);
    expect(
      await verifySessionToken(res.cookies.get("__Host-app_session")?.value, env),
    ).toBe(true);
  });

  test("a stored value that is not a bcrypt hash never opens a session", async () => {
    // Even if the password check were to say yes.
    const { deps } = setup({ ...LIVE, SITE_PASSWORD_HASH: "not a hash" }, async () => true);
    const res = await attempt(deps, PASSWORD);
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("with real bcrypt: the right password opens a session, a near miss does not", async () => {
    const hash = bcrypt.hashSync(PASSWORD, 4);
    const env: Env = { ...LIVE, SITE_PASSWORD_HASH: hash };
    const { deps } = setup(env, (submitted, stored) =>
      bcrypt.compare(submitted, stored),
    );
    expect((await attempt(deps, PASSWORD + "!")).status).toBe(401);
    expect((await attempt(deps, PASSWORD.toUpperCase())).status).toBe(401);
    const res = await attempt(deps, PASSWORD);
    expect(res.status).toBe(200);
    expect(
      await verifySessionToken(res.cookies.get("app_session")?.value, env),
    ).toBe(true);
  });
});

test.describe("login: limits", () => {
  const perClient = LOGIN_LIMITS.perClient.limit;
  const everyone = LOGIN_LIMITS.everyone.limit;

  test("the limits are 5 per client and 60 for everyone, per 15 minutes", () => {
    expect(LOGIN_LIMITS.perClient).toEqual({ limit: 5, windowMs: 900_000 });
    expect(LOGIN_LIMITS.everyone).toEqual({ limit: 60, windowMs: 900_000 });
  });

  test("on Vercel one client gets five tries, then 429 without a password check", async () => {
    const { deps, seen } = setup(ON_VERCEL);
    for (let i = 0; i < perClient; i++) {
      expect((await attempt(deps, "wrong", CLIENT_A)).status).toBe(401);
    }
    // Even the right password is refused now, and never checked.
    const res = await attempt(deps, PASSWORD, CLIENT_A);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(900);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(seen).toHaveLength(perClient);
    // Another client is not affected.
    expect((await attempt(deps, PASSWORD, CLIENT_B)).status).toBe(200);
  });

  test("a header the caller can forge does not buy a fresh count", async () => {
    const { deps, seen } = setup(ON_VERCEL);
    for (let i = 0; i < perClient + 10; i++) {
      await attempt(deps, "wrong", {
        ...CLIENT_A,
        "x-forwarded-for": `198.51.100.${i}`,
      });
    }
    expect(seen).toHaveLength(perClient);
  });

  test("a burst of parallel requests is counted one by one", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { deps, seen } = setup(ON_VERCEL, async () => {
      await gate;
      return false;
    });
    const burst = Array.from({ length: 20 }, () =>
      attempt(deps, "wrong", CLIENT_A),
    );
    // Give every request time to reach the password check before any finishes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const statuses = (await Promise.all(burst)).map((r) => r.status).sort();
    expect(seen).toHaveLength(perClient);
    expect(statuses.filter((s) => s === 401)).toHaveLength(perClient);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20 - perClient);
  });

  test("the right password clears the client's own count", async () => {
    const { deps } = setup(ON_VERCEL);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < perClient - 1; i++) {
        expect((await attempt(deps, "wrong", CLIENT_A)).status).toBe(401);
      }
      expect((await attempt(deps, PASSWORD, CLIENT_A)).status).toBe(200);
    }
  });

  test("off Vercel no address is trusted: only the limit for everyone applies", async () => {
    const { deps, seen } = setup(LIVE);
    for (let i = 0; i < everyone; i++) {
      const res = await attempt(deps, "wrong", {
        "x-forwarded-for": "198.51.100.1",
        "x-real-ip": "198.51.100.1",
        "x-vercel-forwarded-for": "198.51.100.1",
      });
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    const res = await attempt(deps, PASSWORD);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(seen).toHaveLength(everyone);
    expect(deps.perClient.size()).toBe(0);
  });

  test("on Vercel many clients together still hit the limit for everyone", async () => {
    const { deps, seen } = setup(ON_VERCEL);
    for (let i = 0; i < everyone; i++) {
      const res = await attempt(deps, "wrong", {
        "x-vercel-forwarded-for": `203.0.113.${i}`,
      });
      expect(res.status).toBe(401);
    }
    const res = await attempt(deps, PASSWORD, {
      "x-vercel-forwarded-for": "198.51.100.200",
    });
    expect(res.status).toBe(429);
    expect(seen).toHaveLength(everyone);
  });

  test("one client that is already refused does not use up the limit for everyone", async () => {
    const { deps } = setup(ON_VERCEL);
    for (let i = 0; i < everyone * 2; i++) {
      await attempt(deps, "wrong", CLIENT_A);
    }
    expect((await attempt(deps, PASSWORD, CLIENT_B)).status).toBe(200);
  });

  test("a refused request, a demo and a missing key do not count", async () => {
    const { deps: demo } = setup({ DEMO_MODE: "1" });
    const { deps: noKey } = setup({ ...ON_VERCEL, SESSION_SECRET: undefined });
    for (const deps of [demo, noKey]) {
      await attempt(deps, PASSWORD, CLIENT_A);
      expect(deps.perClient.size()).toBe(0);
      expect(deps.everyone.size()).toBe(0);
    }
  });
});
