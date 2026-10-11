import "server-only";
import type { NextRequest } from "next/server";

/**
 * Per-instance in-memory rate limit. Serverless functions are stateless across
 * cold starts and across regions, so this is best-effort: a determined
 * attacker can scatter requests across instances. For this app's threat
 * model (single-tenant private map, gated by a shared password + CSRF) that
 * is acceptable, and the limiter still throttles the common case of a
 * scripted attacker hammering one endpoint from one region.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

function getIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
  );
}

export function checkRateLimit(
  request: NextRequest,
  scope: string,
  limit: number,
  windowMs: number,
  // Overrides the default per-IP key. Needed for routes where IP is the
  // wrong dimension to limit on, for example when several members share one
  // network address and per-IP limiting would let one member's failed attempts
  // lock the others out too. Callers key by something per member instead
  // (a hash of their own session token).
  customKey?: string,
): { ok: true } | { ok: false; retryAfterSec: number } {
  const ip = getIp(request);
  const key = customKey ? `${scope}:${customKey}` : `${scope}:${ip}`;
  const now = Date.now();
  const record = buckets.get(key);

  if (!record || now > record.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  if (record.count >= limit) {
    return {
      ok: false,
      retryAfterSec: Math.ceil((record.resetAt - now) / 1000),
    };
  }

  record.count++;
  return { ok: true };
}

export const RATE_LIMITS = {
  // 60 writes per minute per IP per scope
  WRITE: { limit: 60, windowMs: 60_000 },
  // 120 reads per minute per IP per scope
  READ: { limit: 120, windowMs: 60_000 },
} as const;
