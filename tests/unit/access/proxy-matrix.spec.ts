import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import {
  ROUTES,
  allowHeader,
  findRoute,
  methodAllowed,
  type RouteRow,
} from "@/app/api/_lib/routes";
import { LIVE_VARS } from "@/lib/mode";
import { COOKIE_NAME, createSessionToken } from "@/lib/session";
import { config, proxy } from "@/proxy";

// SPEC R4 and ADR 0001: the proxy called directly for every route, every method and
// every mode. Three kinds of proof live here:
//
//   the list     every page.tsx and route.ts under app/ has a row, and the row names
//                the methods the file really exports
//   the matcher  the proxy runs on every path except the files in public/
//   the matrix   for each mode, row, caller and method the proxy gives one known answer
//
// The sweeps further down state the rules a second time without the per row table, so
// a mistake copied into both the proxy and the table still fails a test.

type Mode = "live" | "demo-readonly" | "demo-writable";
type Who = "nobody" | "session" | "cron" | "no key";

const MODES: Mode[] = ["live", "demo-readonly", "demo-writable"];
const ROOT = process.cwd();

const TEST_KEY = "unit-test-signing-key-0123456789abcdef";
// Shaped like bcrypt output, built at run time. Never a real hash.
const TEST_HASH = "$2b$04$" + "a".repeat(53);
const TEST_CRON = "unit-test-cron-secret-0123456789";
const SAMPLE_ID = "00000000-0000-4000-8000-000000000001";

// The methods a route can export, then verbs no route answers: two that fetch itself
// refuses to send but a raw client can, a made up one, and a lower case spelling.
const METHODS = [
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "TRACE",
  "CONNECT",
  "BREW",
  "patch",
];
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const UNSAFE = METHODS.filter((method) => !SAFE.has(method));
const FETCH_REFUSES = new Set(["TRACE", "TRACK", "CONNECT"]);

// Paths with no row. Near misses of real rows are the point.
const UNKNOWN_PATHS = [
  "/admin",
  "/api",
  "/api/",
  "/api/unknown",
  "/api/Auth",
  "/api/auth/",
  "/api/auth/extra",
  "/MAP",
  "/map/",
  "/map/extra",
  "/api/locations/",
  `/api/locations/${SAMPLE_ID}/`,
  `/api/locations/${SAMPLE_ID}/unknown`,
  `/api/locations/${SAMPLE_ID}/photo/extra`,
  "/_next",
  "/_next/image",
];

// The proxy reads the real environment, so these tests set it. Each test sets every
// name below first; a worker runs one test at a time.
const env = process.env as Record<string, string | undefined>;
const MANAGED = [
  ...LIVE_VARS,
  "DEMO_MODE",
  "NODE_ENV",
  "VERCEL",
  "VERCEL_ENV",
  "CRON_SECRET",
];

function setMode(mode: Mode): void {
  for (const name of MANAGED) delete env[name];
  env.NODE_ENV = "test";
  if (mode === "live") {
    env.SESSION_SECRET = TEST_KEY;
    env.SITE_PASSWORD_HASH = TEST_HASH;
    env.CRON_SECRET = TEST_CRON;
  } else {
    env.DEMO_MODE = mode === "demo-writable" ? "writable" : "1";
  }
}

let saved: Record<string, string | undefined> = {};
test.beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((name) => [name, env[name]]));
});
test.afterEach(() => {
  for (const name of MANAGED) {
    const value = saved[name];
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
});

function request(
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  origin = "http://localhost",
): NextRequest {
  let built: NextRequest;
  if (FETCH_REFUSES.has(method)) {
    // fetch will not build these. A raw HTTP client can still send them, so build a
    // GET and rename it.
    built = new NextRequest(`${origin}${pathname}`, { headers });
    Object.defineProperty(built, "method", { value: method });
  } else {
    built = new NextRequest(`${origin}${pathname}`, { method, headers });
  }
  expect(built.method).toBe(method);
  return built;
}

/**
 * Sets the mode and returns what the caller sends. The session and the cron secret are
 * always real ones from a live setup, so a demo is shown a cookie that would open the
 * live app, and has to ignore it.
 */
async function arrange(mode: Mode, who: Who): Promise<Record<string, string>> {
  setMode("live");
  let headers: Record<string, string> = {};
  if (who === "session") {
    const token = await createSessionToken();
    expect(token).toBeTruthy();
    headers = { cookie: `${COOKIE_NAME}=${token}` };
  }
  if (who === "cron") headers = { authorization: `Bearer ${TEST_CRON}` };
  setMode(mode);
  if (who === "no key") delete env.SESSION_SECRET;
  return headers;
}

const samplePath = (row: RouteRow): string =>
  row.path.replace(/\[[^\]]+\]/g, SAMPLE_ID);

