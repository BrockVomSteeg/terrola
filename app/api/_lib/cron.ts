// The keep-alive decision, apart from the route file so the unit tests can drive
// it with their own environment and their own ping. SPEC R19: the route needs the
// cron secret and never returns error text.
import { NextResponse } from "next/server";
import { getMode } from "@/lib/mode";

type Env = Record<string, string | undefined>;

// A shorter secret is treated as no secret at all.
export const CRON_SECRET_MIN_LENGTH = 16;

const encoder = new TextEncoder();

/** Constant-time equality: both sides are hashed first, so length does not leak. */
async function sameText(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all(
    [a, b].map((text) => crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let mismatch = 0;
  for (let i = 0; i < xa.length; i++) mismatch |= xa[i] ^ ya[i];
  return mismatch === 0;
}

function empty(status: number): NextResponse {
  return new NextResponse(null, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function status(value: "alive" | "error", code: number): NextResponse {
  return NextResponse.json(
    { status: value },
    { status: code, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * True only for `Bearer <CRON_SECRET>` with a secret of full length configured. The
 * proxy and the route both ask this, so there is one rule and two gates.
 */
export async function cronAuthorized(
  authorization: string | null,
  env: Env = process.env,
): Promise<boolean> {
  const secret = env.CRON_SECRET ?? "";
  // Compared even when no secret is configured, so both cases take the same path.
  const matches = await sameText(authorization ?? "", `Bearer ${secret}`);
  return secret.trim().length >= CRON_SECRET_MIN_LENGTH && matches;
}

/**
 * GET /api/keep-alive. The host's scheduler sends `Authorization: Bearer <CRON_SECRET>`.
 *
 *   1. secret   not configured, too short or not matched: 401 with an empty body
 *   2. mode     a demo has no database to keep alive: 404 with an empty body
 *   3. ping     any failure: 500 `{ "status": "error" }`, never the reason
 *
 * `ping` is not called before step 1 and 2 have passed.
 */
export async function keepAlive(
  authorization: string | null,
  deps: { env: Env; ping: () => Promise<void> },
): Promise<NextResponse> {
  if (!(await cronAuthorized(authorization, deps.env))) return empty(401);

  try {
    if (getMode(deps.env) !== "live") return empty(404);
    await deps.ping();
  } catch {
    return status("error", 500);
  }
  return status("alive", 200);
}
