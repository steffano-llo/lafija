"use client";

import { useActionState, useState } from "react";
import { createReminderAction, updateReminderAction } from "@/app/dashboard/reminders/actions";
import type { DetailFormAction, DetailFormState } from "@/components/applications/form-state";
import {
  LocalDateTime,
  fromLocalInputValue,
  toLocalInputValue,
} from "@/components/applications/local-date-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REMINDER_KIND_LABELS, REMINDER_MESSAGE_MAX } from "@/lib/validation/reminder";
import type { ReminderFormField, ReminderItem } from "./form-state";
import { ReminderActions } from "./reminder-actions";

/** The form also keeps what the user typed in the local date-time input. */
type Field = ReminderFormField | "dueAtLocal";
type State = DetailFormState<Field>;

function FieldError({ id, errors }: { id: string; errors?: string[] }) {
  return errors ? (
    <p id={id} className="text-sm text-destructive">
      {errors[0]}
    </p>
  ) : null;
}

function ReminderForm({
  idPrefix,
  action,
  initialValues,
  submitLabel,
  onDone,
}: {
  idPrefix: string;
  action: DetailFormAction<ReminderFormField>;
  initialValues: State["values"];
  submitLabel: string;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    async (previous: State, formData: FormData): Promise<State> => {
      // The input shows local time; the server stores the instant it means in this browser's zone.
      const local = String(formData.get("dueAtLocal") ?? "");
      formData.set("dueAt", fromLocalInputValue(local));
      const result = await action(previous, formData);
      if (result.saved) onDone();
      return { ...result, values: { ...result.values, dueAtLocal: local } };
    },
    { values: initialValues },
  );
  const id = (field: string) => `${idPrefix}-${field}`;
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate>
      <div className="flex flex-col gap-2 sm:max-w-64">
        <Label htmlFor={id("dueAt")}>Due</Label>
        <Input
          id={id("dueAt")}
          name="dueAtLocal"
          type="datetime-local"
          required
          defaultValue={state.values.dueAtLocal ?? ""}
          aria-invalid={errors.dueAt ? true : undefined}
          aria-describedby={errors.dueAt ? id("dueAt-error") : undefined}
        />
        <FieldError id={id("dueAt-error")} errors={errors.dueAt} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id("message")}>Message</Label>
        <Textarea
          id={id("message")}
          name="message"
          required
          maxLength={REMINDER_MESSAGE_MAX}
          rows={2}
          defaultValue={state.values.message ?? ""}
          aria-invalid={errors.message ? true : undefined}
          aria-describedby={errors.message ? id("message-error") : undefined}
        />
        <FieldError id={id("message-error")} errors={errors.message} />
      </div>
      {state.message && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ReminderRow({ reminder }: { reminder: ReminderItem }) {
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
      <div className="flex flex-wrap items-start gap-2">
        <ReminderActions reminder={reminder} canDelete />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setEditing(true)}
          aria-label={`Edit reminder “${reminder.message}”`}
        >
          Edit
        </Button>
      </div>
    </li>
  );
}

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
            <ReminderRow key={reminder.id} reminder={reminder} />
          ))}
        </ul>
      )}
    </section>
  );
}
