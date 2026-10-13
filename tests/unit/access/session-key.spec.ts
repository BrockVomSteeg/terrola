import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { SESSION_SECRET_MIN_LENGTH } from "@/lib/mode";
import {
  COOKIE_MAX_AGE,
  createSessionToken,
  decodeSessionPayload,
  getSessionKey,
  sessionCookieOptions,
  verifySessionToken,
} from "@/lib/session";

// SPEC R18 and ADR 0001 item 6. Every case passes its own env object, so
// nothing here reads or changes the real process environment.

type Env = Record<string, string | undefined>;

const KEY = "unit-test-signing-key-0123456789abcdef";
const OTHER_KEY = "another-unit-test-key-fedcba9876543210";
// Shaped like bcrypt output, built at run time. Never a real hash.
const HASH_A = "$2b$04$" + "a".repeat(53);
const HASH_B = "$2b$04$" + "b".repeat(53);
const ENV: Env = { SESSION_SECRET: KEY, SITE_PASSWORD_HASH: HASH_A };

const now = () => Math.floor(Date.now() / 1000);
const b64url = (text: string) => Buffer.from(text).toString("base64url");

/** Sign a payload the way the app does, with an independent implementation. */
function handSigned(payload: object, key = KEY): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

async function freshPayload() {
  const token = await createSessionToken(undefined, ENV);
  const payload = await decodeSessionPayload(token, ENV);
  if (!token || !payload) throw new Error("could not mint a session");
  return { token, payload };
}

test.describe("session key (R18)", () => {
  test("SESSION_SECRET is the only key: missing or short means no key", () => {
    expect(getSessionKey({})).toBeNull();
    expect(getSessionKey({ SESSION_SECRET: "" })).toBeNull();
    expect(
      getSessionKey({
        SESSION_SECRET: "k".repeat(SESSION_SECRET_MIN_LENGTH - 1),
      }),
    ).toBeNull();
    const exact = "k".repeat(SESSION_SECRET_MIN_LENGTH);
    expect(getSessionKey({ SESSION_SECRET: exact })).toBe(exact);
  });

  test("the password hash never signs a session", async () => {
    const hashOnly: Env = { SITE_PASSWORD_HASH: HASH_A };
    expect(getSessionKey(hashOnly)).toBeNull();
    expect(await createSessionToken(undefined, hashOnly)).toBeNull();
    // A token signed with the hash as the key, as the old fallback did.
    const forged = handSigned(
      { v: 2, iat: now(), exp: now() + COOKIE_MAX_AGE },
      HASH_A,
    );
    expect(await verifySessionToken(forged, hashOnly)).toBe(false);
    expect(await verifySessionToken(forged, ENV)).toBe(false);
  });

  test("no session is minted or accepted without a key", async () => {
    const { token } = await freshPayload();
    const short: Env = { ...ENV, SESSION_SECRET: "too-short-key" };
    expect(await createSessionToken(undefined, short)).toBeNull();
    expect(await verifySessionToken(token, short)).toBe(false);
    expect(await verifySessionToken(token, { SITE_PASSWORD_HASH: HASH_A })).toBe(
      false,
    );
  });

  test("no session is minted or accepted without a password hash", async () => {
    const { token } = await freshPayload();
    const noHash: Env = { SESSION_SECRET: KEY };
    expect(await createSessionToken(undefined, noHash)).toBeNull();
    expect(await verifySessionToken(token, noHash)).toBe(false);
    expect(
      await verifySessionToken(token, {
        ...noHash,
        SITE_PASSWORD_HASH: "not a hash",
      }),
    ).toBe(false);
  });
});

