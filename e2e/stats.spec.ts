import { expect, test } from "@playwright/test";

// The statistics page needs a signed-in user and a real database, so only the guard is exercised here;
// every metric, the archived toggle and per-user isolation are covered by src/server/stats.test.ts.

for (const path of ["/dashboard/stats", "/dashboard/stats?archived=exclude"]) {
  test(`signed-out visitors of ${path} land on sign-in`, async ({ page }) => {
    await page.goto(path);

    await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(path)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  });
}
