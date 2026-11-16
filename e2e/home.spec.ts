import { expect, test } from "@playwright/test";

test("home page presents laFija", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("laFija");
  await expect(page.getByRole("heading", { level: 1, name: "laFija" })).toBeVisible();
});

test("home page leads signed-out visitors to their board through sign-in", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("link", { name: "Open your board" }).click();
  await expect(page).toHaveURL("/sign-in?next=%2Fdashboard%2Fboard");
});

test("home page offers account creation", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("link", { name: "Create account" }).click();
  await expect(page).toHaveURL("/sign-up");
  await expect(page.getByRole("heading", { level: 1, name: "Create your account" })).toBeVisible();
});
