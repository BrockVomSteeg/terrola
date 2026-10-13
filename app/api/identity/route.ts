import { NextRequest, NextResponse } from "next/server";
import {
  COOKIE_NAME,
  createSessionToken,
  decodeSessionPayload,
  sessionCookieOptions,
} from "@/lib/session";
import {
  checkCsrf,
  csrfTokenFor,
  setCsrfCookie,
} from "@/app/api/_lib/csrf";
import { isMemberId } from "@/lib/members";

// The proxy asks for a valid session here, like every row marked `session` in
// app/api/_lib/routes.ts, and this route checks the session again itself: its
// job is to record WHICH member is holding an already-logged-in device, not to
// gate first entry.
//
// Anyone holding the shared password can claim any member id. The password is
// the only real gate; a member id is a self-declared label kept in the session
// cookie so the choice is asked once per device.

// No rate limit: the only thing this endpoint does is re-sign a cookie the
// caller already holds a valid version of. Anyone who can reach it can already
// reach /api/locations.
export async function POST(request: NextRequest) {
  if (!(await checkCsrf(request)).ok) {
    return NextResponse.json(
      { error: "CSRF token missing or invalid" },
      { status: 403 },
    );
  }

  const cookieValue = request.cookies.get(COOKIE_NAME)?.value;
  const payload = await decodeSessionPayload(cookieValue);
  if (!payload) {
    return NextResponse.json(
      { error: "Session expired. Please re-enter the password." },
      { status: 401 },
    );
  }

  let body: { person?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!isMemberId(body.person)) {
    return NextResponse.json({ error: "Unknown person" }, { status: 400 });
  }
  const person = body.person;

  // Re-sign the SAME session, adding the member id. Preserve the original
  // `iat` so choosing a member never extends the 30-day session.
  const token = await createSessionToken({ person, iat: payload.iat });
  const csrf = await csrfTokenFor(token);
  if (!token || !csrf) {
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 },
    );
  }

  const response = NextResponse.json({ success: true, person });
  response.cookies.set({ ...sessionCookieOptions(), value: token });
  // The write token is tied to the session value, which has just changed.
  setCsrfCookie(response, csrf);
  return response;
}

// Shared-device escape hatch: clear the member id from the token so whoever
// picks up the device next is asked again. Same CSRF + re-sign path as POST,
// same preserved `iat`.
export async function DELETE(request: NextRequest) {
  if (!(await checkCsrf(request)).ok) {
    return NextResponse.json(
      { error: "CSRF token missing or invalid" },
      { status: 403 },
    );
  }

  const cookieValue = request.cookies.get(COOKIE_NAME)?.value;
  const payload = await decodeSessionPayload(cookieValue);
  if (!payload) {
    return NextResponse.json(
      { error: "Session expired. Please re-enter the password." },
      { status: 401 },
    );
  }

  const token = await createSessionToken({ iat: payload.iat });
  const csrf = await csrfTokenFor(token);
  if (!token || !csrf) {
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 },
    );
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set({ ...sessionCookieOptions(), value: token });
  setCsrfCookie(response, csrf);
  return response;
}
