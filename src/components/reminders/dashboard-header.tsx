import Link from "next/link";
import { Suspense } from "react";
import { getDb } from "@/db";
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
 * Bar at the top of every dashboard page with the number of due reminders. Rendered by each page,
 * not a layout, so it is fresh on every navigation (layouts are kept across navigations).
 */
export function DashboardHeader() {
  return (
    <header className="flex items-center justify-between gap-4 border-b px-6 py-2">
      <Link href="/dashboard" className="font-semibold">
        laFija
      </Link>
      {/* The session read is request data: the count streams in behind this boundary. */}
      <Suspense fallback={<RemindersLink due={null} />}>
        <DueRemindersLink />
      </Suspense>
      <Suspense fallback={null}>
        <TimeZoneCheck />
      </Suspense>
    </header>
  );
}
