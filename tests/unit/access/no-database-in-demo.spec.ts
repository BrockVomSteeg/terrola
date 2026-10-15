import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { GET as keepAliveGet } from "@/app/api/keep-alive/route";
import {
  GET as listGet,
  POST as listPost,
} from "@/app/api/locations/route";
import {
  DELETE as placeDelete,
  GET as placeGet,
  PATCH as placePatch,
} from "@/app/api/locations/[id]/route";
import {
  DELETE as photoDelete,
  GET as photoGet,
  POST as photoPost,
} from "@/app/api/locations/[id]/photo/route";
import { POST as uploadPost } from "@/app/api/locations/[id]/photo-url/route";
import { ROUTES } from "@/app/api/_lib/routes";
import { DEMO_LOCATIONS } from "@/lib/demo/fixtures";
import { getStore } from "@/lib/demo/gate";
import type { Credential, Store, StoreResult } from "@/lib/demo/store";
import { LIVE_VARS } from "@/lib/mode";
import type { Location } from "@/types";

// SPEC R17, R3: in a demo no Supabase client and no network call exist. Every data
// route handler is called with every method it answers, in both demo modes, with
// globalThis.fetch replaced by a spy that fails the call (the Supabase client talks
// to the database through fetch).
//
// The route handlers ask the gate with no test seam, so the live store opener cannot
// be spied on inside them. What these tests use instead: in this test run the live
// store cannot be opened at all (its module needs the server only build), so a gate
// that opened it would answer `failed` (500) or `unauthorized` (401), never the demo
// answer each call is checked for. The control test at the end shows that. The gate
// itself is spied on directly as well, with the credentials the routes pass.

const env = process.env as Record<string, string | undefined>;
const MANAGED = [
  ...LIVE_VARS,
  "DEMO_MODE",
  "NODE_ENV",
  "VERCEL",
  "VERCEL_ENV",
  "CRON_SECRET",
];
const KEY = "unit-test-signing-key-0123456789abcdef";
// Shaped like bcrypt output, built at run time. Never a real hash.
const HASH = "$2b$04$" + "a".repeat(53);
const CRON = "unit-test-cron-secret-0123456789";

let saved: Record<string, string | undefined> = {};
let realFetch: typeof fetch;
let fetched: unknown[] = [];

test.beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((name) => [name, env[name]]));
  for (const name of MANAGED) delete env[name];
  env.NODE_ENV = "test";
  realFetch = globalThis.fetch;
  fetched = [];
  globalThis.fetch = (async (...args: unknown[]) => {
    fetched.push(args[0]);
    throw new Error("no network call may happen in a demo");
  }) as typeof fetch;
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of MANAGED) {
    const value = saved[name];
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
});

let address = 0;

