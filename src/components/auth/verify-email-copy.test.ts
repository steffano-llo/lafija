import { describe, expect, it } from "vitest";
import { verifyEmailOutcome } from "./verify-email-copy";

describe("verifyEmailOutcome (S17 landing page)", () => {
  it("confirms success", () => {
    expect(verifyEmailOutcome({ status: "verified" })).toEqual({
      kind: "verified",
      title: "Email verified",
      body: "Your email address is verified. Reminder emails can reach you while “Email me due reminders” is on in Settings.",
    });
  });

  it("explains an expired link, even with the success status Better Auth keeps in the URL", () => {
    expect(verifyEmailOutcome({ status: "verified", error: "TOKEN_EXPIRED" })).toEqual({
      kind: "expired",
      title: "Verification link expired",
      body: "This link is no longer valid. Sign in and use “Resend verification email” at the top of your dashboard to get a new one.",
    });
  });

  it.each(["INVALID_TOKEN", "USER_NOT_FOUND", "anything"])("explains an invalid link (%s)", (error) => {
    expect(verifyEmailOutcome({ status: "verified", error })).toEqual({
      kind: "invalid",
      title: "Invalid verification link",
      body: "This link is not valid: it may be incomplete or copied wrong. Sign in and use “Resend verification email” at the top of your dashboard to get a new one.",
    });
  });

  it("explains what to do when opened without a result", () => {
    expect(verifyEmailOutcome({})).toEqual({
      kind: "pending",
      title: "Verify your email",
      body: "Open the link in the verification email we sent you. You can ask for a new one from your dashboard.",
    });
    expect(verifyEmailOutcome({ status: ["verified", "x"] })).toMatchObject({ kind: "pending" });
  });
});
