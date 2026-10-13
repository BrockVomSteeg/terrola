import type { NextRequest } from "next/server";
import { login, LOGIN_LIMITS } from "@/app/api/_lib/login";
import { createLimiter } from "@/app/api/_lib/rate-limit";

// One pair of counters per server instance. See app/api/_lib/rate-limit.ts for
// what that does and does not protect against.
const perClient = createLimiter(LOGIN_LIMITS.perClient);
const everyone = createLimiter(LOGIN_LIMITS.everyone);

// The decision and its order live in app/api/_lib/login.ts.
export async function POST(request: NextRequest) {
  return login(request, {
    env: process.env,
    perClient,
    everyone,
    // Loaded only after every other check has passed: lib/auth pulls in bcrypt.
    verifyPassword: async (submitted, storedHash) => {
      const { verifyPassword } = await import("@/lib/auth");
      return verifyPassword(submitted, storedHash);
    },
  });
}
