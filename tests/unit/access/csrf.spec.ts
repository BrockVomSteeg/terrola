import { test, expect } from "@playwright/test";
import { NextRequest, NextResponse } from "next/server";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  checkCsrf,
  csrfTokenFor,
  setCsrfCookie,
} from "@/app/api/_lib/csrf";
import {
  DELETE as forgetMember,
  POST as chooseMember,
} from "@/app/api/identity/route";
import { COOKIE_MAX_AGE, COOKIE_NAME, createSessionToken } from "@/lib/session";

// The write token (ADR 0001 item 7): in live mode a write needs a valid session AND the
// token made from exactly that session. Every case passes its own environment, so
// nothing here reads or changes the real one.

type Env = Record<string, string | undefined>;

const KEY = "unit-test-signing-key-0123456789abcdef";
const OTHER_KEY = "another-unit-test-key-fedcba9876543210";
// Shaped like bcrypt output, built at run time. Never a real hash.
const HASH = "$2b$04$" + "a".repeat(53);
const OTHER_HASH = "$2b$04$" + "b".repeat(53);
const LIVE: Env = { SESSION_SECRET: KEY, SITE_PASSWORD_HASH: HASH, NODE_ENV: "test" };
const HEX64 = /^[0-9a-f]{64}$/;

const now = () => Math.floor(Date.now() / 1000);

/** A session that verifies under `env`. `age` is how many seconds ago it started. */
async function session(
  opts: { age?: number; person?: string } = {},
  env: Env = LIVE,
): Promise<string> {
  const token = await createSessionToken(
    { iat: now() - (opts.age ?? 60), person: opts.person },
    env,
  );
  if (!token) throw new Error("the test environment cannot sign a session");
  return token;
}

async function tokenFor(sessionToken: string, env: Env = LIVE): Promise<string> {
  const token = await csrfTokenFor(sessionToken, env);
  if (!token) throw new Error("the test environment cannot make a write token");
  return token;
}

/** A write as a browser would send it. */
function write(parts: {
  session?: string;
  header?: string;
  cookieName?: string;
  planted?: string;
}): NextRequest {
  const cookies: string[] = [];
  if (parts.session !== undefined) {
    cookies.push(`${parts.cookieName ?? "app_session"}=${parts.session}`);
  }
  if (parts.planted !== undefined) cookies.push(`${CSRF_COOKIE}=${parts.planted}`);
  const headers: Record<string, string> = {};
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  if (parts.header !== undefined) headers[CSRF_HEADER] = parts.header;
  return new NextRequest("http://localhost/api/locations", {
    method: "POST",
    headers,
  });
}

const allowed = async (request: NextRequest, env: Env = LIVE): Promise<boolean> =>
  (await checkCsrf(request, env)).ok;

test.describe("the write token", () => {
  test("is 64 lowercase hex characters and the same every time for one session", async () => {
    const s = await session();
    const token = await tokenFor(s);
    expect(token).toMatch(HEX64);
    expect(await tokenFor(s)).toBe(token);
  });

  test("differs for another session, another member and another key", async () => {
    const s = await session({ age: 60 });
    const token = await tokenFor(s);
    expect(await tokenFor(await session({ age: 61 }))).not.toBe(token);
    expect(await tokenFor(await session({ age: 60, person: "member-1" }))).not.toBe(
      token,
    );
    expect(await tokenFor(s, { ...LIVE, SESSION_SECRET: OTHER_KEY })).not.toBe(token);
  });

  test("does not exist without a signing key or without a session value", async () => {
    const s = await session();
    expect(await csrfTokenFor(s, {})).toBeNull();
    expect(await csrfTokenFor(s, { SESSION_SECRET: "only-sixteen-chr" })).toBeNull();
    for (const value of [undefined, null, "", "no-dot-in-here", ".starts-with-a-dot"]) {
      expect(await csrfTokenFor(value, LIVE), String(value)).toBeNull();
    }
  });

  test("is not the session's own signature in another spelling", async () => {
    const s = await session();
    const signature = Buffer.from(s.slice(s.indexOf(".") + 1), "base64url").toString("hex");
    expect(signature).toMatch(HEX64);
    expect(await tokenFor(s)).not.toBe(signature);
    // And the signature does not work as a write token.
    expect(await allowed(write({ session: s, header: signature }))).toBe(false);
  });
});

