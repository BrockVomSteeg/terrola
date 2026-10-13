#!/usr/bin/env node
// Build check (SPEC R3): prints the app mode and the names live mode still needs, and exits 1
// when a demo is configured next to a live variable. Names only, never a value.
// Needs Node 24 or newer: it imports the TypeScript source directly, so the rule is written
// once. The runtime rule for a writable demo is not applied here, because a build always
// runs as production; the boot check and the per request check apply it.
import { checkEnv } from "../lib/mode.ts";

try {
  const { mode, missing } = checkEnv(process.env);
  console.log(`check-env: mode ${mode}`);
  if (missing.length > 0) {
    console.log(`check-env: live mode still needs ${missing.join(", ")}`);
  }
} catch (err) {
  console.error(`check-env: ${err instanceof Error ? err.message : "failed"}`);
  process.exit(1);
}
