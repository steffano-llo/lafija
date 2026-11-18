import { expect, test } from "@playwright/test";

// Sending and verifying are covered on PGlite (src/lib/auth.test.ts). Here: the landing page of the
// verification link, a forged link through Better Auth's real endpoint, and the disabled public
// resend endpoint.

test("the verification landing page confirms success", async ({ page }) => {
  await page.goto("/verify-email?status=verified");

  await expect(page.getByRole("heading", { level: 1, name: "Email verified" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to your dashboard" })).toHaveAttribute("href", "/dashboard");
});

test("the verification landing page explains an expired link", async ({ page }) => {
  await page.goto("/verify-email?status=verified&error=TOKEN_EXPIRED");

  await expect(page.getByRole("heading", { level: 1, name: "Verification link expired" })).toBeVisible();
  await expect(page.getByText("This link is no longer valid.")).toBeVisible();
});

test("a forged verification link lands on the invalid-link explanation", async ({ page }) => {
  await page.goto(`/api/auth/verify-email?token=forged&callbackURL=${encodeURIComponent("/verify-email?status=verified")}`);

  await expect(page).toHaveURL("/verify-email?status=verified&error=INVALID_TOKEN");
  await expect(page.getByRole("heading", { level: 1, name: "Invalid verification link" })).toBeVisible();
});

test("the public resend endpoint is disabled", async ({ request }) => {
  const response = await request.post("/api/auth/send-verification-email", {
    data: { email: "someone@example.com" },
    maxRedirects: 0,
  });

  expect(response.status()).toBe(404);
});
