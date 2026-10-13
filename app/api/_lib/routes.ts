// The one list of every page and API route, with the methods each file answers and who
// may call it (SPEC R4). The proxy decides from this list and nothing else: a path or a
// method that is not written here is refused.
//
// tests/unit/access/proxy-matrix.spec.ts reads the same list. It walks app/ and fails
// when a page.tsx or route.ts has no row, when a row has no file, and when a row's
// methods differ from the methods the file exports. A new route cannot ship without a
// rule.
//
// Import-free: safe in the proxy and in plain Node tests.

/**
 *   public   no login needed. This skips the login check and nothing else.
 *   session  a valid session cookie in live mode.
 *   cron     the scheduler's secret in live mode (SPEC R19).
 *
 * A demo has no login, so in the demo modes the rule is not asked; the mode decides.
 */
export type AccessRule = "public" | "session" | "cron";

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteRow {
  /**
   * The path as the app/ folder spells it. `[name]` stands for exactly one path
   * segment. A path under /api/ is a route.ts, any other path is a page.tsx.
   */
  path: string;
  /** The methods the file exports. A page answers GET. */
  methods: readonly RouteMethod[];
  rule: AccessRule;
}

export const ROUTES: readonly RouteRow[] = [
  // The login page. It has to open without a session.
  { path: "/", methods: ["GET"], rule: "public" },
  { path: "/map", methods: ["GET"], rule: "session" },
  // Logging in. It has to work without a session.
  { path: "/api/auth", methods: ["POST"], rule: "public" },
  { path: "/api/geocode", methods: ["GET"], rule: "session" },
  { path: "/api/identity", methods: ["POST", "DELETE"], rule: "session" },
  { path: "/api/keep-alive", methods: ["GET"], rule: "cron" },
  { path: "/api/locations", methods: ["GET", "POST"], rule: "session" },
  {
    path: "/api/locations/[id]",
    methods: ["GET", "PATCH", "DELETE"],
    rule: "session",
  },
  {
    path: "/api/locations/[id]/photo",
    methods: ["GET", "POST", "DELETE"],
    rule: "session",
  },
  { path: "/api/locations/[id]/photo-url", methods: ["POST"], rule: "session" },
];

const PLACEHOLDER = /^\[[^\]\/]+\]$/;

function toPattern(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) =>
      PLACEHOLDER.test(segment)
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${source}$`);
}

const EXACT = new Map(
  ROUTES.filter((row) => !row.path.includes("[")).map(
    (row) => [row.path, row] as const,
  ),
);
const PATTERNS = ROUTES.filter((row) => row.path.includes("[")).map((row) => ({
  row,
  pattern: toPattern(row.path),
}));

/**
 * The row for a request path, or null. The match is exact: no trailing slash, no case
 * folding and no decoding, so the proxy and the router can never disagree about which
 * row a path belongs to. A path with no row is refused by the proxy.
 */
export function findRoute(pathname: string): RouteRow | null {
  const exact = EXACT.get(pathname);
  if (exact) return exact;
  for (const { row, pattern } of PATTERNS) {
    if (pattern.test(pathname)) return row;
  }
  return null;
}

/**
 * Whether a row answers a method. HEAD follows GET, as the router answers it from the
 * GET handler. OPTIONS is answered by the router for every route, so it is allowed on
 * every row; it still has to pass the row's rule. Anything else must be listed.
 */
export function methodAllowed(row: RouteRow, method: string): boolean {
  if (method === "OPTIONS") return true;
  if (method === "HEAD") return row.methods.includes("GET");
  return (row.methods as readonly string[]).includes(method);
}

/** The value of the Allow header for a 405 answer. */
export function allowHeader(row: RouteRow): string {
  const methods: string[] = [...row.methods];
  if (methods.includes("GET")) methods.push("HEAD");
  methods.push("OPTIONS");
  return methods.join(", ");
}
