// The HTTP answer for a store refusal, in one place so every route gives the same one.
import { NextResponse } from "next/server";
import type { StoreErrorCode } from "@/lib/demo/store";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * `failedMessage` is the caller's own short sentence for a database or storage
 * failure. The reason itself is never passed on.
 *
 * `noStore` adds `Cache-Control: no-store`, which every read answers with. The write
 * routes pass false: their answers never carried that header, and they keep the
 * headers they had.
 */
export function storeError(
  code: StoreErrorCode,
  failedMessage: string,
  noStore = true,
): NextResponse {
  const answer = (error: string, status: number): NextResponse =>
    NextResponse.json(
      { error },
      noStore ? { status, headers: NO_STORE } : { status },
    );

  switch (code) {
    case "not_found":
      return answer("Location not found", 404);
    case "read_only":
      return answer("demo_read_only", 403);
    case "unauthorized":
      // The same words the proxy uses, so the page treats both alike.
      return answer("Session expired. Please re-enter the password.", 401);
    case "unsupported":
      return answer("not_supported_in_demo", 501);
    default:
      return answer(failedMessage, 500);
  }
}
