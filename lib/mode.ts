// App mode seam. Import-free: safe in edge middleware, server routes and tests.
//
//   live           real Supabase and the password gate (the self-host default)
//   demo-readonly  fake in-memory data, no login, every write refused (the public demo)
//   demo-writable  fake in-memory data, writes allowed (local development and CI only)
//
// DEMO_MODE unset, 0, false or off -> live. DEMO_MODE=writable -> demo-writable.
// Any other value (1, true, readonly) -> demo-readonly.
//
// Fail closed: a demo can never run next to real credentials, and a writable demo can
// never run on a Vercel production deployment.
export type AppMode = "live" | "demo-readonly" | "demo-writable";

type Env = Record<string, string | undefined>;

export function getMode(env: Env = process.env): AppMode {
  const raw = (env.DEMO_MODE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "false" || raw === "off")
    return "live";
  const mode: AppMode = raw === "writable" ? "demo-writable" : "demo-readonly";
  if (env.SUPABASE_SERVICE_KEY) {
    throw new Error(
      "DEMO_MODE refused: SUPABASE_SERVICE_KEY is set. Demo mode never runs next to real credentials.",
    );
  }
  if (mode === "demo-writable" && env.VERCEL_ENV === "production") {
    throw new Error(
      "DEMO_MODE=writable refused on a Vercel production deployment.",
    );
  }
  return mode;
}

export const isDemo = (env: Env = process.env): boolean =>
  getMode(env) !== "live";

export const isReadOnlyDemo = (env: Env = process.env): boolean =>
  getMode(env) === "demo-readonly";