test.describe("session token", () => {
  test("a fresh session verifies and lasts 30 days", async () => {
    const { token, payload } = await freshPayload();
    expect(await verifySessionToken(token, ENV)).toBe(true);
    expect(payload.v).toBe(2);
    expect(payload.exp - payload.iat).toBe(COOKIE_MAX_AGE);
    expect(COOKIE_MAX_AGE).toBe(60 * 60 * 24 * 30);
    expect(Math.abs(payload.iat - now())).toBeLessThan(5);
    expect(payload.person).toBeUndefined();
  });

  test("the signature is HMAC-SHA256 over the payload part", async () => {
    const { token, payload } = await freshPayload();
    expect(handSigned(payload)).toBe(token);
  });

  test("the member id and the original start time survive a re-sign", async () => {
    const iat = now() - 1000;
    const token = await createSessionToken({ person: "member-1", iat }, ENV);
    const payload = await decodeSessionPayload(token, ENV);
    expect(payload?.person).toBe("member-1");
    expect(payload?.iat).toBe(iat);
    expect(payload?.exp).toBe(iat + COOKIE_MAX_AGE);
  });

  test("an expired session is refused", async () => {
    const almost = await createSessionToken(
      { iat: now() - COOKIE_MAX_AGE + 60 },
      ENV,
    );
    expect(await verifySessionToken(almost, ENV)).toBe(true);
    const expired = await createSessionToken(
      { iat: now() - COOKIE_MAX_AGE - 1 },
      ENV,
    );
    expect(expired).toBeTruthy();
    expect(await verifySessionToken(expired, ENV)).toBe(false);
    expect(await decodeSessionPayload(expired, ENV)).toBeNull();
  });

  test("a password change ends every session", async () => {
    const { token } = await freshPayload();
    expect(
      await verifySessionToken(token, { ...ENV, SITE_PASSWORD_HASH: HASH_B }),
    ).toBe(false);
  });

  test("the same hash stored as base64 keeps the session", async () => {
    const { token } = await freshPayload();
    const encoded = Buffer.from(HASH_A).toString("base64");
    expect(
      await verifySessionToken(token, { ...ENV, SITE_PASSWORD_HASH: encoded }),
    ).toBe(true);
  });

  test("a key change ends every session", async () => {
    const { token } = await freshPayload();
    expect(
      await verifySessionToken(token, { ...ENV, SESSION_SECRET: OTHER_KEY }),
    ).toBe(false);
  });

  test("a correctly signed token from the old format is refused", async () => {
    const { payload } = await freshPayload();
    // Version 1 carried no password fingerprint.
    const v1 = handSigned({ v: 1, iat: payload.iat, exp: payload.exp });
    expect(await verifySessionToken(v1, ENV)).toBe(false);
    const noFingerprint = handSigned({
      v: 2,
      iat: payload.iat,
      exp: payload.exp,
    });
    expect(await verifySessionToken(noFingerprint, ENV)).toBe(false);
    const wrongFingerprint = handSigned({ ...payload, pw: "0".repeat(16) });
    expect(await verifySessionToken(wrongFingerprint, ENV)).toBe(false);
    // The control: the same helper with the real payload is accepted.
    expect(await verifySessionToken(handSigned(payload), ENV)).toBe(true);
  });

  test("a correctly signed token with a broken payload is refused", async () => {
    const { payload } = await freshPayload();
    const broken = [
      handSigned({ ...payload, exp: String(payload.exp) }),
      handSigned({ ...payload, exp: undefined }),
      handSigned({ ...payload, iat: "now" }),
      handSigned([payload]),
      `${b64url("null")}.${createHmac("sha256", KEY).update(b64url("null")).digest("base64url")}`,
      `${b64url("{not json")}.${createHmac("sha256", KEY).update(b64url("{not json")).digest("base64url")}`,
    ];
    for (const token of broken) {
      expect(await verifySessionToken(token, ENV), token.slice(0, 16)).toBe(
        false,
      );
    }
  });

  test("a forged, tampered or malformed token is refused and never throws", async () => {
    const { token, payload } = await freshPayload();
    const [body, sig] = token.split(".");
    const longer = b64url(
      JSON.stringify({ ...payload, exp: payload.exp + 86_400 }),
    );
    const bad: (string | null | undefined)[] = [
      undefined,
      null,
      "",
      ".",
      "garbage",
      `${body}.`,
      `.${sig}`,
      `${body}.not-the-real-signature`,
      `${body}.!!!not base64!!!`,
      `${token}x`,
      `${token}=`,
      `${longer}.${sig}`,
      `${body}.${sig}.${sig}`,
      await createSessionToken(undefined, {
        ...ENV,
        SESSION_SECRET: OTHER_KEY,
      }),
    ];
    for (const value of bad) {
      expect(
        await verifySessionToken(value, ENV),
        String(value).slice(0, 24),
      ).toBe(false);
      expect(await decodeSessionPayload(value, ENV)).toBeNull();
    }
  });
});

test.describe("session cookie", () => {
  test("production: the __Host- name, secure, http only, strict, whole site, no domain", () => {
    for (const env of [{ NODE_ENV: "production" }, {}, { NODE_ENV: "staging" }]) {
      const options = sessionCookieOptions(env);
      expect(options).toEqual({
        name: "__Host-app_session",
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: COOKIE_MAX_AGE,
        path: "/",
      });
      expect(options).not.toHaveProperty("domain");
    }
  });

  test("the dev server and tests: plain http works, so no prefix and not secure", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const options = sessionCookieOptions({ NODE_ENV });
      expect(options.name).toBe("app_session");
      expect(options.secure).toBe(false);
      expect(options.httpOnly).toBe(true);
      expect(options.sameSite).toBe("strict");
    }
  });
});
