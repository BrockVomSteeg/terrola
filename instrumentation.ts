import { bootCheck } from "@/lib/mode";

// Boot check (SPEC R3): runs once per server instance, before any request. A demo next to
// a live variable, or a writable demo outside the dev server and tests, throws here and
// the server does not start. SPEC R3 asks for three checks (build, boot, per request) and
// this is the boot one. `next build` does not run this function, and a host may treat a
// throw here differently, so it must never be the only check.
export function register() {
  bootCheck();
}
