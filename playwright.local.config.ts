import { defineConfig } from "@playwright/test";
import { loadEnvConfig } from "@next/env";

// Load .env.* (gitignored) into process.env so the local write-suite gets
// SITE_PASSWORD etc. `dev=true`: this suite targets `next dev`, so it reads the
// same env precedence the dev server does, including `.env.development.local`.
// Absent that file it loads `.env.local`; present, the override wins in both
// processes.
loadEnvConfig(process.cwd(), true);

/**
 * Local-only gesture suite for the photo reframe + reorder UI. Runs against the
 * dev server (`npm run dev`, default :3000). Kept in its own
 * testDir so the e2e config (`playwright.config.ts`) never picks it up.
 *
 *   npm run dev                      # in one shell (serves :3000)
 *   npm run test:e2e:local           # in another
 */
export default defineConfig({
  testDir: "./tests/local",
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE ?? "http://localhost:3000",
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "local-chromium", use: { browserName: "chromium" } },
    // Mirrors the real iPhone-Safari-on-cellular condition: WebKit (where
    // img.decode() rejects on cross-origin signed URLs) at DPR 3 (where an
    // under-sized thumb visibly upscales). Run with:
    //   npx playwright install webkit
    //   npx playwright test -c playwright.local.config.ts --project=local-webkit --workers=1
    {
      name: "local-webkit",
      use: {
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        hasTouch: true,
      },
    },
  ],
});
