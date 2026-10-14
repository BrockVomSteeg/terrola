import { expect, test } from "@playwright/test";
import { checkProvenance, listedAssets } from "../../../scripts/gates/provenance.mjs";

// SPEC R9. The inputs are made up: the gate itself runs on the real tree in the CI job `gates`.

const HEADER = [
  "| file | what it is | source | licence |",
  "|------|------------|--------|---------|",
];

const row = (file: string, source = "made for this project", licence = "MIT") =>
  `| \`${file}\` | a picture | ${source} | ${licence} |`;

const doc = (...rows: string[]) =>
  ["# Assets", "", "Every file under `public/`.", "", ...HEADER, ...rows, ""].join("\n");

test.describe("provenance gate (R9)", () => {
  test("passes when every file has a row with a source and a licence", () => {
    const files = ["public/icon.png", "public/demo/photos/one.svg"];
    expect(checkProvenance(files, doc(row(files[0]), row(files[1])))).toEqual([]);
  });

  test("passes with no files and no rows", () => {
    expect(checkProvenance([], doc())).toEqual([]);
  });

  test("fails on a file that is not listed, and names it", () => {
    const errors = checkProvenance(
      ["public/icon.png", "public/new.png"],
      doc(row("public/icon.png")),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("public/new.png");
    expect(errors[0]).toContain("not listed");
  });

  test("fails on a listed file that does not exist, with its line number", () => {
    const errors = checkProvenance(
      ["public/icon.png"],
      doc(row("public/icon.png"), row("public/gone.png")),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("docs/ASSETS.md:8: public/gone.png");
    expect(errors[0]).toContain("is listed but is not a file");
  });

  test("a folder or a pattern does not stand in for the files inside it", () => {
    for (const listed of ["public/demo/", "public/demo", "public/demo/**", "public/demo/*.svg"]) {
      const errors = checkProvenance(["public/demo/one.svg"], doc(row(listed)));
      expect(errors, listed).toHaveLength(2);
      expect(errors.join("\n"), listed).toContain("public/demo/one.svg: not listed");
      expect(errors.join("\n"), listed).toContain(`${listed} is listed but is not a file`);
    }
  });

  test("fails on a row with no source or no licence", () => {
    const noSource = checkProvenance(["public/a.png"], doc(row("public/a.png", "", "MIT")));
    expect(noSource).toHaveLength(1);
    expect(noSource[0]).toContain("has no source");

    const noLicence = checkProvenance(["public/a.png"], doc(row("public/a.png", "made here", "")));
    expect(noLicence).toHaveLength(1);
    expect(noLicence[0]).toContain("has no licence");
  });

  test("fails when the table has no source and licence columns", () => {
    const markdown = ["| file | what it is |", "|------|------------|", "| `public/a.png` | a picture |"].join("\n");
    const errors = checkProvenance(["public/a.png"], markdown);
    expect(errors.join("\n")).toContain("has no source");
    expect(errors.join("\n")).toContain("has no licence");
  });

  test("fails on a file listed twice", () => {
    const errors = checkProvenance(["public/a.png"], doc(row("public/a.png"), row("public/a.png")));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("listed twice");
  });

  test("a path counts only in the first column of a table row", () => {
    const markdown = [
      "The file `public/prose.png` is named in a paragraph.",
      "",
      ...HEADER,
      "| `public/a.png` | a render of `public/other.png` | made for this project | MIT |",
      "",
    ].join("\n");
    expect(listedAssets(markdown).map((r) => r.file)).toEqual(["public/a.png"]);
    const errors = checkProvenance(["public/a.png", "public/other.png", "public/prose.png"], markdown);
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toContain("public/other.png: not listed");
    expect(errors.join("\n")).toContain("public/prose.png: not listed");
  });

  test("rows for files outside public/ are left alone", () => {
    const markdown = [
      doc(row("public/a.png")),
      "## Outside `public/`",
      "",
      ...HEADER,
      row("docs/picture.jpg"),
      "",
    ].join("\n");
    expect(checkProvenance(["public/a.png"], markdown)).toEqual([]);
  });

  test("reads the source and licence columns by their header, in any order", () => {
    const markdown = [
      "| file | license | source |",
      "|------|---------|--------|",
      "| `public/a.png` | MIT | made for this project |",
    ].join("\n");
    expect(listedAssets(markdown)).toEqual([
      { file: "public/a.png", line: 3, source: "made for this project", licence: "MIT" },
    ]);
    expect(checkProvenance(["public/a.png"], markdown)).toEqual([]);
  });
});
