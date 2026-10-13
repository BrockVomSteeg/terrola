import { bootCheck } from "@/lib/mode";

// Boot check (SPEC R3): runs once per server instance, before any request. A demo next to
// a live variable, or a writable demo outside the dev server and tests, throws here and
// the server does not start. It is one of three checks, never the only one: `next build`
// does not run this function, so the build check and the per request check stand alone.
export function register() {
  bootCheck();
}
