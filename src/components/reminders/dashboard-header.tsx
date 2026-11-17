import Link from "next/link";
import { Suspense } from "react";
import { resendVerificationEmailAction } from "@/app/dashboard/verification-actions";
import { ResendVerificationButton } from "@/components/auth/resend-verification-button";
import { getDb } from "@/db";
import { verificationBlockerMessage, verificationEmailBlocker } from "@/lib/email/eligibility";
import { getEmailState } from "@/lib/env";
import { requireUser } from "@/lib/session";
import { TimeZoneDetector } from "@/components/settings/time-zone-detector";
import { countDueReminders } from "@/server/reminders";
import { getUserSettings } from "@/server/settings";

function RemindersLink({ due }: { due: number | null }) {
  const label = due === null ? "Reminders" : due === 0 ? "Reminders, none due" : `Reminders, ${due} due`;
  return (
    <Link
      href="/dashboard/reminders"
      aria-label={label}
      className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-muted"
    >
      Reminders
      {due !== null && due > 0 && (
        <span className="rounded-full bg-destructive px-2 text-xs font-semibold text-white" aria-hidden="true">
          {due}
        </span>
      )}
    </Link>
  );
}

async function DueRemindersLink() {
  const user = await requireUser();
  return <RemindersLink due={await countDueReminders(getDb(), user.id)} />;
}

/** Mounts the browser time zone detector only while the user has no stored zone. */
async function TimeZoneCheck() {
  const user = await requireUser();
  const { timeZone } = await getUserSettings(getDb(), user.id);
  return timeZone === null ? <TimeZoneDetector /> : null;
}

/**
 * Shown only while the user's address is not verified (S17): sign-in is never blocked, but reminder
 * emails wait for verification. Says when email is unavailable or the address is not allowed.
 */
async function VerificationBanner() {
  const user = await requireUser();
  if (user.emailVerified) return null;
  const blocker = verificationEmailBlocker(getEmailState(), user.email);
  return (
    <div
      role="region"
      aria-label="Email verification"
      className="flex flex-col gap-2 border-t bg-muted/50 px-6 py-2 text-sm"
    >
      <p>
        Your email address ({user.email}) is not verified, so you do not get reminder emails. Open the link we emailed
        you, or ask for a new one.
      </p>
      {blocker && <p className="text-muted-foreground">{verificationBlockerMessage(blocker)}</p>}
      <ResendVerificationButton action={resendVerificationEmailAction} />
    </div>
  );
}

/**
 * Bar at the top of every dashboard page with the number of due reminders and, for unverified
 * addresses, the verification banner. Rendered by each page, not a layout, so it is fresh on every
 * navigation (layouts are kept across navigations).
 */
export function DashboardHeader() {
  return (
    <header className="border-b">
      <div className="flex items-center justify-between gap-4 px-6 py-2">
        <Link href="/dashboard" className="font-semibold">
          laFija
        </Link>
        <nav aria-label="Dashboard" className="flex items-center gap-2">
          <Link href="/dashboard/stats" className="rounded-lg px-2 py-1 text-sm hover:bg-muted">
            Statistics
          </Link>
          {/* The session read is request data: the count streams in behind this boundary. */}
          <Suspense fallback={<RemindersLink due={null} />}>
            <DueRemindersLink />
          </Suspense>
        </nav>
        <Suspense fallback={null}>
          <TimeZoneCheck />
        </Suspense>
      </div>
      <Suspense fallback={null}>
        <VerificationBanner />
      </Suspense>
    </header>
  );
}
