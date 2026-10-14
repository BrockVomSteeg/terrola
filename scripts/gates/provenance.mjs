#!/usr/bin/env node
// R9: every file under public/ is listed in docs/ASSETS.md with a source and a licence, and
// docs/ASSETS.md lists no public/ file that does not exist.
// A file is listed when a table row starts with its full path in backticks, for example
//   | `public/icon-192.png` | what it is | source | licence |
// One row, one file. A folder or a pattern such as `public/demo/**` does not count: it would
// let a new file in with no source of its own. A path named in another column or in a
// paragraph does not count either. The "source" and "licence" columns are found by the words
// in the table's header row, and both must hold some text.
// The files are the tracked ones (`git ls-files public`), the list the doc is written from.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const DOC = "docs/ASSETS.md";

/** The cells of one table line. An escaped pipe stays inside its cell. */
const cells = (line) =>
  line
    .trim()
    .replace(/\\\|/g, "\u0000")
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.replace(/\u0000/g, "|").trim());

/**
 * The rows of the doc that list a file under public/.
 * @param {string} markdown the text of docs/ASSETS.md
 * @returns {{ file: string, line: number, source: string, licence: string }[]}
 */
export function listedAssets(markdown) {
  const rows = [];
  let columns = null; // set by the header row of the table being read
  markdown.split(/\r?\n/).forEach((text, index) => {
    if (!text.trim().startsWith("|")) {
      columns = null;
      return;
    }
    const row = cells(text);
    if (columns === null) {
      const names = row.map((cell) => cell.toLowerCase());
      columns = {
        source: names.indexOf("source"),
        licence: names.findIndex((cell) => cell === "licence" || cell === "license"),
      };
      return;
    }
    const match = /`(public\/[^`]+)`/.exec(row[0] ?? "");
    if (!match) return;
    rows.push({
      file: match[1],
      line: index + 1,
      source: row[columns.source] ?? "",
      licence: row[columns.licence] ?? "",
    });
  });
  return rows;
}

/**
 * The R9 check. Returns one message per problem; an empty list means the gate passes.
 * @param {string[]} publicFiles repo relative paths of the files under public/
 * @param {string} markdown the text of docs/ASSETS.md
 * @returns {string[]}
 */
export function checkProvenance(publicFiles, markdown) {
  const errors = [];
  const listed = new Map();
  for (const row of listedAssets(markdown)) {
    const where = `${DOC}:${row.line}: ${row.file}`;
    if (listed.has(row.file)) errors.push(`${where} is listed twice`);
    else listed.set(row.file, row);
    if (!row.source) errors.push(`${where} has no source`);
    if (!row.licence) errors.push(`${where} has no licence`);
  }
  const present = new Set(publicFiles);
  for (const file of [...present].sort()) {
    if (!listed.has(file)) errors.push(`${file}: not listed in ${DOC}. Add a row with its source and licence.`);
  }
  for (const row of listed.values()) {
    if (!present.has(row.file)) {
      errors.push(
        `${DOC}:${row.line}: ${row.file} is listed but is not a file under public/. List each file by its full path, not a folder or a pattern.`,
      );
    }
  }
  return errors;
}

function main() {
  let markdown;
  try {
    markdown = readFileSync(DOC, "utf8");
  } catch {
    console.error(`provenance gate failed:\n  ${DOC} is missing`);
    process.exit(1);
  }
  const files = execFileSync("git", ["ls-files", "-z", "public"]).toString().split("\0").filter(Boolean);
  const errors = checkProvenance(files, markdown);
  if (errors.length) {
    console.error("provenance gate failed:");
    errors.forEach((e) => console.error("  " + e));
    process.exit(1);
  }
  console.log(`provenance gate: ok (${files.length} files)`);
}

// Run the check only when this file is the script node was started with, so a unit test
// can import the functions above without running it.
if (basename(process.argv[1] ?? "") === "provenance.mjs") main();
