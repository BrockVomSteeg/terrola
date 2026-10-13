import { test, expect } from "@playwright/test";
import { identify, storeFor } from "@/app/api/_lib/live-access";
import { ok, type Credential, type ReadStore } from "@/lib/demo/store";
import { COOKIE_MAX_AGE, createSessionToken } from "@/lib/session";

// The second gate (SPEC R17): who may use the live store, and what each caller gets.
// Every case passes its own environment.

type Env = Record<string, string | undefined>;

const KEY = "unit-test-signing-key-0123456789abcdef";
const OTHER_KEY = "another-unit-test-key-fedcba9876543210";
// Shaped like bcrypt output, built at run time. Never a real hash.
const HASH = "$2b$04$" + "a".repeat(53);
const OTHER_HASH = "$2b$04$" + "b".repeat(53);
const CRON = "unit-test-cron-secret-0123456789";
const LIVE: Env = {
  SESSION_SECRET: KEY,
  SITE_PASSWORD_HASH: HASH,
  CRON_SECRET: CRON,
  NODE_ENV: "test",
};

const now = () => Math.floor(Date.now() / 1000);

async function sessionToken(env: Env = LIVE, age = 60): Promise<string> {
  const token = await createSessionToken({ iat: now() - age }, env);
  if (!token) throw new Error("the test environment cannot sign a session");
  return token;
}

const asSession = (token: string | undefined | null): Credential => ({
  kind: "session",
  token,
});
const asCron = (authorization: string | null): Credential => ({
  kind: "cron",
  authorization,
});

test.describe("who the caller is", () => {
  test("a session cookie value that verifies is a session", async () => {
    expect(await identify(asSession(await sessionToken()), LIVE)).toBe("session");
  });

  test("the scheduler's header with the cron secret is cron", async () => {
    expect(await identify(asCron(`Bearer ${CRON}`), LIVE)).toBe("cron");
  });

  test("a missing, forged, expired or foreign session is nobody", async () => {
    const good = await sessionToken();
    const refused: (string | undefined | null)[] = [
      undefined,
      null,
      "",
      "not-a-session",
      `${good}x`,
      good.split(".")[0],
      await sessionToken(LIVE, COOKIE_MAX_AGE + 1),
      await sessionToken({ ...LIVE, SESSION_SECRET: OTHER_KEY }),
    ];
    for (const token of refused) {
      expect(await identify(asSession(token), LIVE), String(token).slice(0, 16)).toBeNull();
    }
  });

  test("the environment it is given decides, not the real one", async () => {
    const good = await sessionToken();
    expect(await identify(asSession(good), { ...LIVE, SESSION_SECRET: OTHER_KEY })).toBeNull();
    // A changed password ends the session here too.
    expect(await identify(asSession(good), { ...LIVE, SITE_PASSWORD_HASH: OTHER_HASH })).toBeNull();
    expect(await identify(asSession(good), {})).toBeNull();
    expect(await identify(asCron(`Bearer ${CRON}`), { ...LIVE, CRON_SECRET: "another-cron-secret-0123456789" })).toBeNull();
    expect(await identify(asCron(`Bearer ${CRON}`), {})).toBeNull();
  });

  test("a wrong, short or missing cron secret is nobody", async () => {
    for (const authorization of [null, "", "Bearer ", CRON, `Basic ${CRON}`, `Bearer ${CRON}x`, `bearer ${CRON}`]) {
      expect(await identify(asCron(authorization), LIVE), String(authorization)).toBeNull();
    }
    expect(await identify(asCron("Bearer short"), { ...LIVE, CRON_SECRET: "short" })).toBeNull();
    expect(await identify(asCron("Bearer undefined"), { ...LIVE, CRON_SECRET: undefined })).toBeNull();
  });

  test("one kind of credential is never accepted as the other", async () => {
    const good = await sessionToken();
    expect(await identify(asCron(good), LIVE)).toBeNull();
    expect(await identify(asCron(`Bearer ${good}`), LIVE)).toBeNull();
    expect(await identify(asSession(CRON), LIVE)).toBeNull();
    expect(await identify(asSession(`Bearer ${CRON}`), LIVE)).toBeNull();
  });

  test("a kind it does not know is nobody", async () => {
    const odd = { kind: "admin", token: await sessionToken() } as unknown as Credential;
    expect(await identify(odd, LIVE)).toBeNull();
  });
});

test.describe("what the caller gets", () => {
  /** A full store that records every call. */
  function recorder() {
    const calls: string[] = [];
    const full: ReadStore = {
      listLocations: async () => {
        calls.push("listLocations");
        return ok([]);
      },
      getLocation: async (id) => {
        calls.push(`getLocation ${id}`);
        return { ok: false, error: { code: "not_found" } };
      },
      listPhotos: async (id) => {
        calls.push(`listPhotos ${id}`);
        return ok({ photos: [], thumbs: [], cards: [] });
      },
      ping: async () => {
        calls.push("ping");
        return ok(null);
      },
    };
    return { calls, full };
  }

  test("a session gets the whole store", async () => {
    const { calls, full } = recorder();
    const store = storeFor("session", full);
    expect((await store.listLocations()).ok).toBe(true);
    await store.getLocation("a");
    await store.listPhotos("a");
    await store.ping();
    expect(calls).toEqual(["listLocations", "getLocation a", "listPhotos a", "ping"]);
  });

  test("the scheduler gets the ping and no data", async () => {
    const { calls, full } = recorder();
    const store = storeFor("cron", full);
    const refusal = { ok: false, error: { code: "unauthorized" } };
    expect(await store.listLocations()).toEqual(refusal);
    expect(await store.getLocation("a")).toEqual(refusal);
    expect(await store.listPhotos("a")).toEqual(refusal);
    // None of the three reached the real store.
    expect(calls).toEqual([]);
    expect(await store.ping()).toEqual({ ok: true, data: null });
    expect(calls).toEqual(["ping"]);
  });
});
