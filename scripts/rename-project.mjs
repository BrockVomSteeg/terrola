#!/usr/bin/env node
// Rename the project everywhere in tracked text files.
//   node scripts/rename-project.mjs --name "Wren Atlas" --slug wren-atlas [--dry]
// Replaces the current BRAND.name and BRAND.slug (read from lib/brand.ts) with the new values.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const newName = arg("--name");
const newSlug = arg("--slug");
const dry = process.argv.includes("--dry");
if (!newName || !newSlug || !/^[a-z0-9][a-z0-9-]*$/.test(newSlug)) {
  console.error('usage: rename-project.mjs --name "New Name" --slug new-slug [--dry]');
  process.exit(2);
}

const brandSrc = readFileSync("lib/brand.ts", "utf8");
const oldSlug = /slug:\s*"([^"]+)"/.exec(brandSrc)?.[1];
const oldName = /name:\s*"([^"]+)"/.exec(brandSrc)?.[1];
if (!oldSlug || !oldName) {
  console.error("cannot read the current BRAND values from lib/brand.ts");
  process.exit(1);
}

const files = execFileSync("git", ["ls-files", "-z"]).toString().split("\0").filter(Boolean);
let touched = 0;
for (const f of files) {
  if (/\.(png|ico|jpg|jpeg|webp|woff2?)$/i.test(f)) continue;
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const next = text.split(oldSlug).join(newSlug).split(oldName).join(newName);
  if (next !== text) {
    touched++;
    console.log((dry ? "would change " : "changed ") + f);
    if (!dry) writeFileSync(f, next);
  }
}
console.log(`${dry ? "dry run: " : ""}${touched} file(s). ${oldName} -> ${newName}, ${oldSlug} -> ${newSlug}`);
console.log("Then: rename the GitHub repository and the local directory, and re-run the gates.");
