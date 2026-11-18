"use client";

import { useActionState } from "react";
import { SECONDARY_ACTION } from "@/components/actions/action-styles";
import { Button } from "@/components/ui/button";
import type { ArchiveState } from "./form-state";

/** Archive or unarchive one application; a refusal is shown next to the button. */
export function ArchiveButton({
  action,
  archived,
  label,
}: {
  action: (state: ArchiveState, formData: FormData) => Promise<ArchiveState>;
  archived: boolean;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const verb = archived ? "Unarchive" : "Archive";

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <Button type="submit" {...SECONDARY_ACTION} disabled={pending} aria-label={`${verb} ${label}`}>
        {verb}
      </Button>
      {state.message && (
        <p role="alert" className="max-w-64 text-right text-sm text-destructive">
          {state.message}
        </p>
      )}
    </form>
  );
}
