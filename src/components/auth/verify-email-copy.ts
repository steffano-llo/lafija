export type VerifyEmailOutcome = {
  kind: "verified" | "expired" | "invalid" | "pending";
  title: string;
  body: string;
};

const NEW_LINK = "Sign in and use “Resend verification email” at the top of your dashboard to get a new one.";

type Param = string | string[] | undefined;

/**
 * What /verify-email says. Better Auth redirects there after the link is opened: to
 * `?status=verified` on success, with `&error=<code>` appended on failure (TOKEN_EXPIRED,
 * INVALID_TOKEN, USER_NOT_FOUND...), so an error always wins over the status.
 */
export function verifyEmailOutcome({ status, error }: { status?: Param; error?: Param }): VerifyEmailOutcome {
  if (typeof error === "string" && error !== "") {
    return error === "TOKEN_EXPIRED"
      ? { kind: "expired", title: "Verification link expired", body: `This link is no longer valid. ${NEW_LINK}` }
      : {
          kind: "invalid",
          title: "Invalid verification link",
          body: `This link is not valid: it may be incomplete or copied wrong. ${NEW_LINK}`,
        };
  }
  if (status === "verified") {
    return {
      kind: "verified",
      title: "Email verified",
      body: "Your email address is verified. Reminder emails can reach you while “Email me due reminders” is on in Settings.",
    };
  }
  return {
    kind: "pending",
    title: "Verify your email",
    body: "Open the link in the verification email we sent you. You can ask for a new one from your dashboard.",
  };
}
