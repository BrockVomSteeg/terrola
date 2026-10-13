// Who may use the live store, and what each caller gets. Kept apart from
// live-store.ts, and free of the database client, so the unit tests can load it:
// this is the second gate behind the proxy (SPEC R17), and it has to be testable.
import {
  refused,
  type Credential,
  type ReadStore,
} from "@/lib/demo/store";
import { verifySessionToken } from "@/lib/session";
import { cronAuthorized } from "./cron";

type Env = Record<string, string | undefined>;

/** A caller that has proved who it is. */
export type LiveCaller = "session" | "cron";

/**
 * Checks a credential against the environment it is given.
 *
 *   session  a session cookie value that verifies (signature, expiry, password)
 *   cron     the scheduler's `Authorization` header, equal to `Bearer <CRON_SECRET>`
 *
 * Each kind is checked only as its own kind: a session value is never tried as a cron
 * secret, nor the other way round. Anything else is null.
 */
export async function identify(
  credential: Credential,
  env: Env,
): Promise<LiveCaller | null> {
  if (credential.kind === "cron") {
    return (await cronAuthorized(credential.authorization, env)) ? "cron" : null;
  }
  if (credential.kind === "session") {
    return (await verifySessionToken(credential.token, env)) ? "session" : null;
  }
  return null;
}

const notForTheScheduler = async () => refused<never>("unauthorized");

/**
 * The store a caller gets. A session gets all of it. The scheduler may wake the
 * database and nothing else: every data method answers `unauthorized` for it.
 */
export function storeFor(caller: LiveCaller, full: ReadStore): ReadStore {
  if (caller === "session") return full;
  return {
    listLocations: notForTheScheduler,
    getLocation: notForTheScheduler,
    listPhotos: notForTheScheduler,
    ping: full.ping,
  };
}
