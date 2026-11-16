import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DashboardHeader } from "@/components/reminders/dashboard-header";
import { FollowUpSettingsForm } from "@/components/reminders/follow-up-settings-form";
import { toReminderItem } from "@/components/reminders/form-state";
import { ReminderList } from "@/components/reminders/reminder-list";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { DONE_LIST_DAYS, getFollowUpDays, listReminders } from "@/server/reminders";

export const metadata: Metadata = { title: "Reminders · laFija" };

async function Reminders() {
  const user = await requireUser();
  const db = getDb();
  const [lists, followUpDays] = await Promise.all([listReminders(db, user.id), getFollowUpDays(db, user.id)]);

  return (
    <>
      <section aria-labelledby="settings-heading" className="flex flex-col gap-3 rounded-lg p-4 ring-1 ring-foreground/10">
        <h2 id="settings-heading" className="text-lg font-semibold">
          Automatic follow-ups
        </h2>
        <FollowUpSettingsForm followUpDays={followUpDays} />
        <p className="text-sm text-muted-foreground">
          Time zone and default currency are in{" "}
          <Link href="/dashboard/settings" className="underline underline-offset-4">
            Settings
          </Link>
          .
        </p>
      </section>
      <ReminderList id="due" title="Due" empty="Nothing due. Nice." reminders={lists.due.map(toReminderItem)} />
      <ReminderList
        id="upcoming"
        title="Upcoming"
        empty="No upcoming reminders."
        reminders={lists.upcoming.map(toReminderItem)}
      />
      <ReminderList
        id="done"
        title={`Done (last ${DONE_LIST_DAYS} days)`}
        empty="Nothing done recently."
        reminders={lists.done.map(toReminderItem)}
      />
    </>
  );
}

export default function RemindersPage() {
  return (
    <>
      <DashboardHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-12">
        <div className="flex flex-col gap-1">
          <Link href="/dashboard" className="text-sm text-muted-foreground hover:underline">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-semibold">Reminders</h1>
          <p className="text-sm text-muted-foreground">
            Reminders of archived applications are not shown. Add a reminder from an application&apos;s page.
          </p>
        </div>
        {/* The session read is request data: the lists stream in behind this boundary. */}
        <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
          <Reminders />
        </Suspense>
      </main>
    </>
  );
}
