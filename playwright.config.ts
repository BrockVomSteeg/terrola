import { defineConfig, devices } from "@playwright/test";
import { loadEnvConfig } from "@next/env";

// Load .env.local (gitignored) into process.env so the e2e suites get
// SITE_PASSWORD etc. In CI the values come from the workflow env (no .env.local
// present), so this is a no-op there.
loadEnvConfig(process.cwd());

const BASE_URL = process.env.E2E_BASE ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: ["**/tests/local/**"],
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    // Defaults to a local server. Set E2E_BASE to point the suite at any other
    // running instance.
    baseURL: BASE_URL,
    trace: "on-first-retry",
    launchOptions: {
      args: ["--disable-blink-features=AutomationControlled"],
    },
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        launchOptions: {
          args: ["--disable-blink-features=AutomationControlled"],
        },
      },
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/state.json",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        launchOptions: {
          args: ["--disable-blink-features=AutomationControlled"],
        },
      },
      dependencies: ["setup"],
    },
  ],
});
