import { expect, test } from "@playwright/test";

// The board needs a signed-in user and a real database, so only the guard is exercised here;
// moves, ordering and transitions are covered by the PGlite tests in src/server.

test("signed-out visitors of /dashboard/board land on sign-in", async ({ page }) => {
  await page.goto("/dashboard/board");

  await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent("/dashboard/board")}`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});
