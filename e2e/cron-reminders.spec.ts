import { expect, test } from "@playwright/test";

// Signature checks, the job and the 503 path are covered by Vitest (src/server/reminder-cron.test.ts,
// src/app/api/cron/reminders/route.test.ts). Here: the route only answers POST, is not behind the
// sign-in redirect, and never runs for an unsigned or forged request (401 when email is configured
// on the server under test, 503 when it is not).

const path = "/api/cron/reminders";

test("GET on the reminders cron endpoint is 405", async ({ request }) => {
  const response = await request.get(path, { maxRedirects: 0 });

  expect(response.status()).toBe(405);
});

test("an unsigned POST is refused without running the job and without a sign-in redirect", async ({ request }) => {
  const response = await request.post(path, { data: {}, maxRedirects: 0 });

  expect([401, 503]).toContain(response.status());
  expect(await response.json()).toEqual(
    response.status() === 401 ? { error: "Invalid signature." } : { error: "Email reminders are not configured." },
  );
});

test("a POST with a forged signature is refused", async ({ request }) => {
  const response = await request.post(path, {
    data: {},
    headers: { "upstash-signature": "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJVcHN0YXNoIn0.forged" },
    maxRedirects: 0,
  });

  expect([401, 503]).toContain(response.status());
});
