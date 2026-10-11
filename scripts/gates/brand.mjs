#!/usr/bin/env node
// R5 and R11.
// R5: package.json "name" equals BRAND.slug and the manifest name equals BRAND.name. When BRAND is
//     no longer the working name, the working name must not appear anywhere in tracked files.
// R11: no CSS or TS rule may hide, dim or shrink the Mapbox logo or attribution controls.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const WORKING_SLUG = "unnamed-map";
const WORKING_NAME = "Unnamed Map";
const errors = [];

const brandSrc = readFileSync("lib/brand.ts", "utf8");
const slug = /slug:\s*"([^"]+)"/.exec(brandSrc)?.[1];
const name = /name:\s*"([^"]+)"/.exec(brandSrc)?.[1];
if (!slug || !name) errors.push("lib/brand.ts: cannot read BRAND.name or BRAND.slug");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (slug && pkg.name !== slug) errors.push(`package.json name "${pkg.name}" differs from BRAND.slug "${slug}"`);

try {
  const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
  if (name && manifest.name !== name) errors.push(`public/manifest.json name "${manifest.name}" differs from BRAND.name "${name}"`);
} catch {
  errors.push("public/manifest.json missing or invalid");
}

const files = execFileSync("git", ["ls-files", "-z"]).toString().split("\0").filter(Boolean);
const renamed = slug && slug !== WORKING_SLUG;
for (const f of files) {
  if (/\.(png|ico|jpg|jpeg|webp|woff2?)$/i.test(f) || f === "scripts/gates/brand.mjs" || f === "scripts/rename-project.mjs") continue;
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (renamed && (text.includes(WORKING_SLUG) || text.includes(WORKING_NAME))) {
    errors.push(`${f}: still contains the working name`);
  }
  if (/\.(css|tsx?)$/.test(f)) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!/mapboxgl-ctrl-(logo|attrib)/.test(line)) return;
      const window = lines.slice(i, i + 8).join(" ");
      if (/(opacity\s*:\s*0?\.[0-8]|display\s*:\s*none|visibility\s*:\s*hidden|scale\(\s*0?\.[0-6])/.test(window)) {
        errors.push(`${f}:${i + 1}: Mapbox logo or attribution is hidden, dimmed or shrunk (R11)`);
      }
    });
  }
}

if (errors.length) {
  console.error("brand gate failed:");
  errors.forEach((e) => console.error("  " + e));
  process.exit(1);
}
console.log("brand gate: ok");
