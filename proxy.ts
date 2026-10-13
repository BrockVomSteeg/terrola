import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/app/api/_lib/cron";
import { allowHeader, findRoute, methodAllowed } from "@/app/api/_lib/routes";
import { getMode, type AppMode } from "@/lib/mode";
import { COOKIE_NAME, getSessionKey, verifySessionToken } from "@/lib/session";

// The first gate, and never the only one (CVE-2025-29927 showed a proxy can be
// skipped; the data layer checks again, SPEC R17). It runs on every path except
// static files and refuses whatever is not written in app/api/_lib/routes.ts.
//
// The order matters and tests/unit/access/proxy-matrix.spec.ts holds it:
//
//   1. mode        read on every request (R3). A refused configuration answers 503.
//   2. read only   the public demo refuses every write first (R4).
//   3. cross site  a write sent by another site is refused, in every mode.
//   4. the list    an unknown path gets 404, an unlisted method 405.
//   5. demo        no login exists: the login page leads to the map, the rest passes.
//   6. live        no signing key fails closed (R18); then the row's rule decides.
//
// Every refusal and every redirect carries Cache-Control: no-store.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const NO_STORE = { "Cache-Control": "no-store" };

const isApi = (request: NextRequest): boolean =>
  request.nextUrl.pathname.startsWith("/api/");

/** JSON for API paths so fetch() can read it, plain text for page paths. */
function refuse(
  request: NextRequest,
  status: number,
  error: string,
  headers: Record<string, string> = {},
): NextResponse {
  if (isApi(request)) {
    return NextResponse.json(
      { error },
      { status, headers: { ...NO_STORE, ...headers } },
    );
  }
  return new NextResponse(error, {
    status,
    headers: {
      ...NO_STORE,
      ...headers,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function sendTo(request: NextRequest, pathname: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  return NextResponse.redirect(url, { status: 307, headers: NO_STORE });
}

/**
 * Whether a browser says this request was started by another site. Sec-Fetch-Site is
 * set by the browser and a page cannot change it; `none` is the user's own action (a
 * typed address, a bookmark). Older browsers send no such header, so Origin is compared
 * with the host instead. A request with neither header does not come from a browser
 * page, and a forged request needs a victim's browser, so it passes this check.
 */
function isCrossSite(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("host") ?? request.nextUrl.host;
  try {
    return new URL(origin).host !== host;
  } catch {
    // `null` (a sandboxed frame, a redirect across sites) or anything unreadable.
    return true;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const unsafe = !SAFE_METHODS.has(request.method);

  // 1. The mode. Nothing is cached: a demo next to a live variable is refused on
  // every request, not only at boot. The message names variables, never a value.
  let mode: AppMode;
  try {
    mode = getMode();
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unreadable mode.";
    return refuse(request, 503, `Server misconfigured: ${reason}`);
  }

  // 2. The public demo is read only. First, before the path is even looked up, so
  // it also covers /api/auth, page paths (server actions) and paths that do not exist.
  if (mode === "demo-readonly" && unsafe) {
    return refuse(request, 403, "demo_read_only");
  }

  // 3. No write on behalf of another site.
  if (unsafe && isCrossSite(request)) {
    return refuse(request, 403, "cross_site");
  }

  // 4. Default deny.
  const route = findRoute(pathname);
  if (!route) return refuse(request, 404, "not_found");
  if (!methodAllowed(route, request.method)) {
    return refuse(request, 405, "method_not_allowed", {
      Allow: allowHeader(route),
    });
  }

  // 5. A demo has no login and no real data behind it (R3).
  if (mode !== "live") {
    if (pathname === "/") return sendTo(request, "/map");
    return NextResponse.next();
  }

  // 6. Live. No signing key (SESSION_SECRET missing or under 32 characters): fail
  // CLOSED in every environment (R18). Nothing is unlocked because a secret was
  // dropped, mis-rotated or never set. To run with no secrets at all, use the demo
  // modes. The answer names the variable, never a value.
  if (!getSessionKey()) {
    if (isApi(request)) {
      return refuse(
        request,
        503,
        "Server misconfigured: SESSION_SECRET is missing or shorter than 32 characters.",
      );
    }
    // The login page stays reachable so it can explain the setup.
    if (route.rule === "public") return NextResponse.next();
    return sendTo(request, "/");
  }

  if (route.rule === "public") return NextResponse.next();

  if (route.rule === "cron") {
    if (await cronAuthorized(request.headers.get("authorization"))) {
      return NextResponse.next();
    }
    // Same answer as the route itself: nothing to read.
    return new NextResponse(null, { status: 401, headers: NO_STORE });
  }

  // Opaque, server-signed token: the HMAC must verify AND the token must not be
  // expired. The cookie does not hold the password hash, so there is nothing to
  // leak or string-compare; an invalid, expired or forged token fails closed.
  const cookieValue = request.cookies.get(COOKIE_NAME)?.value;
  if (await verifySessionToken(cookieValue)) return NextResponse.next();

  // For API routes, 401 JSON so fetch() can detect the failure instead of silently
  // following a redirect to the HTML password page.
  if (isApi(request)) {
    return refuse(request, 401, "Session expired. Please re-enter the password.");
  }
  return sendTo(request, "/");
}

export const config = {
  // Every path except static files. The first entry leaves out the build output
  // (_next/), the dev overlay (__nextjs) and each file in public/ by its full name;
  // a test walks public/ so a new file cannot be forgotten. The second entry puts the
  // image optimizer back in: this app does not use it, and it has no row in the list,
  // so it is refused.
  matcher: [
    "/((?!_next/|__nextjs|favicon\\.ico$|manifest\\.json$|icon-192\\.png$|icon-512\\.png$|icon-192\\.svg$|icon-512\\.svg$).*)",
    "/_next/image",
  ],
};
