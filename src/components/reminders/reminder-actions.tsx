"use client";

import { useActionState } from "react";
import {
  deleteReminderAction,
  setReminderDoneAction,
  snoozeReminderAction,
} from "@/app/dashboard/reminders/actions";
import type { DetailButtonState } from "@/components/applications/form-state";
import { Button } from "@/components/ui/button";
import { SNOOZE_DAYS } from "@/lib/validation/reminder";
import type { ReminderItem } from "./form-state";

const snoozeLabel = (days: number) => (days === 1 ? "1 day" : `${days} days`);

/**
 * Done / reopen, snooze (open reminders only) and, when `canDelete`, delete. Buttons name the
 * reminder for screen readers; any refusal is shown under them.
 */
export function ReminderActions({ reminder, canDelete = false }: { reminder: ReminderItem; canDelete?: boolean }) {
  const done = reminder.doneAt !== null;
  const run = (action: () => Promise<DetailButtonState>) => async () => action();
  const [doneState, doneAction, donePending] = useActionState(
    run(() => setReminderDoneAction(reminder.id, !done)),
    {},
  );
  const [snoozeState, snoozeAction, snoozePending] = useActionState(
    async (_state: DetailButtonState, formData: FormData) => snoozeReminderAction(reminder.id, formData.get("days")),
    {},
  );
  const [deleteState, deleteAction, deletePending] = useActionState(run(() => deleteReminderAction(reminder.id)), {});
  const message = doneState.message ?? snoozeState.message ?? deleteState.message;
  const name = `reminder “${reminder.message}”`;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <form action={doneAction}>
          <Button
            type="submit"
            size="sm"
            variant={done ? "outline" : "default"}
            disabled={donePending}
            aria-label={done ? `Reopen ${name}` : `Mark ${name} done`}
          >
            {done ? "Reopen" : "Done"}
          </Button>
        </form>
        {!done && (
          <form action={snoozeAction} className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Snooze</span>
            {SNOOZE_DAYS.map((days) => (
              <Button
                key={days}
                type="submit"
                name="days"
                value={String(days)}
                size="sm"
                variant="outline"
                disabled={snoozePending}
                aria-label={`Snooze ${name} for ${snoozeLabel(days)}`}
              >
                {snoozeLabel(days)}
              </Button>
            ))}
          </form>
        )}
        {canDelete && (
          <form
            action={deleteAction}
            onSubmit={(event) => {
              if (!window.confirm("Delete this reminder?")) event.preventDefault();
            }}
          >
            <Button type="submit" size="sm" variant="ghost" disabled={deletePending} aria-label={`Delete ${name}`}>
              Delete
            </Button>
          </form>
        )}
      </div>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}
