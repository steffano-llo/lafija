"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { SettingsFormState } from "./form-state";

/** One labelled select with Save, a "Saved." status and the server's error. */
export function SettingsSelectForm({
  id,
  name,
  label,
  help,
  options,
  value,
  action,
}: {
  id: string;
  name: string;
  label: string;
  help: string;
  options: readonly { value: string; label: string }[];
  value: string;
  action: (state: SettingsFormState, formData: FormData) => Promise<SettingsFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, { value });
  const known = options.some((option) => option.value === state.value);

  return (
    <form action={formAction} className="flex flex-col gap-2" noValidate>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
        <NativeSelect
          id={id}
          name={name}
          key={state.value}
          defaultValue={state.value}
          className="w-72 max-w-full"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? `${id}-error` : `${id}-help`}
        >
          {!known && <option value={state.value}>{state.value || "Choose…"}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
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
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        {help}
      </p>
      {state.error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
