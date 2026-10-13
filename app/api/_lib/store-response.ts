// The HTTP answer for a store refusal, in one place so every route gives the same one.
import { NextResponse } from "next/server";
import type { StoreErrorCode } from "@/lib/demo/store";

const NO_STORE = { "Cache-Control": "no-store" };

const answer = (error: string, status: number): NextResponse =>
  NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * `failedMessage` is the caller's own short sentence for a database or storage
 * failure. The reason itself is never passed on.
 */
export function storeError(code: StoreErrorCode, failedMessage: string): NextResponse {
  switch (code) {
    case "not_found":
      return answer("Location not found", 404);
    case "read_only":
      return answer("demo_read_only", 200);
    case "unauthorized":
      // The same words the proxy uses, so the page treats both alike.
      return answer("Session expired. Please re-enter the password.", 401);
    case "unsupported":
      return answer("not_supported_in_demo", 501);
    default:
      return answer(failedMessage, 500);
  }
}
