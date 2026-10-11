// Who writes in this map. Import-free: safe in edge middleware, server routes and tests.
//
// MEMBERS is a comma separated list of ids (letters, digits, "-" and "_"), for example
// MEMBERS=alex,sam. With nothing set, two neutral ids are used so a fresh clone works.
// A member id is a self-declared label held in the session cookie. The shared password is
// the only real gate; do not treat a member id as proof of who someone is.
export type MemberId = string;

const FALLBACK: readonly MemberId[] = ["member-1", "member-2"];
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function getMembers(
  env: Record<string, string | undefined> = process.env,
): MemberId[] {
  const raw = env.MEMBERS;
  if (!raw) return [...FALLBACK];
  const ids = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ID.test(s));
  const unique = Array.from(new Set(ids)).slice(0, 8);
  return unique.length > 0 ? unique : [...FALLBACK];
}

export function isMemberId(
  value: unknown,
  members: readonly MemberId[] = getMembers(),
): value is MemberId {
  return typeof value === "string" && members.includes(value);
}
