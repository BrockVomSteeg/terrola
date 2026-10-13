import { NextRequest, NextResponse } from "next/server";
import { verifyPassword } from "@/lib/auth";
import { createSessionToken, sessionCookieOptions } from "@/lib/session";
import { generateCsrfToken, setCsrfCookie } from "@/app/api/_lib/csrf";

// Per-IP rate limit. Resets per serverless function instance (a cold start
// clears the map). The goal is to make brute force noticeably slow, not to
// stop a determined attacker.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function getIP(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
  );
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = attempts.get(ip);
  if (!record || now > record.resetAt) {
    attempts.set(ip, { count: 0, resetAt: now + WINDOW_MS });
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function incrementAttempts(ip: string): void {
  const now = Date.now();
  const record = attempts.get(ip);
  if (!record || now > record.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    record.count++;
  }
}

function clearAttempts(ip: string): void {
  attempts.delete(ip);
}

export async function POST(request: NextRequest) {
  const ip = getIP(request);

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429 },
    );
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { password } = body;
  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Password required" }, { status: 400 });
  }

  const storedHash = process.env.SITE_PASSWORD_HASH;
  if (!storedHash) {
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 },
    );
  }

  const valid = await verifyPassword(password, storedHash);

  if (!valid) {
    incrementAttempts(ip);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  clearAttempts(ip);

  // Mint an opaque, server-signed session token (HMAC + explicit expiry). The
  // cookie value is not the bcrypt hash: it is decoupled from the password and
  // carries its own expiry. createSessionToken returns null only if no signing
  // key exists, which cannot happen here (verifyPassword already required a
  // decodable hash).
  const token = await createSessionToken();
  if (!token) {
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 },
    );
  }

  const response = NextResponse.json({ success: true });
  // Name and flags come from one place, so they cannot disagree.
  response.cookies.set({ ...sessionCookieOptions(), value: token });

  // Issue a fresh CSRF token alongside the auth cookie. The frontend reads
  // app_csrf and echoes it as X-CSRF-Token on every state-changing request
  // (double-submit cookie pattern).
  setCsrfCookie(response, generateCsrfToken());

  return response;
}
