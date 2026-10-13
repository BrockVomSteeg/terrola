// Web-standard APIs only (no node:crypto), so the proxy and the unit tests can
// load this file.
import type { NextRequest, NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/session";

export const CSRF_COOKIE = "app_csrf";
export const CSRF_HEADER = "x-csrf-token";
export const CSRF_MAX_AGE = 60 * 60 * 24 * 180; // 180 days, in seconds

const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Set the CSRF cookie on an outgoing response. Non-httpOnly because the
 * frontend needs to read it to send back as the X-CSRF-Token header
 * (double-submit cookie pattern). Secure wherever the session cookie is.
 */
export function setCsrfCookie(response: NextResponse, token: string): void {
  response.cookies.set({
    name: CSRF_COOKIE,
    value: token,
    httpOnly: false,
    secure: sessionCookieOptions().secure,
    sameSite: "lax",
    maxAge: CSRF_MAX_AGE,
    path: "/",
  });
}

/**
 * Constant-time double-submit verification. Returns true only if the
 * X-CSRF-Token header matches the app_csrf cookie value exactly and both have
 * the shape this server issues (64 lowercase hex characters).
 *
 * GET requests should NOT call this. They have no state-changing
 * side effects and need to remain reachable for SSR / cron paths.
 */
export function verifyCsrf(request: NextRequest): boolean {
  const headerToken = request.headers.get(CSRF_HEADER);
  const cookieToken = request.cookies.get(CSRF_COOKIE)?.value;

  if (!headerToken || !cookieToken) return false;
  if (!TOKEN_SHAPE.test(headerToken) || !TOKEN_SHAPE.test(cookieToken))
    return false;

  let mismatch = 0;
  for (let i = 0; i < headerToken.length; i++)
    mismatch |= headerToken.charCodeAt(i) ^ cookieToken.charCodeAt(i);
  return mismatch === 0;
}
