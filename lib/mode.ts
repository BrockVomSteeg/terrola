// App mode seam. Import-free: safe in the proxy, server routes, tests and plain Node
// (scripts/check-env.mjs imports this file as it is).
//
//   live           real Supabase and the password gate (the self-host default)
//   demo-readonly  fake in-memory data, no login, every write refused (the public demo)
//   demo-writable  fake in-memory data, writes allowed (local development and CI only)
//
// DEMO_MODE unset, 0, false or off -> live. DEMO_MODE=writable -> demo-writable.
// Any other value (1, true, readonly) -> demo-readonly.
//
// Fail closed (SPEC R3 and section 4): a demo never runs next to a live variable, and a
// writable demo runs only under the dev server or NODE_ENV=test, never on Vercel.
//
// Nothing here is cached: every call reads the environment it is given. Variables are read
// by name from that object, so the bundler cannot bake a build time value in.
export type AppMode = "live" | "demo-readonly" | "demo-writable";

type Env = Record<string, string | undefined>;

// The variables that point at real data or a real login (SPEC R3).
export const LIVE_VARS = [
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SITE_PASSWORD_HASH",
  "SESSION_SECRET",
] as const;

// SPEC R18. lib/session.ts reads this, so the length is written once.
export const SESSION_SECRET_MIN_LENGTH = 32;

const isSet = (env: Env, name: string): boolean => (env[name] ?? "") !== "";

/**
 * The mode the configuration asks for. Throws when a demo is asked for next to a live
 * variable; the message carries names only, never a value. Safe at build time: it does
 * not apply the runtime rule (`next build` always runs with NODE_ENV=production).
 */
export function resolveMode(env: Env = process.env): AppMode {
  const raw = (env.DEMO_MODE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "false" || raw === "off")
    return "live";
  const present = LIVE_VARS.filter((name) => isSet(env, name));
  if (present.length > 0) {
    throw new Error(
      `DEMO_MODE refused: ${present.join(", ")} ${present.length === 1 ? "is" : "are"} set. Demo mode never runs next to real credentials.`,
    );
  }
  return raw === "writable" ? "demo-writable" : "demo-readonly";
}

/** The runtime rule: where a writable demo may run. Throws anywhere else. */
export function assertRuntime(mode: AppMode, env: Env = process.env): void {
  if (mode !== "demo-writable") return;
  if (isSet(env, "VERCEL") || isSet(env, "VERCEL_ENV")) {
    throw new Error(
      "DEMO_MODE=writable refused on Vercel (production, preview and development alike). A hosted demo is read only: use DEMO_MODE=1.",
    );
  }
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    throw new Error(
      "DEMO_MODE=writable refused: it runs only under the dev server or with NODE_ENV=test.",
    );
  }
}

/** The mode for a running server: the configuration check plus the runtime rule. */
export function getMode(env: Env = process.env): AppMode {
  const mode = resolveMode(env);
  assertRuntime(mode, env);
  return mode;
}

export const isDemo = (env: Env = process.env): boolean =>
  getMode(env) !== "live";

export const isReadOnlyDemo = (env: Env = process.env): boolean =>
  getMode(env) === "demo-readonly";

/**
 * The mode plus the names live mode still needs. Names only, never a value. Throws on a
 * demo next to a live variable. Used by the build check (scripts/check-env.mjs) and the
 * boot check below.
 */
export function checkEnv(env: Env = process.env): {
  mode: AppMode;
  missing: string[];
} {
  const mode = resolveMode(env);
  const missing: string[] = [];
  if (mode !== "live") return { mode, missing };
  if (!isSet(env, "SUPABASE_URL") && !isSet(env, "NEXT_PUBLIC_SUPABASE_URL"))
    missing.push("SUPABASE_URL");
  if (!isSet(env, "SUPABASE_SERVICE_KEY")) missing.push("SUPABASE_SERVICE_KEY");
  if (!isSet(env, "SITE_PASSWORD_HASH")) missing.push("SITE_PASSWORD_HASH");
  if ((env.SESSION_SECRET ?? "").trim().length < SESSION_SECRET_MIN_LENGTH)
    missing.push(
      `SESSION_SECRET (${SESSION_SECRET_MIN_LENGTH} or more characters)`,
    );
  return { mode, missing };
}

/**
 * Boot check, run once per server instance by instrumentation.ts. Throws on a
 * configuration that must never serve a request. An incomplete live setup only warns:
 * the app then shows a setup notice instead of a bare error (SPEC R14).
 */
export function bootCheck(
  env: Env = process.env,
  out: { log: (line: string) => void; warn: (line: string) => void } = console,
): AppMode {
  const { mode, missing } = checkEnv(env);
  assertRuntime(mode, env);
  out.log(`[app] mode: ${mode}`);
  if (missing.length > 0) {
    out.warn(
      `[app] live mode is not fully set up. Missing: ${missing.join(", ")}.`,
    );
  }
  return mode;
}
