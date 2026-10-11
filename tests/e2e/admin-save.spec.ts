import { test, expect } from "@playwright/test";

// Regression guard for the admin-save 401 dead-end. The bug: AdminPanel was
// optimistically CLOSED (onLocationAdded → setAdminOpen(false)) before the save
// fetch resolved, so on a 401 the "Session expired" toast was set on an already
// unmounted component and never rendered, the failure dead-ended silently and
// the pending edit was lost. Fix: the panel/form only close+reset on a CONFIRMED
// save, so a failure keeps the panel mounted (toast visible) with the edit intact.
//
// The suite runs against BASE_URL (default http://localhost:3000).
test("AdminPanel save 401 surfaces a toast and preserves the pending edit", async ({
  page,
}) => {
  await page.goto("/map");

  await page.click('[data-testid="admin-fab"]');
  await page.fill('[data-testid="admin-search"]', "San Francisco");
  await page.waitForSelector('[data-testid="admin-suggestion-0"]', {
    timeout: 8000,
  });
  await page.click('[data-testid="admin-suggestion-0"]');

  // Date is required for save to be enabled. Title is auto-filled from the
  // suggestion.
  await page.fill('[data-testid="admin-date"]', "2020-01-01");

  // Simulate session expiry between selection and save.
  await page.context().clearCookies();

  await page.click('[data-testid="admin-save"]');

  // 1) The 401 surfaces as a visible "Session expired" re-auth toast.
  await expect(page.locator("text=Session expired")).toBeVisible({
    timeout: 5000,
  });

  // 2) The pending edit is preserved, the panel stayed open and the form keeps
  //    its values, so the user can re-auth and retry rather than losing the edit.
  await expect(page.locator('[data-testid="admin-save"]')).toBeVisible();
  await expect(page.locator('[data-testid="admin-date"]')).toHaveValue(
    "2020-01-01",
  );
});