const passed = (res: NextResponse): boolean =>
  res.headers.get("x-middleware-next") === "1";

/** The `error` of a JSON answer, or the text of a plain one. */
async function errorOf(res: NextResponse): Promise<string> {
  const text = await res.text();
  try {
    return String((JSON.parse(text) as { error?: unknown }).error);
  } catch {
    return text;
  }
}

type Outcome =
  | { kind: "pass" }
  | { kind: "redirect"; to: string }
  | { kind: "refuse"; status: number; error?: string };

const PASS: Outcome = { kind: "pass" };
const redirect = (to: string): Outcome => ({ kind: "redirect", to });
const refuse = (status: number, error?: string): Outcome => ({
  kind: "refuse",
  status,
  error,
});

async function expectOutcome(
  res: NextResponse,
  want: Outcome,
  label: string,
): Promise<void> {
  if (want.kind === "pass") {
    expect.soft(passed(res), `${label}: passes`).toBe(true);
    return;
  }
  expect.soft(passed(res), `${label}: does not pass`).toBe(false);
  expect
    .soft(res.headers.get("cache-control"), `${label}: no-store`)
    .toBe("no-store");
  if (want.kind === "redirect") {
    expect.soft(res.status, `${label}: status`).toBe(307);
    const location = res.headers.get("location") ?? "http://none/none";
    expect.soft(new URL(location).pathname, `${label}: target`).toBe(want.to);
    return;
  }
  expect.soft(res.status, `${label}: status`).toBe(want.status);
  if (want.error !== undefined) {
    expect.soft(await errorOf(res), `${label}: error`).toBe(want.error);
  }
}

// Written apart from the proxy's own helper on purpose.
function listed(row: RouteRow, method: string): boolean {
  if (method === "OPTIONS") return true;
  if (method === "HEAD") return row.methods.some((m) => m === "GET");
  return row.methods.some((m) => m === method);
}

/** The one answer the proxy must give. */
function expected(mode: Mode, row: RouteRow, who: Who, method: string): Outcome {
  const api = row.path.startsWith("/api/");
  if (mode === "demo-readonly" && !SAFE.has(method)) {
    return refuse(403, "demo_read_only");
  }
  if (!listed(row, method)) return refuse(405, "method_not_allowed");
  if (mode !== "live") return row.path === "/" ? redirect("/map") : PASS;
  if (who === "no key") {
    if (api) return refuse(503);
    return row.rule === "public" ? PASS : redirect("/");
  }
  if (row.rule === "public") return PASS;
  if (row.rule === "cron") return who === "cron" ? PASS : refuse(401, "");
  if (who === "session") return PASS;
  return api ? refuse(401) : redirect("/");
}

const callers = (mode: Mode): Who[] =>
  mode === "live" ? ["nobody", "session", "cron", "no key"] : ["nobody", "session"];

// -- the list ------------------------------------------------------------------

const ROUTE_FILE = /^(page|route)\.(tsx|ts|jsx|js|mjs)$/;
// Files that make the router answer a path without a page or a route file. None exist
// today. One that appears needs a rule first, so it fails here.
const OTHER_ROUTE_FILE =
  /^(sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image|default)\./;
const EXPORTED_METHOD =
  /^export\s+(?:async\s+)?(?:function|const|let|var)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/gm;

interface FoundRoute {
  path: string;
  file: string;
  methods: string[];
}

