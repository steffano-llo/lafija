"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { SettingsFormState } from "./form-state";

/**
 * The "Email me due reminders" switch: a native checkbox with `role="switch"` (sent as
 * `emailReminders=on` when checked, absent when not) plus Save, like the other settings forms.
 */
export function EmailRemindersForm({
  enabled,
  action,
}: {
  enabled: boolean;
  action: (state: SettingsFormState, formData: FormData) => Promise<SettingsFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, { value: enabled ? "on" : "off" });

  return (
    <form action={formAction} className="flex flex-col gap-2" noValidate>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="email-reminders"
          name="emailReminders"
          type="checkbox"
          role="switch"
          key={state.value}
          defaultChecked={state.value === "on"}
          className="size-4 accent-primary"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "email-reminders-error" : "email-reminders-help"}
        />
        <label htmlFor="email-reminders" className="text-sm">
          Email me due reminders
        </label>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {state.saved && !pending && (
          <span role="status" className="text-sm text-muted-foreground">
            Saved.
          </span>
        )}
      </div>
      <p id="email-reminders-help" className="text-sm text-muted-foreground">
        One email lists the reminders that became due since the last one (checked every 15 minutes). Reminders always
        show in laFija; email is sent only while delivery is set up for this app and your address is allowed.
      </p>
      {state.error && (
        <p id="email-reminders-error" role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
