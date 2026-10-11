#!/usr/bin/env node
// R2: fail when a tracked text file, a file name or a commit message matches the private pattern list.
// The list is never committed. It comes from PERSONAL_PATTERNS (newline separated) or from the
// file named by PERSONAL_PATTERNS_FILE. Output is path:line only, never the matched text.
//   REQUIRE_PATTERNS=1  exit 2 when no list is available (use this in the private repo's CI)
//   COMMIT_RANGE=a..b   also scan commit messages in that range (default: none)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const raw =
  process.env.PERSONAL_PATTERNS ??
  (process.env.PERSONAL_PATTERNS_FILE ? readFileSync(process.env.PERSONAL_PATTERNS_FILE, "utf8") : "");
// A line is a case-insensitive substring, or a regular expression when it starts with "re:".
const matchers = raw
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    if (s.startsWith("re:")) {
      const re = new RegExp(s.slice(3), "i");
      return (t) => re.test(t);
    }
    const needle = s.toLowerCase();
    return (t) => t.toLowerCase().includes(needle);
  });
const patterns = matchers;

// Files where an owner credit is expected (listed in scripts/gates/personal-allow.txt, one path per line).
let allow = new Set();
try {
  allow = new Set(
    readFileSync("scripts/gates/personal-allow.txt", "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#")),
  );
} catch {}

if (patterns.length === 0) {
  const msg = "personal-strings: no pattern list available";
  if (process.env.REQUIRE_PATTERNS === "1") {
    console.error(msg + " (REQUIRE_PATTERNS=1)");
    process.exit(2);
  }
  console.warn(msg + ", skipped");
  process.exit(0);
}

const hits = [];
const files = execFileSync("git", ["ls-files", "-z"], { maxBuffer: 1 << 28 })
  .toString()
  .split("\0")
  .filter(Boolean);

for (const f of files) {
  if (allow.has(f)) continue;
  if (patterns.some((m) => m(f))) hits.push(f + " (file name)");
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((m) => m(lines[i]))) hits.push(`${f}:${i + 1}`);
  }
}

if (process.env.COMMIT_RANGE) {
  const log = execFileSync("git", ["log", "--format=%H%x00%B%x01", process.env.COMMIT_RANGE], {
    maxBuffer: 1 << 28,
  }).toString();
  for (const entry of log.split("\x01")) {
    const [sha, body] = entry.split("\0");
    if (sha && body && patterns.some((m) => m(body))) {
      hits.push(`commit ${sha.trim().slice(0, 12)} (message)`);
    }
  }
}

if (hits.length) {
  console.error(`personal-strings: ${hits.length} hit(s)`);
  for (const h of hits.slice(0, 200)) console.error("  " + h);
  process.exit(1);
}
console.log(`personal-strings: clean (${files.length} files, ${patterns.length} patterns)`);
