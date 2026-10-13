// The login decision, apart from the route file so the unit tests can drive it
// with their own environment, limits and password check. app/api/auth/route.ts
// wires in the real ones.
import { NextResponse } from "next/server";
import { getMode, type AppMode } from "@/lib/mode";
import {
  createSessionToken,
  getSessionKey,
  sessionCookieOptions,
} from "@/lib/session";
import { generateCsrfToken, setCsrfCookie } from "./csrf";
import { trustedClientBucket, type Limiter } from "./rate-limit";

type Env = Record<string, string | undefined>;

const FIFTEEN_MINUTES = 15 * 60 * 1000;

export const LOGIN_LIMITS = {
  // Per client: slows guessing from one address. Used only where the address
  // can be trusted (see trustedClientBucket).
  perClient: { limit: 5, windowMs: FIFTEEN_MINUTES },
  // Per server instance, every client together: a brake on guessing spread
  // over many addresses, and the only limit where no address can be trusted.
  // It refuses new logins while it is spent; sessions that already exist keep
  // working, so the group is slowed down, not locked out.
  everyone: { limit: 60, windowMs: FIFTEEN_MINUTES },
} as const;

// bcrypt reads 72 bytes and ignores the rest, so a longer password would be
// accepted on its first 72 bytes alone. Refuse it instead.
export const PASSWORD_MAX_BYTES = 72;
// A login body is a short JSON object. Nothing longer is read into memory.
const BODY_MAX_CHARS = 4096;

export interface LoginDeps {
  env: Env;
  perClient: Limiter;
  everyone: Limiter;
  /** bcrypt comparison. Called only after every other check has passed. */
  verifyPassword: (submitted: string, storedHash: string) => Promise<boolean>;
}

/** The body as text, or null once it is longer than `maxBytes`. Never holds more. */
async function readCapped(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function answer(
  body: object,
  status: number,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function tooMany(retryAfterSec: number): NextResponse {
  return answer({ error: "Too many attempts. Try again later." }, 429, {
    "Retry-After": String(retryAfterSec),
  });
}

/**
 * POST /api/auth. The order is the security design (SPEC R18, ADR 0001):
 *
 *   1. mode      a demo has no login: 404
 *   2. key       no signing key: 503 naming the variable, before any password work
 *   3. limits    counted here, in the same synchronous step as the checks above
 *   4. body      short JSON with a password of at most 72 bytes
 *   5. hash      no password hash configured: 503 naming the variable
 *   6. password  bcrypt
 *   7. session   signed token in the session cookie
 *
 * Steps 1 to 3 run before the first `await`, so a burst of parallel requests is
 * counted one by one and cannot slip past the limit together. Every attempt
 * counts, right or wrong; a correct password clears the client's own count.
 * No answer contains a value from the environment or from the request.
 */
export async function login(
  request: Request,
  deps: LoginDeps,
): Promise<NextResponse> {
  const { env } = deps;

  let mode: AppMode;
  try {
    mode = getMode(env);
  } catch (err) {
    // The message names variables, never values (lib/mode.ts).
    return answer(
      { error: err instanceof Error ? err.message : "Server misconfigured" },
      503,
    );
  }
  if (mode !== "live") return answer({ error: "Not found" }, 404);

  if (!getSessionKey(env)) {
    return answer(
      {
        error:
          "Server misconfigured: SESSION_SECRET is missing or shorter than 32 characters.",
      },
      503,
    );
  }

  // A body that declares itself too long is refused here: nothing is read and
  // nothing is counted, so it cannot use up the limits below.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > BODY_MAX_CHARS) {
    return answer({ error: "Invalid request" }, 400);
  }

  const client = trustedClientBucket(request.headers, env);
  if (client) {
    const own = deps.perClient.take(client);
    if (!own.ok) return tooMany(own.retryAfterSec);
  }
  const all = deps.everyone.take("login");
  if (!all.ok) return tooMany(all.retryAfterSec);

  let password: unknown;
  try {
    // The declared length can be missing or wrong, so the body is read in
    // pieces and dropped as soon as it passes the cap.
    const text = await readCapped(request, BODY_MAX_CHARS);
    if (text === null) {
      return answer({ error: "Invalid request" }, 400);
    }
    const body: unknown = JSON.parse(text);
    password =
      typeof body === "object" && body !== null
        ? (body as { password?: unknown }).password
        : undefined;
  } catch {
    return answer({ error: "Invalid request" }, 400);
  }
  if (typeof password !== "string" || password.length === 0) {
    return answer({ error: "Password required" }, 400);
  }
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    return answer(
      { error: `Password too long: ${PASSWORD_MAX_BYTES} bytes at most.` },
      400,
    );
  }

  const storedHash = env.SITE_PASSWORD_HASH;
  if (!storedHash) {
    return answer(
      { error: "Server misconfigured: SITE_PASSWORD_HASH is missing." },
      503,
    );
  }

  let valid: boolean;
  try {
    valid = await deps.verifyPassword(password, storedHash);
  } catch {
    return answer({ error: "Server error" }, 500);
  }
  if (valid !== true) return answer({ error: "Invalid password" }, 401);

  // Null only when the stored hash is not a bcrypt hash at all, which a correct
  // password cannot reach. Fail closed anyway: no token, no session.
  const token = await createSessionToken(undefined, env);
  if (!token) return answer({ error: "Server misconfigured" }, 503);

  if (client) deps.perClient.clear(client);

  const response = answer({ success: true }, 200);
  response.cookies.set({ ...sessionCookieOptions(env), value: token });
  // The frontend reads app_csrf and echoes it as X-CSRF-Token on every
  // state-changing request (double-submit cookie pattern).
  setCsrfCookie(response, generateCsrfToken());
  return response;
}
