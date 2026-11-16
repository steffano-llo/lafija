"use client";

import { useActionState } from "react";
import { setFollowUpDaysAction } from "@/app/dashboard/reminders/actions";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { FOLLOW_UP_DAYS_MAX, FOLLOW_UP_DAYS_MIN } from "@/lib/validation/reminder";

const DAY_OPTIONS = Array.from({ length: FOLLOW_UP_DAYS_MAX - FOLLOW_UP_DAYS_MIN + 1 }, (_, i) => FOLLOW_UP_DAYS_MIN + i);

/** "Follow up automatically after N days", or off. */
export function FollowUpSettingsForm({ followUpDays }: { followUpDays: number | null }) {
  const [state, formAction, pending] = useActionState(setFollowUpDaysAction, {
    value: followUpDays === null ? "off" : String(followUpDays),
  });

  return (
    <form action={formAction} className="flex flex-col gap-2" noValidate>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="follow-up-days" className="text-sm">
          Follow up automatically after
        </label>
        <NativeSelect
          id="follow-up-days"
          name="followUpDays"
          key={state.value}
          defaultValue={state.value}
          className="w-32"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "follow-up-days-error" : "follow-up-days-help"}
        >
          <option value="off">Off</option>
          {DAY_OPTIONS.map((days) => (
            <option key={days} value={String(days)}>
              {days === 1 ? "1 day" : `${days} days`}
            </option>
          ))}
        </NativeSelect>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {state.saved && !pending && (
          <span role="status" className="text-sm text-muted-foreground">
            Saved.
          </span>
        )}
      </div>
      <p id="follow-up-days-help" className="text-sm text-muted-foreground">
        When an application moves into an active stage, a follow-up reminder is created for that many days later.
        Any later move closes it. Changing this does not change existing reminders.
      </p>
      {state.error && (
        <p id="follow-up-days-error" role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
