#!/usr/bin/env node
// R10: a lane PR touches only files its lane owns. Lane comes from LANE or the branch name
// "lane/<name>". Changed files are `git diff --name-only <BASE_REF>...HEAD`.
// Files in "protected" need owner review (CODEOWNERS); the gate reports them and fails unless
// OWNER_APPROVED=1 is set by a human-triggered run.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync("LANES.json", "utf8"));
const branch =
  process.env.LANE_BRANCH ||
  execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
const lane = process.env.LANE || (branch.startsWith("lane/") ? branch.slice(5) : "");
if (!lane) {
  console.log("lane-ownership: not a lane branch, skipped");
  process.exit(0);
}
if (!cfg.lanes[lane]) {
  console.error(`lane-ownership: unknown lane "${lane}"`);
  process.exit(1);
}

const toRe = (g) =>
  new RegExp(
    "^" +
      g
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, ".*") +
      "$",
  );
const own = cfg.lanes[lane].map(toRe);
const prot = (cfg.protected || []).map(toRe);

const base = process.env.BASE_REF || "origin/main";
const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`])
  .toString()
  .split("\n")
  .filter(Boolean);

const bad = [];
const needOwner = [];
for (const f of changed) {
  if (prot.some((r) => r.test(f))) needOwner.push(f);
  if (!own.some((r) => r.test(f))) bad.push(f);
}
if (bad.length) {
  console.error(`lane-ownership: ${bad.length} file(s) outside lane "${lane}":`);
  bad.forEach((f) => console.error("  " + f));
}
if (needOwner.length && process.env.OWNER_APPROVED !== "1") {
  console.error("lane-ownership: protected files need owner review:");
  needOwner.forEach((f) => console.error("  " + f));
}
if (bad.length || (needOwner.length && process.env.OWNER_APPROVED !== "1")) process.exit(1);
console.log(`lane-ownership: ok (${changed.length} files, lane ${lane})`);
