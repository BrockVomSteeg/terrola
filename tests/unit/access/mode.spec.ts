import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  LIVE_VARS,
  SESSION_SECRET_MIN_LENGTH,
  assertRuntime,
  bootCheck,
  checkEnv,
  getMode,
  isDemo,
  isReadOnlyDemo,
  resolveMode,
} from "@/lib/mode";
import { register } from "@/instrumentation";

// SPEC R3 and section 4. Every case passes its own env object, so nothing here
// reads or changes the real process environment (the one `register` test aside).

type Env = Record<string, string | undefined>;

const LIVE = [undefined, "", "  ", "0", "false", "FALSE", "off", " Off "];
const READ_ONLY = ["1", "true", "readonly", "yes", "anything"];
const VALUE = "unit-test-value-that-must-never-be-printed";
const LONG_KEY = "k".repeat(SESSION_SECRET_MIN_LENGTH);

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return (err as Error).message;
  }
  return "";
}

test.describe("lib/mode: which mode", () => {
  for (const raw of LIVE) {
    test(`DEMO_MODE ${JSON.stringify(raw)} means live`, () => {
      expect(getMode({ DEMO_MODE: raw })).toBe("live");
    });
  }

  for (const raw of READ_ONLY) {
    test(`DEMO_MODE ${JSON.stringify(raw)} means demo-readonly`, () => {
      expect(getMode({ DEMO_MODE: raw })).toBe("demo-readonly");
    });
  }

  test("DEMO_MODE writable means demo-writable, in any case", () => {
    expect(getMode({ DEMO_MODE: "writable", NODE_ENV: "test" })).toBe(
      "demo-writable",
    );
    expect(getMode({ DEMO_MODE: " Writable ", NODE_ENV: "development" })).toBe(
      "demo-writable",
    );
  });

  test("isDemo and isReadOnlyDemo follow getMode", () => {
    expect(isDemo({})).toBe(false);
    expect(isReadOnlyDemo({})).toBe(false);
    expect(isDemo({ DEMO_MODE: "1" })).toBe(true);
    expect(isReadOnlyDemo({ DEMO_MODE: "1" })).toBe(true);
    expect(isDemo({ DEMO_MODE: "writable", NODE_ENV: "test" })).toBe(true);
    expect(isReadOnlyDemo({ DEMO_MODE: "writable", NODE_ENV: "test" })).toBe(
      false,
    );
  });
});

test.describe("lib/mode: a demo never runs next to real data (R3)", () => {
  test("the live variables are the five names in R3", () => {
    expect([...LIVE_VARS].sort()).toEqual(
      [
        "NEXT_PUBLIC_SUPABASE_URL",
        "SESSION_SECRET",
        "SITE_PASSWORD_HASH",
        "SUPABASE_SERVICE_KEY",
        "SUPABASE_URL",
      ].sort(),
    );
  });

  for (const name of [
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SITE_PASSWORD_HASH",
    "SESSION_SECRET",
  ]) {
    for (const raw of ["1", "writable"]) {
      test(`DEMO_MODE=${raw} refuses ${name} and never prints its value`, () => {
        const env: Env = { DEMO_MODE: raw, NODE_ENV: "test", [name]: VALUE };
        for (const run of [() => getMode(env), () => resolveMode(env)]) {
          const message = messageOf(run);
          expect(message).toContain(name);
          expect(message).not.toContain(VALUE);
        }
      });
    }
  }

  test("the refusal names every live variable that is set", () => {
    const message = messageOf(() =>
      getMode({
        DEMO_MODE: "1",
        SUPABASE_URL: VALUE,
        SESSION_SECRET: VALUE,
      }),
    );
    expect(message).toContain("SUPABASE_URL");
    expect(message).toContain("SESSION_SECRET");
    expect(message).not.toContain("SITE_PASSWORD_HASH");
    expect(message).not.toContain(VALUE);
  });

  test("an empty live variable is not a conflict", () => {
    expect(
      getMode({ DEMO_MODE: "1", SUPABASE_SERVICE_KEY: "", SESSION_SECRET: "" }),
    ).toBe("demo-readonly");
  });

  test("live mode is not affected by the live variables", () => {
    expect(
      getMode({ SUPABASE_SERVICE_KEY: VALUE, SESSION_SECRET: VALUE }),
    ).toBe("live");
  });
});

test.describe("lib/mode: where a writable demo may run (section 4)", () => {
  const REFUSED: Env[] = [
    { NODE_ENV: "production" },
    { NODE_ENV: undefined },
    { NODE_ENV: "staging" },
    { NODE_ENV: "test", VERCEL_ENV: "production" },
    { NODE_ENV: "test", VERCEL_ENV: "preview" },
    { NODE_ENV: "development", VERCEL_ENV: "development" },
    { NODE_ENV: "test", VERCEL: "1" },
  ];

  for (const extra of REFUSED) {
    test(`a writable demo is refused with ${JSON.stringify(extra)}`, () => {
      const env: Env = { DEMO_MODE: "writable", ...extra };
      expect(() => getMode(env)).toThrow(/writable/i);
      expect(() => assertRuntime("demo-writable", env)).toThrow(/writable/i);
    });
  }

  test("a writable demo on a Vercel production deployment says so", () => {
    expect(() =>
      getMode({
        DEMO_MODE: "writable",
        NODE_ENV: "test",
        VERCEL_ENV: "production",
      }),
    ).toThrow(/production/i);
  });

  test("the read only demo and live mode run anywhere", () => {
    for (const extra of REFUSED) {
      expect(getMode({ DEMO_MODE: "1", ...extra })).toBe("demo-readonly");
      expect(getMode({ ...extra })).toBe("live");
    }
  });

  test("resolveMode leaves the runtime rule out, so a writable demo can be built", () => {
    // `next build` runs with NODE_ENV=production. The build check must still
    // refuse a demo next to a live variable (above) without refusing the build.
    expect(resolveMode({ DEMO_MODE: "writable", NODE_ENV: "production" })).toBe(
      "demo-writable",
    );
  });
});

