#!/usr/bin/env node
// R10: a lane PR touches only files its lane owns. Lane comes from LANE or the branch name
// "lane/<name>". Changed files are `git diff --name-only --no-renames <BASE_REF>...HEAD`, so a
// moved file counts at its old path and at its new path.
// The lane map is read from BASE_REF, not from the working tree: a pull request cannot widen
// its own lane. CI also takes this script from BASE_REF (see .github/workflows/build.yml).
// A branch that is not a lane branch fails, except the names in ALLOWED. Protected files
// change on an "owner/<topic>" branch. That name is a convention for work the owner approved,
// not proof of approval: the ruleset and the token scopes are the real controls.
// Files in "protected" need owner review (CODEOWNERS); on a lane branch the gate reports them
// and fails unless OWNER_APPROVED=1 is set by a human-triggered run.
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args).toString();

const base = process.env.BASE_REF || "origin/main";
const cfg = JSON.parse(git("show", `${base}:LANES.json`));
const branch = process.env.LANE_BRANCH || git("rev-parse", "--abbrev-ref", "HEAD").trim();
const lane = process.env.LANE || (branch.startsWith("lane/") ? branch.slice(5) : "");

const ALLOWED = [/^main$/, /^owner\/[A-Za-z0-9._-]+$/, /^dependabot\//];
if (!lane) {
  if (ALLOWED.some((r) => r.test(branch))) {
    console.log(`lane-ownership: "${branch}" is not a lane branch, allowed by name, skipped`);
    process.exit(0);
  }
  console.error(
    `lane-ownership: "${branch}" is not a lane branch. Use lane/<name>, or owner/<topic> for work the owner approved.`,
  );
  process.exit(1);
}
if (!Object.hasOwn(cfg.lanes, lane)) {
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

const changed = git("diff", "--name-only", "--no-renames", `${base}...HEAD`)
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
