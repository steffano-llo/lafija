"use client";

import Link from "next/link";
import { useState } from "react";
import { updateReminderAction } from "@/app/dashboard/reminders/actions";
import { LocalDateTime, toLocalInputValue } from "@/components/applications/local-date-time";
import { REMINDER_KIND_LABELS } from "@/lib/validation/reminder";
import type { ReminderItem } from "./form-state";
import { ReminderActions } from "./reminder-actions";
import { ReminderForm } from "./reminder-form";

/**
 * One reminder as a list item, with Done, Snooze and the ⋯ menu (Edit, Delete). Edit swaps the
 * item for its form. `showApplication` adds a link to the application (reminders page).
 */
export function ReminderCard({ reminder, showApplication = false }: { reminder: ReminderItem; showApplication?: boolean }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="rounded-lg p-3 ring-1 ring-foreground/10">
        <ReminderForm
          idPrefix={`reminder-${reminder.id}`}
          action={updateReminderAction.bind(null, reminder.id)}
          initialValues={{ dueAtLocal: toLocalInputValue(reminder.dueAt), message: reminder.message }}
          submitLabel="Save reminder"
          onDone={() => setEditing(false)}
          focusOnMount
        />
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className={reminder.doneAt ? "text-muted-foreground line-through" : "font-medium"}>{reminder.message}</p>
        <span className="text-sm text-muted-foreground">
          {REMINDER_KIND_LABELS[reminder.kind]} · due <LocalDateTime value={reminder.dueAt} />
          {reminder.doneAt && " · done"}
        </span>
      </div>
      {showApplication && (
        <Link
          href={`/dashboard/applications/${reminder.applicationId}`}
          className="w-fit text-sm underline-offset-4 hover:underline"
        >
          {reminder.role} at {reminder.companyName}
        </Link>
      )}
      <ReminderActions reminder={reminder} onEdit={() => setEditing(true)} />
    </li>
  );
}
