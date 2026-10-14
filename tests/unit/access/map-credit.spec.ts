import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// SPEC R11: the Mapbox wordmark and attribution stay in view. On a wide screen the list
// lies on top of the map's left edge, which is where the map draws both. These are
// checks of the source text, not of a rendered page: they are tripwires that fail when
// the list's width and the offset of the map's corner stop agreeing. The rendered proof
// is the screenshot in the README.

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

const sidebar = read("components", "Map", "Sidebar.tsx");
const canvas = read("components", "Map", "MapCanvas.tsx");

/** The width of the desktop list and its narrower width between 768px and 1023px. */
function sidebarWidths(): { wide: string; narrow: string } {
  const wide = /position: "fixed",\s*left: 0,\s*top: 0,\s*bottom: 0,\s*width: "(\d+px)"/.exec(
    sidebar,
  );
  const narrow =
    /@media \(min-width: 768px\) and \(max-width: 1023px\) \{\s*\.sidebar-desktop \{ width: (\d+px) !important; \}/.exec(
      sidebar,
    );
  if (!wide || !narrow) throw new Error("the list's widths were not found in Sidebar.tsx");
  return { wide: wide[1], narrow: narrow[1] };
}

test.describe("the Mapbox wordmark and attribution", () => {
  test("the list's two widths are where this test expects them", () => {
    expect(sidebarWidths()).toEqual({ wide: "320px", narrow: "280px" });
  });

  test("sit in the map's bottom left corner", () => {
    expect(canvas).toMatch(
      /new mapboxgl\.AttributionControl\(\{ compact: true \}\),\s*"bottom-left"/,
    );
    // The wordmark's place is the library's default, bottom left: nothing moves it.
    expect(canvas.includes("logoPosition")).toBe(false);
  });

  test("are moved out from under the list by exactly its width", () => {
    const { wide, narrow } = sidebarWidths();
    expect(canvas).toContain(
      `@media (min-width: 768px) and (max-width: 1023px) {\n          .mapboxgl-ctrl-bottom-left { left: calc(${narrow} + 6px) !important; }`,
    );
    expect(canvas).toContain(
      `@media (min-width: 1024px) {\n          .mapboxgl-ctrl-bottom-left { left: calc(${wide} + 6px) !important; }`,
    );
    // Same weight as the base rule, so the later one wins: the offsets must come after it.
    const base = canvas.indexOf("left: 6px !important;");
    expect(base).toBeGreaterThan(-1);
    expect(canvas.indexOf(`left: calc(${narrow} + 6px) !important;`)).toBeGreaterThan(base);
    expect(canvas.indexOf(`left: calc(${wide} + 6px) !important;`)).toBeGreaterThan(base);
  });

  test("the list is shown only from 768px up, where the offset applies", () => {
    expect(sidebar).toContain(
      "@media (max-width: 767px) {\n          .sidebar-desktop { display: none !important; }",
    );
  });

  test("no rule hides, fades or shrinks them", () => {
    const rules = canvas.match(/\.mapboxgl-ctrl-(logo|attrib|bottom-left)[^{]*\{[^}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const banned of ["display: none", "visibility:", "opacity:", "transform:", "font-size:", "clip"]) {
        expect(rule.includes(banned), `${banned} in ${rule.slice(0, 60)}`).toBe(false);
      }
    }
  });
});
