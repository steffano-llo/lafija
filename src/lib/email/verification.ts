import { and, eq, isNull, lte, or } from "drizzle-orm";
import { APIError, isAPIError } from "better-auth/api";
import { userSettings } from "@/db/schema";
import type { Auth } from "@/lib/auth";
import type { EmailState, RecipientAllowlist } from "@/lib/env";
import { isDemoEmail } from "@/lib/validation/demo";
import type { Db } from "@/server/applications";
import { escapeHtml } from "./digest";
import { isAddressAllowed, verificationBlockerMessage, verificationEmailBlocker } from "./eligibility";
import type { EmailSender, SendResult } from "./types";

/** Where Better Auth redirects after the link is opened; it appends `&error=<code>` on failure. */
export const VERIFY_EMAIL_CALLBACK = "/verify-email?status=verified";

/** On-demand resends wait this long after the previous verification email to the same user. */
export const VERIFICATION_COOLDOWN_SECONDS = 60;

/** How long a verification link works (Better Auth `emailVerification.expiresIn`, seconds). */
export const VERIFICATION_LINK_HOURS = 24;

/** Better Auth error codes this module throws from `sendVerificationEmail`. */
export const VERIFICATION_COOLDOWN_CODE = "VERIFICATION_EMAIL_COOLDOWN";
export const VERIFICATION_FAILED_CODE = "VERIFICATION_EMAIL_FAILED";

/** Who may get a verification email and how it is sent; null = email delivery unavailable. */
export type VerificationDelivery = { recipients: RecipientAllowlist; sender: EmailSender } | null;

export function buildVerificationEmail(url: string): { subject: string; text: string; html: string } {
  const hours = `${VERIFICATION_LINK_HOURS} hours`;
  return {
    subject: "Verify your email for laFija",
    text: [
      "Confirm that this is your email address to get laFija reminder emails:",
      "",
      url,
      "",
      `The link works for ${hours}. If you did not create a laFija account, ignore this email.`,
    ].join("\n"),
    html:
      `<!doctype html><html><body style="font-family:sans-serif;line-height:1.4">` +
      `<p>Confirm that this is your email address to get laFija reminder emails:</p>` +
      `<p><a href="${escapeHtml(url)}">Verify my email</a></p>` +
      `<p style="color:#666;font-size:12px">The link works for ${hours}. If you did not create a laFija account, ignore this email.</p>` +
      `</body></html>`,
  };
}

/**
 * Starts the cooldown for `userId` at `now` unless a verification email was sent less than 60
 * seconds before. One statement (insert or conditional update of the settings row), so two
 * concurrent requests cannot both pass. Returns false while the cooldown runs.
 */
async function startCooldown(db: Db, userId: string, now: Date): Promise<boolean> {
  const limit = new Date(now.getTime() - VERIFICATION_COOLDOWN_SECONDS * 1000);
  const rows = await db
    .insert(userSettings)
    .values({ userId, verificationEmailSentAt: now })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { verificationEmailSentAt: now },
      setWhere: or(isNull(userSettings.verificationEmailSentAt), lte(userSettings.verificationEmailSentAt, limit)),
    })
    .returning({ userId: userSettings.userId });
  return rows.length > 0;
}

/** A failed send does not count: the cooldown this attempt started is undone. */
async function undoCooldown(db: Db, userId: string, now: Date): Promise<void> {
  await db
    .update(userSettings)
    .set({ verificationEmailSentAt: null })
    .where(and(eq(userSettings.userId, userId), eq(userSettings.verificationEmailSentAt, now)));
}

async function safeSend(sender: EmailSender, email: Parameters<EmailSender["send"]>[0]): Promise<SendResult> {
  try {
    return await sender.send(email);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "send failed" };
  }
}

/**
 * Better Auth `emailVerification.sendVerificationEmail`, used on sign-up (and for a new Google user
 * whose address Google has not verified) and by `resendVerificationEmail`. Without delivery, or for
 * an address the allowlist does not include, and always for a demo address (S23), it sends nothing
 * (Resend is never called). Otherwise it
 * starts the 60-second cooldown (refusing with `VERIFICATION_EMAIL_COOLDOWN` while it runs) and
 * sends the link through the same sender and `EMAIL_FROM` as reminder emails. The link lands on
 * `/verify-email`, whatever callback URL the client sent.
 */
export function createSendVerificationEmail(db: Db, delivery: VerificationDelivery) {
  return async ({ user, url }: { user: { id: string; email: string }; url: string }): Promise<void> => {
    if (isDemoEmail(user.email) || !delivery || !isAddressAllowed(delivery.recipients, user.email)) return;
    const link = new URL(url);
    link.searchParams.set("callbackURL", VERIFY_EMAIL_CALLBACK);
    const now = new Date();
    if (!(await startCooldown(db, user.id, now))) {
      throw new APIError("TOO_MANY_REQUESTS", {
        code: VERIFICATION_COOLDOWN_CODE,
        message: "A verification email was sent less than a minute ago.",
      });
    }
    const result = await safeSend(delivery.sender, {
      to: user.email,
      ...buildVerificationEmail(link.href),
      // One send per user and cooldown slot: a retried request is not delivered twice.
      idempotencyKey: `lafija-verify-${user.id}-${now.getTime()}`,
    });
    if (!result.ok) {
      await undoCooldown(db, user.id, now);
      throw new APIError("BAD_GATEWAY", {
        code: VERIFICATION_FAILED_CODE,
        message: "The verification email could not be sent.",
      });
    }
  };
}

export type ResendResult = { ok: boolean; message: string };

/**
 * The "Resend verification email" button: always the signed-in user's own address (Better Auth
 * refuses another one with EMAIL_MISMATCH, and its HTTP endpoint is disabled). Demo accounts are
 * refused before anything else (S23). Says plainly why
 * nothing is sent when delivery is unavailable or the address is not allowed, without calling
 * the sender.
 */
export async function resendVerificationEmail(auth: Auth, headers: Headers, state: EmailState): Promise<ResendResult> {
  const session = await auth.api.getSession({ headers });
  if (!session) return { ok: false, message: "Your session has ended. Sign in again." };
  const { email, emailVerified } = session.user;
  if (isDemoEmail(email)) return { ok: false, message: "Demo accounts do not get email." };
  if (emailVerified) return { ok: false, message: "Your email address is already verified." };
  const blocker = verificationEmailBlocker(state, email);
  if (blocker) return { ok: false, message: verificationBlockerMessage(blocker) };
  try {
    await auth.api.sendVerificationEmail({ body: { email, callbackURL: VERIFY_EMAIL_CALLBACK }, headers });
  } catch (error) {
    if (isAPIError(error) && error.body?.code === VERIFICATION_COOLDOWN_CODE) {
      return { ok: false, message: "Please wait a minute before asking for another verification email." };
    }
    return { ok: false, message: "The verification email could not be sent. Please try again later." };
  }
  return { ok: true, message: `Verification email sent to ${email}. Check your inbox.` };
}
