import { defineConfig, devices } from "@playwright/test";

/**
 * Demo tier: checks the deployed demo, not a local server. The map only draws with a
 * Mapbox token, and the demo token works only on the demo address, so a server started
 * inside CI would show the setup screen instead of the map (SPEC R13, R14).
 *
 * No web server and no env file. Set E2E_BASE to point the suite at another address.
 * Only the accessibility suite runs here: the other specs in tests/e2e need a local
 * server and a password (playwright.config.ts).
 *
 *   npm run test:e2e
 */
const BASE_URL = process.env.E2E_BASE ?? "https://terrola.vercel.app";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["a11y.spec.ts"],
  timeout: 60_000,
  // One retry on CI for a slow network or a cold start of the demo. A real accessibility
  // problem fails both tries.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "demo-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
