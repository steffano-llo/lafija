"use client";

import type { ReminderItem } from "./form-state";
import { ReminderCard } from "./reminder-card";

/** One section of the reminders page (Due, Upcoming or Done); each reminder links to its application. */
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
            <ReminderCard key={reminder.id} reminder={reminder} showApplication />
          ))}
        </ul>
      )}
    </section>
  );
}
