import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// A failed storage listing must never read as "no photos" (SPEC R17). The code that
// lists storage (lib/supabase-server.ts) and the live store that calls it
// (app/api/_lib/live-store.ts) both load the server only build, which the unit tier
// cannot load. So these are text checks: tripwires, not proofs. What they cannot
// show, a live run of the store contract has to: that a real storage error ends as
// `failed` and leaves the saved photo list as it was.

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

/** The source of one top level function, up to the next top level line. */
function topLevel(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end === -1 ? undefined : end + 2);
}

/** The source of one store method in live-store.ts, up to the next method. */
function method(source: string, name: string): string {
  const start = source.indexOf(`\n  async ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.slice(start + 1).search(/\n {2}async [a-zA-Z]+\(|\n\};/);
  return source.slice(start, next === -1 ? undefined : start + 1 + next);
}

test.describe("a failed storage listing", () => {
  const server = read("lib/supabase-server.ts");

  for (const name of ["listLocationPhotoFiles", "listAllLocationObjects"]) {
    test(`${name} throws on a storage error instead of answering an empty list`, () => {
      const body = topLevel(server, `export async function ${name}(`);
      expect(body).toContain("const { data, error } = await getSupabaseAdmin()");
      const check = body.indexOf('if (error) throw new Error("storage listing failed");');
      const empty = body.indexOf("if (!data?.length) return [];");
      expect(check).toBeGreaterThan(-1);
      // The error is looked at before an empty answer can be given.
      expect(check).toBeLessThan(empty);
    });
  }

  test("every storage listing in the file is one of those two", () => {
    expect(server.match(/\.list\(/g) ?? []).toHaveLength(2);
  });

  test("every store method that lists storage answers a throw as failed", () => {
    const store = read("app/api/_lib/live-store.ts");
    const listing = /rebuildPhotos\(|resolvePhotoOrder\(|listLocationPhotoFiles\(/;
    const methods = [
      "listPhotos",
      "updateLocation",
      "registerPhoto",
      "deletePhoto",
    ];
    for (const name of methods) {
      const body = method(store, name);
      expect(body, name).toMatch(listing);
      expect(body, name).toMatch(/\} catch \{\s+return refused\("failed"\);/);
    }
    // No other place in the file reaches the listing outside those methods and the
    // rebuildPhotos helper itself.
    const outside = store
      .split("\n")
      .filter((line) => listing.test(line))
      .filter((line) => !/^\s*(async function|const order = await resolvePhotoOrder\(id, stored\))/.test(line));
    const inMethods = methods
      .map((name) => method(store, name).split("\n").filter((line) => listing.test(line)).length)
      .reduce((a, b) => a + b, 0);
    expect(outside).toHaveLength(inMethods);
  });

  test("a reorder never saves an empty or short photo list", () => {
    const body = method(read("app/api/_lib/live-store.ts"), "updateLocation");
    const guard = body.indexOf(
      "if (signed.length === 0 || signed.length !== order.length)\n          return refused(\"failed\");",
    );
    const save = body.indexOf("updates.photos = signed;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(save);
  });
});

// signPhotoFiles drops a photo it cannot sign. Saving that list would drop the photo
// from the place's list, so a short list is a failure and nothing is saved.
test.describe("a photo that does not sign", () => {
  const store = read("app/api/_lib/live-store.ts");

  test("rebuildPhotos says when its list is short", () => {
    const body = topLevel(store, "async function rebuildPhotos(");
    expect(body).toContain("const photos = await signPhotoFiles(order);");
    expect(body).toContain("complete: photos.length === order.length,");
  });

  for (const name of ["registerPhoto", "deletePhoto"]) {
    test(`${name} answers failed for a short list before it saves anything`, () => {
      const body = method(store, name);
      const guard = body.indexOf('if (!complete) return refused("failed");');
      const save = body.indexOf("await persistPhotos(");
      expect(guard, name).toBeGreaterThan(-1);
      expect(save, name).toBeGreaterThan(-1);
      expect(guard, name).toBeLessThan(save);
      // `complete` is the one rebuildPhotos handed back in this method.
      expect(body, name).toMatch(/const \{[^}]*\bcomplete\b[^}]*\} = await rebuildPhotos\(/);
    });
  }
});
