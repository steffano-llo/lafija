"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { STAGE_CATEGORIES, STAGE_CATEGORY_OPTION_LABELS, STAGE_NAME_MAX } from "@/lib/validation/stage";
import type { StageFormAction } from "./form-state";

export function CreateStageForm({ action }: { action: StageFormAction }) {
  const [state, formAction, pending] = useActionState(action, { values: { category: "active" } });
  const nameErrors = state.fieldErrors?.name;
  const categoryErrors = state.fieldErrors?.category;

  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate aria-label="New stage">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-2">
          <Label htmlFor="new-stage-name">Name</Label>
          <Input
            id="new-stage-name"
            name="name"
            required
            maxLength={STAGE_NAME_MAX}
            defaultValue={state.values.name ?? ""}
            aria-invalid={nameErrors ? true : undefined}
            aria-describedby={nameErrors ? "new-stage-name-error" : undefined}
          />
        </div>
        <div className="flex w-56 flex-col gap-2">
          <Label htmlFor="new-stage-category">Category</Label>
          <NativeSelect
            id="new-stage-category"
            name="category"
            defaultValue={state.values.category ?? "active"}
            aria-invalid={categoryErrors ? true : undefined}
            aria-describedby={categoryErrors ? "new-stage-category-error" : undefined}
          >
            {STAGE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {STAGE_CATEGORY_OPTION_LABELS[category]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add stage"}
        </Button>
      </div>
      {nameErrors && (
        <p id="new-stage-name-error" className="text-sm text-destructive">
          {nameErrors[0]}
        </p>
      )}
      {categoryErrors && (
        <p id="new-stage-category-error" className="text-sm text-destructive">
          {categoryErrors[0]}
        </p>
      )}
    </form>
  );
}