test.describe("a write in live mode", () => {
  test("goes on with a valid session and the token for that session", async () => {
    const s = await session();
    expect(await allowed(write({ session: s, header: await tokenFor(s) }))).toBe(true);
  });

  test("is refused without the header, or with a header that is not the token", async () => {
    const s = await session();
    const token = await tokenFor(s);
    const flipped = (token[0] === "0" ? "1" : "0") + token.slice(1);
    for (const header of [
      undefined,
      "",
      "not-a-token",
      token.toUpperCase(),
      token + "0",
      token.slice(1),
      flipped,
      "0".repeat(64),
    ]) {
      expect(await allowed(write({ session: s, header })), String(header)).toBe(false);
    }
  });

  test("is refused with the token of another session", async () => {
    const mine = await session({ age: 60 });
    const theirs = await session({ age: 61 });
    expect(await allowed(write({ session: mine, header: await tokenFor(theirs) }))).toBe(
      false,
    );
  });

  // The old check compared the header with the app_csrf cookie. A page on a sibling
  // domain can plant a cookie, so an equal pair proves nothing.
  test("is refused when the header only equals a planted app_csrf cookie", async () => {
    const s = await session();
    const planted = "ab".repeat(32);
    expect(await allowed(write({ session: s, header: planted, planted }))).toBe(false);
    expect(await allowed(write({ header: planted, planted }))).toBe(false);
    // The cookie is not read at all: the right header passes next to a wrong cookie.
    expect(
      await allowed(write({ session: s, header: await tokenFor(s), planted })),
    ).toBe(true);
  });

  test("is refused when the session is missing, forged, expired or from another key", async () => {
    const s = await session();
    const token = await tokenFor(s);
    expect(await allowed(write({ header: token }))).toBe(false);

    const tampered = `${s}x`;
    expect(await allowed(write({ session: tampered, header: token }))).toBe(false);

    // Expired one second ago. Its token is the right one for it, and still no.
    const expired = await session({ age: COOKIE_MAX_AGE + 1 });
    expect(
      await allowed(write({ session: expired, header: await tokenFor(expired) })),
    ).toBe(false);

    // Signed under another key, with the token made under that key.
    const foreignEnv: Env = { ...LIVE, SESSION_SECRET: OTHER_KEY };
    const foreign = await session({}, foreignEnv);
    expect(
      await allowed(
        write({ session: foreign, header: await tokenFor(foreign, foreignEnv) }),
      ),
    ).toBe(false);
  });

  test("is refused after the password changed", async () => {
    const s = await session();
    const token = await tokenFor(s);
    const changed: Env = { ...LIVE, SITE_PASSWORD_HASH: OTHER_HASH };
    expect(await allowed(write({ session: s, header: token }), changed)).toBe(false);
  });

  test("needs the new token once the session has been signed again", async () => {
    const before = await session({ age: 60 });
    const after = await session({ age: 60, person: "member-1" });
    const oldToken = await tokenFor(before);
    const newToken = await tokenFor(after);
    expect(await allowed(write({ session: after, header: oldToken }))).toBe(false);
    expect(await allowed(write({ session: after, header: newToken }))).toBe(true);
  });

  test("is refused when no signing key is configured", async () => {
    const s = await session();
    const token = await tokenFor(s);
    for (const env of [
      { SITE_PASSWORD_HASH: HASH, NODE_ENV: "test" },
      { ...LIVE, SESSION_SECRET: "only-sixteen-chr" },
    ]) {
      expect(await allowed(write({ session: s, header: token }), env)).toBe(false);
    }
  });

  test("in production reads the session from the __Host- cookie only", async () => {
    const env: Env = { ...LIVE, NODE_ENV: "production" };
    const s = await session({}, env);
    const header = await tokenFor(s, env);
    expect(
      await allowed(write({ session: s, header, cookieName: "__Host-app_session" }), env),
    ).toBe(true);
    expect(
      await allowed(write({ session: s, header, cookieName: "app_session" }), env),
    ).toBe(false);
  });
});

test.describe("a write in a demo", () => {
  test("has no token to show: the proxy's cross site check is the control", async () => {
    for (const env of [
      { DEMO_MODE: "1" },
      { DEMO_MODE: "1", NODE_ENV: "production" },
      { DEMO_MODE: "writable", NODE_ENV: "test" },
    ]) {
      expect(await allowed(write({}), env), JSON.stringify(env)).toBe(true);
    }
  });

  test("is refused when the demo configuration itself is refused", async () => {
    for (const env of [
      { DEMO_MODE: "1", SESSION_SECRET: KEY },
      { DEMO_MODE: "writable", NODE_ENV: "production" },
      { DEMO_MODE: "writable", NODE_ENV: "test", VERCEL: "1" },
    ]) {
      expect(await allowed(write({}), env), JSON.stringify(env)).toBe(false);
    }
  });
});

