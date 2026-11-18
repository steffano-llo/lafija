"use client";

import { useState } from "react";
import { createReminderAction } from "@/app/dashboard/reminders/actions";
import { Button } from "@/components/ui/button";
import type { ReminderItem } from "./form-state";
import { ReminderCard } from "./reminder-card";
import { ReminderForm } from "./reminder-form";

/** Reminders of one application (open first, by due time) with add, edit, done, snooze and delete. */
export function RemindersSection({ applicationId, reminders }: { applicationId: string; reminders: ReminderItem[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <section aria-labelledby="reminders-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="reminders-heading" className="text-lg font-semibold">
          Reminders
        </h2>
        {!adding && (
          <Button type="button" size="sm" onClick={() => setAdding(true)}>
            Add reminder
          </Button>
        )}
      </div>
      {adding && (
        <div className="rounded-lg p-3 ring-1 ring-foreground/10">
          <ReminderForm
            idPrefix="new-reminder"
            action={createReminderAction.bind(null, applicationId)}
            initialValues={{}}
            submitLabel="Add reminder"
            onDone={() => setAdding(false)}
          />
        </div>
      )}
      {reminders.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reminders yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {reminders.map((reminder) => (
            <ReminderCard key={reminder.id} reminder={reminder} />
          ))}
        </ul>
      )}
    </section>
  );
}
