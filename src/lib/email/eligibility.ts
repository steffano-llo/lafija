import type { EmailState, RecipientAllowlist } from "@/lib/env";
import { isDemoEmail } from "@/lib/validation/demo";

/**
 * Why a user does not get reminder emails (S17). The rule: email delivery is configured, the
 * address is verified (Google sign-in counts when Google says so), "Email me due reminders" is on,
 * and the allowlist has `*` or the address. Being listed never bypasses verification.
 * Demo accounts never get email (S23), whatever else holds: `demo_account` is then the only problem.
 * `src/server/reminder-emails.ts` applies the same rule in SQL.
 */
export type EmailProblem =
  | "demo_account"
  | "not_configured"   | "misconfigured"
  | "unverified"
  | "switched_off"
  | "not_allowed";

/** `*`, or the address listed (ignoring case). */
export function isAddressAllowed(recipients: RecipientAllowlist, email: string): boolean {
  return recipients.everyone || recipients.addresses.includes(email.trim().toLowerCase());
}

/** Every failing condition, in the order Settings lists them; empty means the user gets email. */
export function reminderEmailProblems({
  state,
  email,
  emailVerified,
  emailReminders,
  isDemo = false,
}: {
  state: EmailState;
  email: string;
  emailVerified: boolean;
  emailReminders: boolean;
  /** The user has a demo_account row; a demo address counts as demo too. */
  isDemo?: boolean;
}): EmailProblem[] {
  if (isDemo || isDemoEmail(email)) return ["demo_account"];
  const problems: EmailProblem[] = [];
  if (!state.ok) problems.push(state.reason);
  if (!emailVerified) problems.push("unverified");
  if (!emailReminders) problems.push("switched_off");
  if (state.ok && !isAddressAllowed(state.config.recipients, email)) problems.push("not_allowed");
  return problems;
}

const PROBLEM_MESSAGES: Record<EmailProblem, string> = {
  demo_account: "Email reminders are unavailable for demo accounts.",
  not_configured: "Email delivery is not set up for laFija.",
  misconfigured: "Email delivery is unavailable: its configuration is invalid.",
  unverified: "Your email address is not verified yet.",
  switched_off: "“Email me due reminders” is off.",
  not_allowed:
    "Email delivery is limited while laFija has no domain, and your address is not one of the allowed recipients.",
};

/** English explanation; never names variables, values or allowlist entries. */
export function emailProblemMessage(problem: EmailProblem): string {
  return PROBLEM_MESSAGES[problem];
}

export type VerificationBlocker = "not_configured" | "misconfigured" | "not_allowed";

/** Why a verification email cannot be sent to `email`, or null when it can. */
export function verificationEmailBlocker(state: EmailState, email: string): VerificationBlocker | null {
  if (!state.ok) return state.reason;
  return isAddressAllowed(state.config.recipients, email) ? null : "not_allowed";
}

const BLOCKER_MESSAGES: Record<VerificationBlocker, string> = {
  not_configured: "Email delivery is not set up for laFija, so the verification email cannot be sent.",
  misconfigured: "Email delivery is unavailable right now, so the verification email cannot be sent.",
  not_allowed:
    "Email delivery is limited while laFija has no domain, so the verification email cannot be sent to your address.",
};

export function verificationBlockerMessage(blocker: VerificationBlocker): string {
  return BLOCKER_MESSAGES[blocker];
}