test.describe("lib/mode: what live mode still needs", () => {
  test("nothing set: every name is listed, the session key with its length", () => {
    const { mode, missing } = checkEnv({});
    expect(mode).toBe("live");
    expect(missing).toHaveLength(4);
    expect(missing.join(" ")).toContain("SUPABASE_URL");
    expect(missing.join(" ")).toContain("SUPABASE_SERVICE_KEY");
    expect(missing.join(" ")).toContain("SITE_PASSWORD_HASH");
    expect(missing.join(" ")).toContain("SESSION_SECRET");
    expect(missing.join(" ")).toContain(String(SESSION_SECRET_MIN_LENGTH));
  });

  test("a complete live setup has nothing missing; either address name counts", () => {
    const base: Env = {
      SUPABASE_SERVICE_KEY: VALUE,
      SITE_PASSWORD_HASH: VALUE,
      SESSION_SECRET: LONG_KEY,
    };
    expect(checkEnv({ ...base, SUPABASE_URL: VALUE }).missing).toEqual([]);
    expect(checkEnv({ ...base, NEXT_PUBLIC_SUPABASE_URL: VALUE }).missing).toEqual(
      [],
    );
  });

  test("a session key one character short counts as missing", () => {
    const { missing } = checkEnv({
      SUPABASE_URL: VALUE,
      SUPABASE_SERVICE_KEY: VALUE,
      SITE_PASSWORD_HASH: VALUE,
      SESSION_SECRET: "k".repeat(SESSION_SECRET_MIN_LENGTH - 1),
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("SESSION_SECRET");
  });

  test("a demo needs nothing", () => {
    expect(checkEnv({ DEMO_MODE: "1" })).toEqual({
      mode: "demo-readonly",
      missing: [],
    });
  });
});

test.describe("boot check (instrumentation)", () => {
  function recorder() {
    const lines: string[] = [];
    return {
      lines,
      log: (...args: unknown[]) => void lines.push(`log ${args.join(" ")}`),
      warn: (...args: unknown[]) => void lines.push(`warn ${args.join(" ")}`),
    };
  }

  test("logs the mode and warns with names only when live mode is incomplete", () => {
    const out = recorder();
    expect(bootCheck({ SUPABASE_SERVICE_KEY: VALUE }, out)).toBe("live");
    const text = out.lines.join("\n");
    expect(text).toContain("live");
    expect(text).toMatch(/warn .*SESSION_SECRET/);
    expect(text).toContain("SITE_PASSWORD_HASH");
    expect(text).not.toContain(VALUE);
  });

  test("does not warn when nothing is missing", () => {
    const out = recorder();
    expect(bootCheck({ DEMO_MODE: "1" }, out)).toBe("demo-readonly");
    expect(out.lines.filter((l) => l.startsWith("warn"))).toEqual([]);
  });

  test("throws on a demo next to a live variable and on a writable demo in production", () => {
    expect(() =>
      bootCheck({ DEMO_MODE: "1", SESSION_SECRET: VALUE }, recorder()),
    ).toThrow(/SESSION_SECRET/);
    expect(() =>
      bootCheck({ DEMO_MODE: "writable", NODE_ENV: "production" }, recorder()),
    ).toThrow(/writable/i);
  });

  test("register runs the boot check on the real environment", () => {
    const env = process.env as Env;
    const names = ["DEMO_MODE", ...LIVE_VARS];
    const saved = names.map((name) => [name, env[name]] as const);
    try {
      for (const name of names) delete env[name];
      expect(() => register()).not.toThrow();
      env.DEMO_MODE = "1";
      env.SESSION_SECRET = VALUE;
      expect(() => register()).toThrow(/SESSION_SECRET/);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
    }
  });
});

test.describe("scripts/check-env.mjs", () => {
  const script = path.join(process.cwd(), "scripts", "check-env.mjs");

  function run(vars: Record<string, string>) {
    // A clean environment: only PATH plus the variables under test.
    const clean: Env = { PATH: process.env.PATH ?? "", ...vars };
    const result = spawnSync(process.execPath, [script], {
      env: clean as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    return {
      status: result.status,
      text: `${result.stdout}\n${result.stderr}`,
    };
  }

  test("live with nothing set exits 0 and lists the missing names", () => {
    const { status, text } = run({});
    expect(status, text).toBe(0);
    expect(text).toContain("live");
    expect(text).toContain("SESSION_SECRET");
  });

  test("a demo next to a live variable exits 1 with the name and no value", () => {
    const { status, text } = run({ DEMO_MODE: "1", SESSION_SECRET: VALUE });
    expect(status, text).toBe(1);
    expect(text).toContain("SESSION_SECRET");
    expect(text).not.toContain(VALUE);
  });

  test("a writable demo passes the build check with NODE_ENV=production", () => {
    const { status, text } = run({
      DEMO_MODE: "writable",
      NODE_ENV: "production",
    });
    expect(status, text).toBe(0);
    expect(text).toContain("demo-writable");
  });
});
