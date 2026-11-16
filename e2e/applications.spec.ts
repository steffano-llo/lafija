import { expect, test } from "@playwright/test";

// A signed-in flow (create, edit, archive) needs a real database and account, so it is not
// exercised here; the data rules are covered by the PGlite tests in src/server.

for (const path of [
  "/dashboard/applications",
  "/dashboard/applications?view=archived",
  "/dashboard/applications/new",
  "/dashboard/applications/some-id/edit",
]) {
  test(`signed-out visitors of ${path} land on sign-in`, async ({ page }) => {
    await page.goto(path);

    await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(path)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  });
}
