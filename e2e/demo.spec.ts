import { expect, test } from "@playwright/test";

// Demo creation, its seed, the cap, rate limiting, the no-email rule and the cleanup are covered by
// Vitest on PGlite (src/server/demo.test.ts, src/server/demo-safety.test.ts). Clicking the button
// here would create a demo account in the database of the server under test, so it is not clicked.

test("home page offers the demo", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Try the demo" })).toBeVisible();
  await expect(page.getByText("The demo account and its sample data are deleted 24 hours after it is created.")).toBeVisible();
});

test("sign-in page offers the demo", async ({ page }) => {
  await page.goto("/sign-in");

  await expect(page.getByRole("button", { name: "Try the demo" })).toBeVisible();
});

const cleanup = "/api/cron/cleanup";

test("GET on the cleanup cron endpoint is 405", async ({ request }) => {
  const response = await request.get(cleanup, { maxRedirects: 0 });

  expect(response.status()).toBe(405);
});

test("an unsigned or forged POST to the cleanup endpoint is refused without a sign-in redirect", async ({ request }) => {
  const unsigned = await request.post(cleanup, { data: {}, maxRedirects: 0 });
  expect([401, 503]).toContain(unsigned.status());
  expect(await unsigned.json()).toEqual(
    unsigned.status() === 401 ? { error: "Invalid signature." } : { error: "The cleanup job is not configured." },
  );

  const forged = await request.post(cleanup, {
    data: {},
    headers: { "upstash-signature": "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJVcHN0YXNoIn0.forged" },
    maxRedirects: 0,
  });
  expect([401, 503]).toContain(forged.status());
});
