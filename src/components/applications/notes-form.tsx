"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { NOTES_MAX } from "@/lib/validation/application";
import type { DetailFormAction } from "./form-state";

/** Free notes of one application; saving a blank field clears them. */
export function NotesForm({ action, notes }: { action: DetailFormAction<"notes">; notes: string | null }) {
  const [state, formAction, pending] = useActionState(action, { values: { notes: notes ?? "" } });
  const errors = state.fieldErrors?.notes;

  return (
    <section aria-labelledby="notes-heading" className="flex flex-col gap-3">
      <h2 id="notes-heading" className="text-lg font-semibold">
        Notes
      </h2>
      <form action={formAction} className="flex flex-col gap-2" noValidate>
        <label htmlFor="application-notes" className="sr-only">
          Notes
        </label>
        <Textarea
          id="application-notes"
          name="notes"
          maxLength={NOTES_MAX}
          rows={5}
          placeholder="Anything worth remembering about this application."
          defaultValue={state.values.notes ?? ""}
          aria-invalid={errors ? true : undefined}
          aria-describedby={errors ? "application-notes-error" : undefined}
        />
        {errors && (
          <p id="application-notes-error" className="text-sm text-destructive">
            {errors[0]}
          </p>
        )}
        {state.message && !errors && (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save notes"}
          </Button>
          {state.saved && !pending && (
            <span role="status" className="text-sm text-muted-foreground">
              Saved.
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