test.describe("the token cookie", () => {
  const header = (env: Env): string => {
    const response = NextResponse.json({});
    setCsrfCookie(response, "ab".repeat(32), env);
    return (
      response.headers.getSetCookie().find((c) => c.startsWith(`${CSRF_COOKIE}=`)) ?? ""
    );
  };

  test("can be read by the page, goes to this site only and lasts as long as a session", () => {
    const value = header(LIVE);
    expect(value).toContain(`${CSRF_COOKIE}=${"ab".repeat(32)}`);
    expect(value).not.toMatch(/;\s*HttpOnly/i);
    expect(value).toMatch(/;\s*SameSite=strict/i);
    expect(value).toMatch(/;\s*Path=\/(;|$)/i);
    expect(value).toMatch(new RegExp(`;\\s*Max-Age=${COOKIE_MAX_AGE}`, "i"));
    expect(value).not.toMatch(/;\s*Domain=/i);
  });

  test("is Secure wherever the session cookie is", () => {
    expect(header({ ...LIVE, NODE_ENV: "production" })).toMatch(/;\s*Secure/i);
    expect(header({ ...LIVE, NODE_ENV: "test" })).not.toMatch(/;\s*Secure/i);
  });
});

// The identity route signs the session again, which changes the token. If it did not
// hand out the new one, every write after choosing a member would be refused.
test.describe("signing the session again", () => {
  // The route reads the real environment, so this test sets it.
  const env = process.env as Record<string, string | undefined>;
  const NAMES = ["SESSION_SECRET", "SITE_PASSWORD_HASH", "DEMO_MODE", "MEMBERS"];
  let saved: Record<string, string | undefined> = {};

  test.beforeEach(() => {
    saved = Object.fromEntries(NAMES.map((name) => [name, env[name]]));
    for (const name of NAMES) delete env[name];
    env.SESSION_SECRET = KEY;
    env.SITE_PASSWORD_HASH = HASH;
  });
  test.afterEach(() => {
    for (const name of NAMES) {
      const value = saved[name];
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  });

  const call = (method: "POST" | "DELETE", sessionToken: string, header: string) =>
    new NextRequest("http://localhost/api/identity", {
      method,
      headers: {
        cookie: `${COOKIE_NAME}=${sessionToken}`,
        [CSRF_HEADER]: header,
        "content-type": "application/json",
      },
      ...(method === "POST" ? { body: JSON.stringify({ person: "member-1" }) } : {}),
    });

  test("hands out the token for the new session, and the old token stops working", async () => {
    const first = await session({ age: 60 }, env);
    const firstToken = await tokenFor(first, env);

    const chosen = await chooseMember(call("POST", first, firstToken));
    expect(chosen.status).toBe(200);
    const second = chosen.cookies.get(COOKIE_NAME)?.value ?? "";
    expect(second).not.toBe("");
    expect(second).not.toBe(first);
    const secondToken = chosen.cookies.get(CSRF_COOKIE)?.value ?? "";
    expect(secondToken).toBe(await tokenFor(second, env));
    expect(secondToken).not.toBe(firstToken);

    // The browser now holds the second session. The first token no longer fits it.
    const stale = await forgetMember(call("DELETE", second, firstToken));
    expect(stale.status).toBe(403);
    expect(stale.headers.getSetCookie()).toEqual([]);

    const forgotten = await forgetMember(call("DELETE", second, secondToken));
    expect(forgotten.status).toBe(200);
    const third = forgotten.cookies.get(COOKIE_NAME)?.value ?? "";
    expect(forgotten.cookies.get(CSRF_COOKIE)?.value).toBe(await tokenFor(third, env));
  });

  test("refuses a write with no token or no session before it signs anything", async () => {
    const first = await session({ age: 60 }, env);
    const firstToken = await tokenFor(first, env);
    for (const request of [
      call("POST", first, "0".repeat(64)),
      call("POST", `${first}x`, firstToken),
      call("DELETE", first, ""),
    ]) {
      const res = await chooseOrForget(request);
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  const chooseOrForget = (request: NextRequest) =>
    request.method === "POST" ? chooseMember(request) : forgetMember(request);
});
