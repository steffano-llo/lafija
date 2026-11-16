import { expect, test } from "@playwright/test";

// The detail page needs a signed-in user and a real database, so only the guard is exercised here;
// interviews, contacts, links, notes, history and isolation are covered by the PGlite tests in src/server.

test("signed-out visitors of an application detail page land on sign-in", async ({ page }) => {
  const path = "/dashboard/applications/some-id";
  await page.goto(path);

  await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(path)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});
