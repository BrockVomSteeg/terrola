import { decodeSessionPayload } from "@/lib/session";
import type { MemberId } from "@/lib/members";

export { decodeSessionPayload };

/**
 * Which member is holding this session, if one has been chosen yet.
 * Thin wrapper over decodeSessionPayload: null for a missing, invalid or
 * expired token, or a valid token with no member id set.
 */
export async function getPerson(
  token: string | undefined | null,
): Promise<MemberId | null> {
  const payload = await decodeSessionPayload(token);
  return payload?.person ?? null;
}
