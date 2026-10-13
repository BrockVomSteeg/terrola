import { defineConfig } from "@playwright/test";

/**
 * Unit tier: plain Node tests. No browser, no web server, no network and no env
 * file, so `git clone`, `npm ci`, `npm test` passes on a cold clone (SPEC R8).
 * A run that finds zero tests fails.
 *
 * Each lane keeps its own tests under `tests/unit/<lane>/`.
 */
export default defineConfig({
  testDir: "./tests/unit",
  timeout: 10_000,
  retries: 0,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
});
