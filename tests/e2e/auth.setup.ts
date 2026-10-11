import { test as setup, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

const authFile = "playwright/.auth/state.json";

setup("authenticate", async ({ page }) => {
  const password = process.env.SITE_PASSWORD;
  if (!password) {
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify({ cookies: [], origins: [] }));
    console.warn(
      "[app] SITE_PASSWORD not set, auth skipped, map tests will fail",
    );
    return;
  }

  fs.mkdirSync(path.dirname(authFile), { recursive: true });

  await page.goto("/");
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await page.fill('input[type="password"]', password);
  await page.click('button[aria-label="Submit password"]');
  await expect(page).toHaveURL(/\/map/, { timeout: 10_000 });

  await page.context().storageState({ path: authFile });
});
