import "server-only";
import { randomBytes, timingSafeEqual } from "crypto";
import type { NextRequest, NextResponse } from "next/server";

export const CSRF_COOKIE = "app_csrf";
export const CSRF_HEADER = "x-csrf-token";
export const CSRF_MAX_AGE = 60 * 60 * 24 * 180; // 180 days, in seconds

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Set the CSRF cookie on an outgoing response. Non-httpOnly because the
 * frontend needs to read it to send back as the X-CSRF-Token header
 * (double-submit cookie pattern).
 */
export function setCsrfCookie(response: NextResponse, token: string): void {
  response.cookies.set({
    name: CSRF_COOKIE,
    value: token,
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: CSRF_MAX_AGE,
    path: "/",
  });
}

/**
 * Constant-time double-submit verification. Returns true only if the
 * X-CSRF-Token header matches the app_csrf cookie value exactly.
 *
 * GET requests should NOT call this. They have no state-changing
 * side effects and need to remain reachable for SSR / cron paths.
 */
export function verifyCsrf(request: NextRequest): boolean {
  const headerToken = request.headers.get(CSRF_HEADER);
  const cookieToken = request.cookies.get(CSRF_COOKIE)?.value;

  if (!headerToken || !cookieToken) return false;
  if (headerToken.length !== cookieToken.length) return false;

  try {
    return timingSafeEqual(
      Buffer.from(headerToken, "hex"),
      Buffer.from(cookieToken, "hex"),
    );
  } catch {
    return false;
  }
}
