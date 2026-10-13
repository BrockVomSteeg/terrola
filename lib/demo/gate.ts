// The data layer gate (SPEC R17). Every page and route that reads data asks here for
// a store and gets exactly one of two:
//
//   demo  the in-memory store. The live store's module is never loaded, so a demo
//         has no code path to the database at all (R3).
//   live  the Supabase store, which checks the caller's credential itself before it
//         hands anything out. The proxy is never the only gate.
//
// It never throws. A refused configuration, a failed import or a wrong credential is
// a result the caller maps to a status.
import { getMode, resolveMode, type AppMode } from "@/lib/mode";
import { demoStore } from "./memory-store";
import {
  ok,
  refused,
  type Credential,
  type ReadStore,
  type StoreResult,
} from "./store";

type Env = Record<string, string | undefined>;

/**
 * The build time check (R3). `next build` loads every page and route module, this one
 * with them, so a demo build next to a live variable stops here. It asks only for the
 * configured mode, not the runtime rule: a build always runs as production, and a
 * writable demo build for the tests must still succeed.
 */
export function buildCheck(env: Env = process.env): void {
  resolveMode(env);
}

buildCheck();

export interface GateDeps {
  env?: Env;
  /** How the live store is opened. Tests pass their own; the default loads the real one. */
  openLive?: (credential: Credential, env: Env) => Promise<StoreResult<ReadStore>>;
}

export async function getStore(
  credential: Credential,
  deps: GateDeps = {},
): Promise<StoreResult<ReadStore>> {
  const env = deps.env ?? process.env;

  // Checked on every call, not once: nothing here is cached (R3).
  let mode: AppMode;
  try {
    mode = getMode(env);
  } catch {
    return refused("failed");
  }

  // A demo has no login, so the credential is not looked at.
  if (mode !== "live") return ok(demoStore(mode));

  try {
    const openLive =
      deps.openLive ?? (await import("@/app/api/_lib/live-store")).openLiveStore;
    return await openLive(credential, env);
  } catch {
    return refused("failed");
  }
}
