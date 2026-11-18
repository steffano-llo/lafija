"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { startTransition, useActionState, useRef, useState } from "react";
import {
  deleteReminderAction,
  setReminderDoneAction,
  snoozeReminderAction,
} from "@/app/dashboard/reminders/actions";
import type { DetailButtonState } from "@/components/applications/form-state";
import {
  SECONDARY_ACTION,
  canSnooze,
  reminderMenuLabel,
  reminderName,
  snoozeLabel,
} from "@/components/actions/action-styles";
import { ConfirmDialog } from "@/components/actions/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SNOOZE_DAYS } from "@/lib/validation/reminder";
import type { ReminderItem } from "./form-state";

/**
 * Done (the main action) or Reopen once done; a Snooze menu (1, 3 or 7 days) for open reminders
 * only, because the server refuses to snooze a done one; and a ⋯ menu with Edit and Delete, which
 * asks for confirmation. Menus work with the keyboard and give focus back to their button. Any
 * refusal is shown under the buttons.
 */
export function ReminderActions({ reminder, onEdit }: { reminder: ReminderItem; onEdit: () => void }) {
  const done = reminder.doneAt !== null;
  const [doneState, doneAction, donePending] = useActionState(
    async (): Promise<DetailButtonState> => setReminderDoneAction(reminder.id, !done),
    {},
  );
  const [snoozeState, snoozeAction, snoozePending] = useActionState(
    async (_state: DetailButtonState, days: string): Promise<DetailButtonState> =>
      snoozeReminderAction(reminder.id, days),
    {},
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    async (): Promise<DetailButtonState> => deleteReminderAction(reminder.id),
    {},
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const message = doneState.message ?? snoozeState.message ?? deleteState.message;
  const name = reminderName(reminder.message);

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
        {canSnooze(reminder) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button type="button" {...SECONDARY_ACTION} disabled={snoozePending} aria-label={`Snooze ${name}`} />}
            >
              Snooze
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {SNOOZE_DAYS.map((days) => (
                <DropdownMenuItem
                  key={days}
                  onClick={() => startTransition(() => snoozeAction(String(days)))}
                >
                  {snoozeLabel(days)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                ref={moreButton}
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={deletePending}
                aria-label={reminderMenuLabel(reminder.message)}
              />
            }
          >
            <MoreHorizontalIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        finalFocus={moreButton}
        title={`Delete the ${name}?`}
        description="It will no longer appear or be emailed. This cannot be undone."
        onConfirm={() => deleteAction()}
      />
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}
