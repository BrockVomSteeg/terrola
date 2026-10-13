import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, getSessionKey, verifySessionToken } from "@/lib/session";

export async function proxy(request: NextRequest) {
  if (!getSessionKey()) {
    // No signing key (SESSION_SECRET missing or under 32 characters). Fail
    // CLOSED in every environment (SPEC R18): nothing is unlocked because a
    // secret was dropped, mis-rotated or never set. To run with no secrets at
    // all, use the demo modes. The answer names the variable, never a value.
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          error:
            "Server misconfigured: SESSION_SECRET is missing or shorter than 32 characters.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  const cookieValue = request.cookies.get(COOKIE_NAME)?.value;

  // Opaque, server-signed token: the HMAC must verify AND the token must not
  // be expired. The cookie does not hold the password hash, so there is
  // nothing to leak or string-compare; an invalid, expired or forged token
  // fails closed.
  if (!(await verifySessionToken(cookieValue))) {
    // For API routes, return 401 JSON so fetch() can detect auth failure
    // instead of silently following a redirect to the HTML password page.
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Session expired. Please re-enter the password." },
        { status: 401 },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // /api/identity is deliberately NOT listed here. It records which member is
  // holding an already-logged-in device, so it must be callable before a
  // member id exists; it enforces its own session check internally instead.
  // Adding it here would break that flow.
  matcher: ["/map", "/api/locations/:path*", "/api/geocode"],
};
