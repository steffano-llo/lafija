import { expect, test } from "@playwright/test";

test("signed-out visitors of the dashboard land on sign-in", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page).toHaveURL("/sign-in?next=%2Fdashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});

test("sign-up page links back to sign-in keeping the destination", async ({ page }) => {
  await page.goto("/sign-up?next=%2Fdashboard");

  await expect(page.getByRole("heading", { level: 1, name: "Create your account" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/sign-in?next=%2Fdashboard");
});
