import { expect, test } from "@playwright/test";

// Stage management needs a signed-in user and a real database, so only the guard is
// exercised here; the stage rules are covered by the PGlite tests in src/server.

test("signed-out visitors of /dashboard/stages land on sign-in", async ({ page }) => {
  await page.goto("/dashboard/stages");

  await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent("/dashboard/stages")}`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});
