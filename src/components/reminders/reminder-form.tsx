"use client";

import { useActionState, useEffect, useRef } from "react";
import type { DetailFormAction, DetailFormState } from "@/components/applications/form-state";
import { fromLocalInputValue } from "@/components/applications/local-date-time";
import { SECONDARY_ACTION } from "@/components/actions/action-styles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REMINDER_MESSAGE_MAX } from "@/lib/validation/reminder";
import type { ReminderFormField } from "./form-state";

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

/** Add or edit one reminder. `focusOnMount` moves focus to its first field (edit from a menu). */
export function ReminderForm({
  idPrefix,
  action,
  initialValues,
  submitLabel,
  onDone,
  focusOnMount = false,
}: {
  idPrefix: string;
  action: DetailFormAction<ReminderFormField>;
  initialValues: State["values"];
  submitLabel: string;
  onDone: () => void;
  focusOnMount?: boolean;
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
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusOnMount) firstField.current?.focus();
  }, [focusOnMount]);

  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate>
      <div className="flex flex-col gap-2 sm:max-w-64">
        <Label htmlFor={id("dueAt")}>Due</Label>
        <Input
          ref={firstField}
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
        <Button type="button" {...SECONDARY_ACTION} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
