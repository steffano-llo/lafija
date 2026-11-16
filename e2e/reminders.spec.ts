import { expect, test } from "@playwright/test";

// The reminders page needs a signed-in user and a real database, so only the guard is exercised here;
// reminders, automatic follow-ups, settings and isolation are covered by the PGlite tests in src/server.

test("signed-out visitors of the reminders page land on sign-in", async ({ page }) => {
  const path = "/dashboard/reminders";
  await page.goto(path);

  await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(path)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});
