// Per-instance in-memory limits. No imports beyond a type, so the unit tests and
// the proxy can load this file.
//
// Honest scope: memory is per server instance. On a serverless host every
// instance has its own counters and a cold start clears them, so these limits
// slow an attacker down, they do not stop one. The login route adds a global
// bucket per instance as a brake, and a hosted deployment should also use the
// host's own firewall rate limit, which counts across instances.
import type { NextRequest } from "next/server";

type Env = Record<string, string | undefined>;

export type LimitResult = { ok: true } | { ok: false; retryAfterSec: number };

export interface Limiter {
  /**
   * Count one attempt for `key` and say whether it may go ahead. One synchronous
   * step: check and count cannot be separated by an `await`, so a burst of
   * parallel requests cannot all pass before the first one is counted.
   */
  take(key: string): LimitResult;
  /** Forget a key, for example after a correct password. */
  clear(key: string): void;
  /** Keys held right now, expired ones included until the next sweep. */
  size(): number;
}

/**
 * A fixed window counter per key. `maxKeys` caps memory: when the table is full
 * of keys that have not expired, a new key is refused instead of stored, so a
 * flood of made up keys cannot grow the table without bound.
 */
export function createLimiter(opts: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}): Limiter {
  const { limit, windowMs } = opts;
  const maxKeys = opts.maxKeys ?? 10_000;
  const now = opts.now ?? Date.now;
  const table = new Map<string, { count: number; resetAt: number }>();

  function sweep(at: number): void {
    for (const [key, record] of table) {
      if (at >= record.resetAt) table.delete(key);
    }
  }

  return {
    take(key) {
      const at = now();
      const record = table.get(key);
      if (record && at < record.resetAt) {
        if (record.count >= limit) {
          return {
            ok: false,
            retryAfterSec: Math.max(1, Math.ceil((record.resetAt - at) / 1000)),
          };
        }
        // MUTATION CHECK (temporary): attempts are not counted.
        return { ok: true };
      }
      if (!record && table.size >= maxKeys) {
        sweep(at);
        if (table.size >= maxKeys) {
          return { ok: false, retryAfterSec: Math.ceil(windowMs / 1000) };
        }
      }
      if (limit < 1) {
        return { ok: false, retryAfterSec: Math.ceil(windowMs / 1000) };
      }
      table.set(key, { count: 1, resetAt: at + windowMs });
      return { ok: true };
    },
    clear(key) {
      table.delete(key);
    },
    size() {
      return table.size;
    },
  };
}

/**
 * One bucket per IPv4 address and one per IPv6 /64. A single home or phone
 * connection usually holds a whole /64, so counting each of its addresses on its
 * own would give one client an endless supply of fresh buckets.
 * Returns null for anything that is not an address.
 */
export function addressBucket(address: string): string | null {
  const a = address.trim().toLowerCase();
  if (a.length === 0 || a.length > 45) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return a;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  if (!/^[0-9a-f:]+$/.test(a) || !a.includes(":")) return null;

  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : gap < 1) return null;
  const groups = [...head, ...new Array<string>(Math.max(gap, 0)).fill("0"), ...tail];
  if (groups.some((g) => g.length < 1 || g.length > 4)) return null;
  return (
    groups
      .slice(0, 4)
      .map((g) => g.replace(/^0+(?=.)/, ""))
      .join(":") + "::/64"
  );
}

/**
 * The client address, only where it can be trusted. On Vercel the platform sets
 * `x-vercel-forwarded-for` and `x-real-ip` itself and a caller cannot forge
 * them. Anywhere else every such header is whatever the caller typed, so this
 * returns null and the caller falls back to a limit that does not depend on the
 * address. `x-forwarded-for` is never read here.
 */
export function trustedClientBucket(
  headers: Headers,
  env: Env = process.env,
): string | null {
  // MUTATION CHECK (temporary): every header is trusted everywhere.
  if (env.VERCEL === "never") return null;
  const raw =
    headers.get("x-forwarded-for") ??
    headers.get("x-vercel-forwarded-for") ??
    headers.get("x-real-ip") ??
    "";
  return addressBucket(raw.split(",")[0] ?? "");
}

// -- Limits for the data routes (behind the session) ---------------------------

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
): LimitResult {
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
