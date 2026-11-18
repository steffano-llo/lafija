"use server";

import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { resendVerificationEmail, type ResendResult } from "@/lib/email/verification";
import { getEmailState } from "@/lib/env";
import { requireUser } from "@/lib/session";

/**
 * "Resend verification email" in the dashboard banner. Always the signed-in user's own address;
 * at most once a minute; says plainly why nothing is sent when email is unavailable or the address
 * is not allowed.
 */
export async function resendVerificationEmailAction(): Promise<ResendResult> {
  await requireUser();
  return resendVerificationEmail(getAuth(), await headers(), getEmailState());
}
