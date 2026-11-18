import { expect, test } from "@playwright/test";

test("signed-out visitors of the dashboard land on sign-in", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page).toHaveURL("/sign-in?next=%2Fdashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});

test("sign-in explains that Google was refused for an existing email account", async ({ page }) => {
  await page.goto("/sign-in?error=account_not_linked");

  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "An account with this email already exists. Sign in with your email and password.",
  );
});

test("sign-in shows a generic message for other sign-in errors", async ({ page }) => {
  await page.goto("/sign-in?error=state_mismatch");

  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Sign-in failed. Please try again.");
});

test("sign-in shows no error without an error code", async ({ page }) => {
  await page.goto("/sign-in");

  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("a failed sign-in request re-enables the form and shows an error", async ({ page }) => {
  await page.route("**/api/auth/sign-in/email", (route) => route.abort());
  await page.goto("/sign-in");

  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Something went wrong. Please try again.");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

test("a failed sign-up request re-enables the form and shows an error", async ({ page }) => {
  await page.route("**/api/auth/sign-up/email", (route) => route.abort());
  await page.goto("/sign-up");

  await page.getByLabel("Name").fill("Ana");
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Something went wrong. Please try again.");
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled();
});

test("a failed Google request re-enables the form and shows an error", async ({ page }) => {
  await page.route("**/api/auth/sign-in/social", (route) => route.abort());
  await page.goto("/sign-in");

  await page.getByRole("button", { name: "Continue with Google" }).click();

  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Google sign-in is not available right now.");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

test("Google errors return to sign-in keeping the destination", async ({ page }) => {
  let body: unknown;
  await page.route("**/api/auth/sign-in/social", (route) => {
    body = route.request().postDataJSON();
    return route.abort();
  });
  await page.goto("/sign-in?next=%2Fdashboard");

  await page.getByRole("button", { name: "Continue with Google" }).click();

  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  expect(body).toMatchObject({
    provider: "google",
    callbackURL: "/dashboard",
    errorCallbackURL: "/sign-in?next=%2Fdashboard",
  });
});

test("sign-up page links back to sign-in keeping the destination", async ({ page }) => {
  await page.goto("/sign-up?next=%2Fdashboard");

  await expect(page.getByRole("heading", { level: 1, name: "Create your account" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/sign-in?next=%2Fdashboard");
});