function walkApp(): { found: FoundRoute[]; unexpected: string[] } {
  const found: FoundRoute[] = [];
  const unexpected: string[] = [];
  const visit = (dir: string, segments: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const shown = path.relative(ROOT, full);
      if (entry.isDirectory()) {
        // A folder that starts with an underscore is private: the router skips it.
        if (entry.name.startsWith("_")) continue;
        // Route groups, parallel routes and intercepting routes change how a folder
        // maps to a path. None exist today.
        if (/^[(@]/.test(entry.name)) unexpected.push(shown);
        visit(full, [...segments, entry.name]);
        continue;
      }
      if (OTHER_ROUTE_FILE.test(entry.name)) unexpected.push(shown);
      if (!ROUTE_FILE.test(entry.name)) continue;
      const source = fs.readFileSync(full, "utf8");
      // A re-export hides the method names from the check below.
      if (/^export\s*(\*|\{)/m.test(source)) unexpected.push(shown);
      const methods = entry.name.startsWith("page.")
        ? ["GET"]
        : [...source.matchAll(EXPORTED_METHOD)].map((match) => match[1]);
      found.push({ path: `/${segments.join("/")}`, file: shown, methods });
    }
  };
  visit(path.join(ROOT, "app"), []);
  return { found, unexpected };
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

test.describe("the route list", () => {
  test("every page and route file under app/ has exactly one row", () => {
    const { found, unexpected } = walkApp();
    expect(unexpected, "files the list cannot describe").toEqual([]);
    expect(found.length).toBeGreaterThan(0);
    expect(sorted(ROUTES.map((row) => row.path))).toEqual(
      sorted(found.map((route) => route.path)),
    );
    expect(new Set(ROUTES.map((row) => row.path)).size).toBe(ROUTES.length);
  });

  test("each row names the methods its file exports, no more and no fewer", () => {
    for (const route of walkApp().found) {
      const row = ROUTES.find((candidate) => candidate.path === route.path);
      expect(row, route.file).toBeTruthy();
      expect(route.methods.length, route.file).toBeGreaterThan(0);
      expect(sorted(row?.methods ?? []), route.file).toEqual(
        sorted(route.methods),
      );
    }
  });

  // Opening a path to everyone is a decision. It has to be made here as well as in
  // the list, where a reviewer sees it.
  test("only the login page and the login call are public; only keep-alive is cron", () => {
    const withRule = (rule: string) =>
      sorted(ROUTES.filter((row) => row.rule === rule).map((row) => row.path));
    expect(withRule("public")).toEqual(["/", "/api/auth"]);
    expect(withRule("cron")).toEqual(["/api/keep-alive"]);
    for (const row of ROUTES) {
      expect(["public", "session", "cron"], row.path).toContain(row.rule);
    }
  });

  test("a path matches its row exactly and nothing near it", () => {
    for (const row of ROUTES) {
      expect(findRoute(samplePath(row))?.path, row.path).toBe(row.path);
    }
    for (const pathname of UNKNOWN_PATHS) {
      expect(findRoute(pathname), pathname).toBeNull();
    }
    expect(findRoute("/api/locations/a/b/photo")).toBeNull();
    expect(findRoute("/api/locations//photo")).toBeNull();
    expect(findRoute("")).toBeNull();
  });

  test("HEAD follows GET, OPTIONS follows the row, the rest must be listed", () => {
    const login = findRoute("/api/auth");
    const list = findRoute("/api/locations");
    if (!login || !list) throw new Error("the rows this test reads are gone");
    expect(methodAllowed(login, "POST")).toBe(true);
    expect(methodAllowed(login, "GET")).toBe(false);
    expect(methodAllowed(login, "HEAD")).toBe(false);
    expect(methodAllowed(login, "OPTIONS")).toBe(true);
    expect(methodAllowed(list, "HEAD")).toBe(true);
    expect(methodAllowed(list, "DELETE")).toBe(false);
    expect(methodAllowed(list, "post")).toBe(false);
    expect(allowHeader(login)).toBe("POST, OPTIONS");
    expect(allowHeader(list)).toBe("GET, POST, HEAD, OPTIONS");
  });
});

// -- the matcher ---------------------------------------------------------------

const runsOn = (url: string): boolean =>
  unstable_doesMiddlewareMatch({ config, nextConfig: {}, url });

test.describe("the matcher", () => {
  test("the proxy runs on every row", () => {
    for (const row of ROUTES) {
      expect(runsOn(samplePath(row)), row.path).toBe(true);
    }
  });

  test("the proxy runs on paths with no row, so it can refuse them", () => {
    for (const url of [
      ...UNKNOWN_PATHS,
      "/_next/image?url=%2Fapi%2Flocations&w=64&q=75",
      "/_nextish",
      "/api/favicon.ico",
      "/favicon.ico.bak",
      "/manifest.json/extra",
      "/icon-192.png.html",
      "/icons",
    ]) {
      expect(runsOn(url), url).toBe(true);
    }
  });

  test("every file in public/ is served without the proxy, and is not refused by it", () => {
    const dir = path.join(ROOT, "public");
    const files = walkFiles(dir).map(
      (file) => `/${path.relative(dir, file).split(path.sep).join("/")}`,
    );
    expect(files.length).toBeGreaterThan(0);
    for (const url of files) expect(runsOn(url), url).toBe(false);
  });

  test("the build output and the dev overlay are left alone", () => {
    for (const url of [
      "/_next/static/chunks/app.js",
      "/_next/webpack-hmr",
      "/__nextjs_original-stack-frames",
      "/favicon.ico",
    ]) {
      expect(runsOn(url), url).toBe(false);
    }
  });
});

// -- the matrix ----------------------------------------------------------------

for (const mode of MODES) {
  test.describe(`matrix: ${mode}`, () => {
    for (const row of ROUTES) {
      test(`${row.path} answers every method for every caller`, async () => {
        for (const who of callers(mode)) {
          const headers = await arrange(mode, who);
          for (const method of METHODS) {
            const res = await proxy(request(method, samplePath(row), headers));
            await expectOutcome(
              res,
              expected(mode, row, who, method),
              `${who} ${method}`,
            );
          }
        }
      });
    }

    test("a path with no row is refused for every caller", async () => {
      for (const who of callers(mode)) {
        const headers = await arrange(mode, who);
        for (const pathname of UNKNOWN_PATHS) {
          for (const method of METHODS) {
            const want =
              mode === "demo-readonly" && !SAFE.has(method)
                ? refuse(403, "demo_read_only")
                : refuse(404, "not_found");
            const res = await proxy(request(method, pathname, headers));
            await expectOutcome(res, want, `${who} ${method} ${pathname}`);
          }
        }
      }
    });
  });
}

// -- the rules, stated a second time ---------------------------------------------

test.describe("sweeps", () => {
  test("live: with no credential nothing but the two public rows gets through", async () => {
    setMode("live");
    const open: string[] = [];
    for (const row of ROUTES) {
      for (const method of METHODS) {
        const res = await proxy(request(method, samplePath(row)));
        if (passed(res)) open.push(`${method} ${row.path}`);
        else {
          expect.soft(res.status < 200 || res.status > 299, `${method} ${row.path}`).toBe(true);
        }
      }
    }
    expect(sorted(open)).toEqual(
      sorted(["GET /", "HEAD /", "OPTIONS /", "POST /api/auth", "OPTIONS /api/auth"]),
    );
  });

  test("live: a session does not open keep-alive, and the cron secret opens nothing else", async () => {
    const session = await arrange("live", "session");
    const cron = await arrange("live", "cron");
    expect(passed(await proxy(request("GET", "/api/keep-alive", session)))).toBe(false);
    expect(passed(await proxy(request("GET", "/api/keep-alive", cron)))).toBe(true);
    for (const row of ROUTES.filter((candidate) => candidate.rule === "session")) {
      for (const method of METHODS) {
        const res = await proxy(request(method, samplePath(row), cron));
        expect.soft(passed(res), `${method} ${row.path}`).toBe(false);
      }
    }
  });

  test("live: a cron secret that is short, missing or wrong opens nothing", async () => {
    setMode("live");
    const send = (authorization?: string) => {
      const headers: Record<string, string> = {};
      if (authorization !== undefined) headers.authorization = authorization;
      return proxy(request("GET", "/api/keep-alive", headers));
    };
    for (const wrong of [undefined, "", "Bearer ", TEST_CRON, `Basic ${TEST_CRON}`, `Bearer ${TEST_CRON}x`]) {
      const res = await send(wrong);
      expect(res.status, String(wrong)).toBe(401);
      expect(await res.text()).toBe("");
    }
    env.CRON_SECRET = "short";
    expect((await send("Bearer short")).status).toBe(401);
    delete env.CRON_SECRET;
    expect((await send("Bearer ")).status).toBe(401);
    expect((await send("Bearer undefined")).status).toBe(401);
  });

  test("demo-readonly: no write gets through, on any path, with or without a session cookie", async () => {
    // A cookie that would open the live app: a demo never reads it.
    const live = await arrange("demo-readonly", "session");
    const variants: Record<string, string>[] = [
      {},
      live,
      { ...live, "sec-fetch-site": "same-origin" },
    ];
    const paths = [...ROUTES.map(samplePath), ...UNKNOWN_PATHS];
    for (const pathname of paths) {
      for (const method of UNSAFE) {
        for (const headers of variants) {
          const res = await proxy(request(method, pathname, headers));
          expect.soft(passed(res), `${method} ${pathname}`).toBe(false);
          expect.soft(res.status, `${method} ${pathname}`).toBe(403);
          expect.soft(await errorOf(res), `${method} ${pathname}`).toBe("demo_read_only");
        }
      }
    }
  });

  test("demo: the map and its data open with no login, and the login page leads to the map", async () => {
    for (const mode of ["demo-readonly", "demo-writable"] as const) {
      setMode(mode);
      for (const pathname of ["/map", "/api/locations", `/api/locations/${SAMPLE_ID}`]) {
        for (const method of ["GET", "HEAD"]) {
          const res = await proxy(request(method, pathname));
          expect(passed(res), `${mode} ${method} ${pathname}`).toBe(true);
        }
      }
      const home = await proxy(request("GET", "/"));
      expect(home.status).toBe(307);
      expect(new URL(home.headers.get("location") ?? "").pathname).toBe("/map");
      expect(home.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("demo-writable: listed writes pass, anything unlisted does not", async () => {
    setMode("demo-writable");
    expect(passed(await proxy(request("POST", "/api/locations")))).toBe(true);
    expect(passed(await proxy(request("DELETE", `/api/locations/${SAMPLE_ID}`)))).toBe(true);
    const put = await proxy(request("PUT", "/api/locations"));
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, POST, HEAD, OPTIONS");
    expect((await proxy(request("POST", "/map"))).status).toBe(405);
    expect((await proxy(request("POST", "/api/unknown"))).status).toBe(404);
  });

  test("live: every page redirect and every refusal says no-store", async () => {
    setMode("live");
    const page = await proxy(request("GET", "/map"));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get("location") ?? "").pathname).toBe("/");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const api = await proxy(request("GET", "/api/locations"));
    expect(api.status).toBe(401);
    expect(api.headers.get("cache-control")).toBe("no-store");
    expect(await api.json()).toHaveProperty("error");
  });
});

// -- a refused configuration -----------------------------------------------------

test.describe("the mode is checked on every request (R3)", () => {
  const VALUE = "unit-test-value-that-must-never-be-printed-0123456789";

  for (const name of LIVE_VARS) {
    test(`a demo next to ${name} answers 503 on every path and names it`, async () => {
      setMode("demo-readonly");
      env[name] = VALUE;
      for (const pathname of ["/", "/map", "/api/locations", "/api/auth", "/admin"]) {
        for (const method of ["GET", "POST"]) {
          const res = await proxy(request(method, pathname));
          expect(passed(res), `${method} ${pathname}`).toBe(false);
          expect(res.status, `${method} ${pathname}`).toBe(503);
          expect(res.headers.get("cache-control")).toBe("no-store");
          const body = await res.text();
          expect(body).toContain(name);
          expect(body).not.toContain(VALUE);
        }
      }
    });
  }

  test("a writable demo outside the dev server and tests answers 503", async () => {
    const cases: Record<string, string>[] = [
      { NODE_ENV: "production" },
      { NODE_ENV: "test", VERCEL: "1" },
      { NODE_ENV: "test", VERCEL_ENV: "preview" },
    ];
    for (const extra of cases) {
      setMode("demo-writable");
      Object.assign(env, extra);
      for (const pathname of ["/map", "/api/locations"]) {
        const res = await proxy(request("GET", pathname));
        expect(passed(res), JSON.stringify(extra)).toBe(false);
        expect(res.status, JSON.stringify(extra)).toBe(503);
      }
    }
  });
});

// -- requests from other sites ---------------------------------------------------

test.describe("a write started by another site is refused", () => {
  const APP = "https://app.example";

  // Headers a browser adds, and whether the write may go on.
  const CASES: [string, Record<string, string>, boolean][] = [
    ["no browser headers at all", {}, true],
    ["Sec-Fetch-Site same-origin", { "sec-fetch-site": "same-origin" }, true],
    ["Sec-Fetch-Site none", { "sec-fetch-site": "none" }, true],
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }, false],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }, false],
    ["Sec-Fetch-Site in another spelling", { "sec-fetch-site": "Same-Origin" }, false],
    ["Sec-Fetch-Site with an unknown value", { "sec-fetch-site": "trusted" }, false],
    [
      "Sec-Fetch-Site cross-site next to a matching Origin",
      { "sec-fetch-site": "cross-site", origin: APP },
      false,
    ],
    ["only Origin, the same host", { origin: APP }, true],
    ["only Origin, another host", { origin: "https://evil.example" }, false],
    ["only Origin, a longer host", { origin: "https://app.example.evil.test" }, false],
    ["only Origin, another port", { origin: "https://app.example:8443" }, false],
    ["only Origin, null", { origin: "null" }, false],
    ["only Origin, unreadable", { origin: "app.example" }, false],
  ];

  for (const mode of ["live", "demo-writable"] as const) {
    for (const [label, headers, allowed] of CASES) {
      test(`${mode}: ${label} ${allowed ? "passes" : "is refused"}`, async () => {
        const session = await arrange(mode, "session");
        for (const [method, pathname] of [
          ["POST", "/api/locations"],
          ["PATCH", `/api/locations/${SAMPLE_ID}`],
          ["DELETE", `/api/locations/${SAMPLE_ID}/photo`],
        ]) {
          const res = await proxy(
            request(method, pathname, { ...session, ...headers }, APP),
          );
          if (allowed) {
            expect(passed(res), `${method} ${pathname}`).toBe(true);
          } else {
            expect(passed(res), `${method} ${pathname}`).toBe(false);
            expect(res.status, `${method} ${pathname}`).toBe(403);
            expect(await errorOf(res)).toBe("cross_site");
            expect(res.headers.get("cache-control")).toBe("no-store");
          }
        }
      });
    }
  }

  test("the Host header is what Origin is compared with", async () => {
    const session = await arrange("live", "session");
    const behind = "http://internal:3000";
    const same = await proxy(
      request("POST", "/api/locations", { ...session, host: "app.example", origin: APP }, behind),
    );
    expect(passed(same)).toBe(true);
    const other = await proxy(
      request("POST", "/api/locations", { ...session, host: "app.example", origin: behind }, behind),
    );
    expect(other.status).toBe(403);
  });

  test("logging in from another site is refused too", async () => {
    setMode("live");
    const res = await proxy(
      request("POST", "/api/auth", { "sec-fetch-site": "cross-site" }, APP),
    );
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("cross_site");
    expect(passed(await proxy(request("POST", "/api/auth", {}, APP)))).toBe(true);
  });

  test("a read is never refused for where it came from", async () => {
    const session = await arrange("live", "session");
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const res = await proxy(
        request(
          method,
          "/api/locations",
          { ...session, "sec-fetch-site": "cross-site", origin: "https://evil.example" },
          APP,
        ),
      );
      expect(passed(res), method).toBe(true);
    }
  });

  test("the read only demo answers demo_read_only first", async () => {
    setMode("demo-readonly");
    const res = await proxy(
      request("POST", "/api/locations", { "sec-fetch-site": "cross-site" }, APP),
    );
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("demo_read_only");
  });
});