function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  address++;
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.3.${Math.floor(address / 250)}.${address % 250}`,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const at = (id: string) => ({ params: Promise.resolve({ id }) });

const NEW_PLACE = {
  title: "No database test place",
  date_label: "2025-10-01",
  lat: 38.7,
  lng: -9.1,
  description: "",
  category: "food",
};

/** Every handler this spec calls, as "path method", to compare with the route list. */
const CALLED = [
  "/api/keep-alive GET",
  "/api/locations GET",
  "/api/locations POST",
  "/api/locations/[id] GET",
  "/api/locations/[id] PATCH",
  "/api/locations/[id] DELETE",
  "/api/locations/[id]/photo GET",
  "/api/locations/[id]/photo POST",
  "/api/locations/[id]/photo DELETE",
  "/api/locations/[id]/photo-url POST",
];

/** The reads, the same in both demo modes. */
async function reads(): Promise<[string, number][]> {
  const fixture = DEMO_LOCATIONS[4].id;
  return [
    ["/api/locations GET", (await listGet(call("GET", "/api/locations"))).status],
    [
      "/api/locations/[id] GET",
      (await placeGet(call("GET", `/api/locations/${fixture}`), at(fixture))).status,
    ],
    [
      "/api/locations/[id]/photo GET",
      (await photoGet(call("GET", `/api/locations/${fixture}/photo`), at(fixture)))
        .status,
    ],
    [
      // With the cron secret set and sent: past the secret check, the demo answers
      // 404 and the ping is never called.
      "/api/keep-alive GET",
      (
        await keepAliveGet(
          call("GET", "/api/keep-alive", undefined, { authorization: `Bearer ${CRON}` }),
        )
      ).status,
    ],
  ];
}

test.describe("no database and no network in a demo", () => {
  test("the calls below cover every data route and method in the route list", () => {
    const listed = ROUTES.filter((row) => row.path.startsWith("/api/"))
      .filter((row) => !["/api/auth", "/api/geocode", "/api/identity"].includes(row.path))
      .flatMap((row) => row.methods.map((method) => `${row.path} ${method}`));
    expect([...CALLED].sort()).toEqual([...listed].sort());
  });

  test("the read only demo: every read answers from memory, every write is refused", async () => {
    env.DEMO_MODE = "1";
    env.CRON_SECRET = CRON;
    const fixture = DEMO_LOCATIONS[4].id;
    const answers: [string, number][] = [
      ...(await reads()),
      ["/api/locations POST", (await listPost(call("POST", "/api/locations", NEW_PLACE))).status],
      [
        "/api/locations/[id] PATCH",
        (await placePatch(call("PATCH", `/api/locations/${fixture}`, { title: "x" }), at(fixture)))
          .status,
      ],
      [
        "/api/locations/[id] DELETE",
        (await placeDelete(call("DELETE", `/api/locations/${fixture}`), at(fixture))).status,
      ],
      [
        "/api/locations/[id]/photo POST",
        (
          await photoPost(
            call("POST", `/api/locations/${fixture}/photo`, { path: `${fixture}-1700000000000.jpg` }),
            at(fixture),
          )
        ).status,
      ],
      [
        "/api/locations/[id]/photo DELETE",
        (await photoDelete(call("DELETE", `/api/locations/${fixture}/photo`), at(fixture)))
          .status,
      ],
      [
        "/api/locations/[id]/photo-url POST",
        (await uploadPost(call("POST", `/api/locations/${fixture}/photo-url`), at(fixture)))
          .status,
      ],
    ];
    expect(Object.fromEntries(answers)).toEqual({
      "/api/keep-alive GET": 404,
      "/api/locations GET": 200,
      "/api/locations/[id] GET": 200,
      "/api/locations/[id]/photo GET": 200,
      "/api/locations POST": 403,
      "/api/locations/[id] PATCH": 403,
      "/api/locations/[id] DELETE": 403,
      "/api/locations/[id]/photo POST": 403,
      "/api/locations/[id]/photo DELETE": 403,
      "/api/locations/[id]/photo-url POST": 403,
    });
    expect(fetched).toEqual([]);
  });

  test("the writable demo: every read and every write answers from memory", async () => {
    env.DEMO_MODE = "writable";
    env.CRON_SECRET = CRON;
    const answers: [string, number][] = [...(await reads())];

    const createdRes = await listPost(call("POST", "/api/locations", NEW_PLACE));
    answers.push(["/api/locations POST", createdRes.status]);
    const id = ((await createdRes.json()) as Location).id;

    answers.push([
      "/api/locations/[id] PATCH",
      (await placePatch(call("PATCH", `/api/locations/${id}`, { title: "x" }), at(id))).status,
    ]);
    answers.push([
      "/api/locations/[id]/photo-url POST",
      (await uploadPost(call("POST", `/api/locations/${id}/photo-url`), at(id))).status,
    ]);
    answers.push([
      "/api/locations/[id]/photo POST",
      (await photoPost(call("POST", `/api/locations/${id}/photo`, { path: `${id}-1700000000000.jpg` }), at(id)))
        .status,
    ]);
    answers.push([
      "/api/locations/[id]/photo DELETE",
      (await photoDelete(call("DELETE", `/api/locations/${id}/photo`), at(id))).status,
    ]);
    answers.push([
      "/api/locations/[id] DELETE",
      (await placeDelete(call("DELETE", `/api/locations/${id}`), at(id))).status,
    ]);

    expect(Object.fromEntries(answers)).toEqual({
      "/api/keep-alive GET": 404,
      "/api/locations GET": 200,
      "/api/locations/[id] GET": 200,
      "/api/locations/[id]/photo GET": 200,
      "/api/locations POST": 201,
      "/api/locations/[id] PATCH": 200,
      // The demo has no file storage.
      "/api/locations/[id]/photo-url POST": 501,
      "/api/locations/[id]/photo POST": 501,
      "/api/locations/[id]/photo DELETE": 200,
      "/api/locations/[id] DELETE": 200,
    });
    expect(fetched).toEqual([]);
  });

  test("the gate never calls the live store opener in a demo, whatever the credential", async () => {
    const calls: Credential[] = [];
    const openLive = async (credential: Credential): Promise<StoreResult<Store>> => {
      calls.push(credential);
      return { ok: false, error: { code: "failed" } };
    };
    for (const demo of [
      { DEMO_MODE: "1" },
      { DEMO_MODE: "writable", NODE_ENV: "test" },
    ]) {
      for (const credential of [
        { kind: "session", token: undefined },
        { kind: "session", token: "not-a-session" },
        { kind: "cron", authorization: `Bearer ${CRON}` },
      ] as Credential[]) {
        const result = await getStore(credential, { env: demo, openLive });
        expect(result.ok).toBe(true);
      }
    }
    expect(calls).toEqual([]);
    expect(fetched).toEqual([]);
  });

  // The control: in live mode the same read reaches for the live store, and in this
  // test run that never gives the demo answer. So a demo answer above proves that
  // the gate stayed on the memory store.
  test("control: in live mode the same read does not get a demo answer here", async () => {
    env.SESSION_SECRET = KEY;
    env.SITE_PASSWORD_HASH = HASH;
    const res = await listGet(call("GET", "/api/locations"));
    expect([401, 500]).toContain(res.status);
    expect(fetched).toEqual([]);
  });
});
