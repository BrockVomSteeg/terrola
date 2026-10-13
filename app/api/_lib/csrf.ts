// Web-standard APIs only (no node:crypto), so the proxy and the unit tests can
// load this file.
//
// Two checks stand between another site and a write:
//
//   1. the proxy refuses a write the browser marks as started elsewhere
//      (Sec-Fetch-Site, then Origin). That check runs in every mode.
//   2. in live mode every write also carries a token tied to the session:
//      HMAC(SESSION_SECRET, "csrf:" + the signed part of the session cookie).
//      The server recomputes it from the session cookie, so nothing a page on
//      another site can set (a planted cookie, a guessed value) makes one.
//
// A demo has no session, so it has no token and sets no cookie: the proxy check is
// the demo check, and the read only demo refuses every write anyway (SPEC R4).
import type { NextRequest, NextResponse } from "next/server";
import { getMode } from "@/lib/mode";
import {
  COOKIE_MAX_AGE,
  getSessionKey,
  sessionCookieOptions,
  verifySessionToken,
} from "@/lib/session";

type Env = Record<string, string | undefined>;

export const CSRF_COOKIE = "app_csrf";
export const CSRF_HEADER = "x-csrf-token";

const TOKEN_SHAPE = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

/**
 * The token for one session cookie value, as 64 lowercase hex characters. Null when
 * there is no signing key or the value is not shaped like a session token. It does
 * not check that the session is valid; checkCsrf does.
 *
 * The signed text starts with "csrf:". A session signature covers base64url text
 * only, which has no colon, so this value can never stand in for one.
 */
export async function csrfTokenFor(
  sessionToken: string | undefined | null,
  env: Env = process.env,
): Promise<string | null> {
  const key = getSessionKey(env);
  if (!key || !sessionToken) return null;
  const dot = sessionToken.indexOf(".");
  if (dot <= 0) return null;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(`csrf:${sessionToken.slice(0, dot)}`),
  );
  let hex = "";
  for (const byte of new Uint8Array(signature))
    hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Set the token cookie on an outgoing response. Not httpOnly: the page reads it and
 * sends it back as the X-CSRF-Token header. It lives as long as a session can and is
 * Secure wherever the session cookie is. Call it whenever the session cookie is set,
 * with the token for that same session value.
 */
export function setCsrfCookie(
  response: NextResponse,
  token: string,
  env: Env = process.env,
): void {
  response.cookies.set({
    name: CSRF_COOKIE,
    value: token,
    httpOnly: false,
    secure: sessionCookieOptions(env).secure,
    sameSite: "strict",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}

/**
 * Whether a write may go on. Live mode: the session cookie must be valid and the
 * X-CSRF-Token header must equal the token for exactly that session, compared in
 * constant time. A demo has no session; there the answer is yes and the proxy's
 * cross site check is the control.
 *
 * The answer is an object on purpose: `if (!checkCsrf(request).ok)` without `await`
 * does not compile, so a forgotten `await` cannot switch the check off.
 *
 * GET requests should NOT call this. They change nothing and must stay reachable
 * for page rendering and the scheduler.
 */
export async function checkCsrf(
  request: NextRequest,
  env: Env = process.env,
): Promise<{ ok: boolean }> {
  try {
    if (getMode(env) !== "live") return { ok: true };
  } catch {
    return { ok: false };
  }

  const header = request.headers.get(CSRF_HEADER);
  if (!header || !TOKEN_SHAPE.test(header)) return { ok: false };

  const session = request.cookies.get(sessionCookieOptions(env).name)?.value;
  if (!(await verifySessionToken(session, env))) return { ok: false };

  const expected = await csrfTokenFor(session, env);
  if (!expected) return { ok: false };

  let mismatch = 0;
  for (let i = 0; i < expected.length; i++)
    mismatch |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return { ok: mismatch === 0 };
}
