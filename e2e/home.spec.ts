import { expect, test } from "@playwright/test";

test("home page presents laFija", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("laFija");
  await expect(page.getByRole("heading", { level: 1, name: "laFija" })).toBeVisible();
});
