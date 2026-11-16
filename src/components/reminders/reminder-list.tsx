"use client";

import Link from "next/link";
import { LocalDateTime } from "@/components/applications/local-date-time";
import { REMINDER_KIND_LABELS } from "@/lib/validation/reminder";
import type { ReminderItem } from "./form-state";
import { ReminderActions } from "./reminder-actions";

/** One section of the reminders page (Due, Upcoming or Done) with done, snooze and a link to the application. */
export function ReminderList({
  id,
  title,
  empty,
  reminders,
}: {
  id: string;
  title: string;
  empty: string;
  reminders: ReminderItem[];
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        {title} <span className="text-sm font-normal text-muted-foreground">({reminders.length})</span>
      </h2>
      {reminders.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {reminders.map((reminder) => (
            <li key={reminder.id} className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-foreground/10">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className={reminder.doneAt ? "text-muted-foreground line-through" : "font-medium"}>
                  {reminder.message}
                </p>
                <span className="text-sm text-muted-foreground">
                  {REMINDER_KIND_LABELS[reminder.kind]} · due <LocalDateTime value={reminder.dueAt} />
                </span>
              </div>
              <Link
                href={`/dashboard/applications/${reminder.applicationId}`}
                className="w-fit text-sm underline-offset-4 hover:underline"
              >
                {reminder.role} at {reminder.companyName}
              </Link>
              <ReminderActions reminder={reminder} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
