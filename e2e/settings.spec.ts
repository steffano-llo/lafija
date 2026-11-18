import { expect, test } from "@playwright/test";

// The settings page needs a signed-in user and a real database, so only the guard is exercised here;
// time zone detection, realignment, default currency and isolation are covered by the PGlite tests in src/server.

test("signed-out visitors of the settings page land on sign-in", async ({ page }) => {
  const path = "/dashboard/settings";
  await page.goto(path);

  await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(path)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});
