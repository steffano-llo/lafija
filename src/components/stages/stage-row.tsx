"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { STAGE_CATEGORIES, STAGE_CATEGORY_LABELS, STAGE_NAME_MAX, type StageCategory } from "@/lib/validation/stage";
import type { StageFormAction, StageRowAction } from "./form-state";

export type StageRowData = { id: string; name: string; category: StageCategory; archived: boolean };

export function StageRow({
  stage,
  isFirst,
  isLast,
  updateAction,
  rowAction,
}: {
  stage: StageRowData;
  isFirst: boolean;
  isLast: boolean;
  updateAction: StageFormAction;
  rowAction: StageRowAction;
}) {
  const [editState, editFormAction, editPending] = useActionState(updateAction, {
    values: { name: stage.name, category: stage.category },
  });
  const [rowState, rowFormAction, rowPending] = useActionState(rowAction, {});
  const nameId = `stage-${stage.id}-name`;
  const categoryId = `stage-${stage.id}-category`;
  const errors = [...(editState.fieldErrors?.name ?? []), ...(editState.fieldErrors?.category ?? [])];
  const message = errors[0] ?? editState.message ?? rowState.message;

  return (
    <li className="flex flex-col gap-2 border-t border-foreground/10 px-3 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <form action={editFormAction} className="flex flex-1 flex-wrap items-center gap-2" noValidate>
          <label htmlFor={nameId} className="sr-only">
            Name of {stage.name}
          </label>
          <Input
            id={nameId}
            name="name"
            required
            maxLength={STAGE_NAME_MAX}
            defaultValue={editState.values.name ?? stage.name}
            className="min-w-36 flex-1"
            aria-invalid={editState.fieldErrors?.name ? true : undefined}
          />
          <label htmlFor={categoryId} className="sr-only">
            Category of {stage.name}
          </label>
          <NativeSelect
            id={categoryId}
            name="category"
            defaultValue={editState.values.category ?? stage.category}
            className="w-32"
            aria-invalid={editState.fieldErrors?.category ? true : undefined}
          >
            {STAGE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {STAGE_CATEGORY_LABELS[category]}
              </option>
            ))}
          </NativeSelect>
          <Button type="submit" variant="outline" size="sm" disabled={editPending} aria-label={`Save ${stage.name}`}>
            {editPending ? "Saving…" : "Save"}
          </Button>
          {stage.archived && <span className="text-xs text-muted-foreground">Archived</span>}
          {editState.saved && !message && (
            <span role="status" className="text-xs text-muted-foreground">
              Saved.
            </span>
          )}
        </form>
        <form action={rowFormAction} className="flex flex-wrap gap-1">
          <Button
            type="submit"
            name="intent"
            value="up"
            variant="ghost"
            size="sm"
            disabled={rowPending || isFirst}
            aria-label={`Move ${stage.name} up`}
          >
            ↑
          </Button>
          <Button
            type="submit"
            name="intent"
            value="down"
            variant="ghost"
            size="sm"
            disabled={rowPending || isLast}
            aria-label={`Move ${stage.name} down`}
          >
            ↓
          </Button>
          <Button
            type="submit"
            name="intent"
            value={stage.archived ? "unarchive" : "archive"}
            variant="ghost"
            size="sm"
            disabled={rowPending}
            aria-label={`${stage.archived ? "Unarchive" : "Archive"} ${stage.name}`}
          >
            {stage.archived ? "Unarchive" : "Archive"}
          </Button>
          <Button
            type="submit"
            name="intent"
            value="delete"
            variant="ghost"
            size="sm"
            disabled={rowPending}
            aria-label={`Delete ${stage.name}`}
            onClick={(event) => {
              if (!window.confirm(`Delete the stage "${stage.name}"?`)) event.preventDefault();
            }}
          >
            Delete
          </Button>
        </form>
      </div>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </li>
  );
}
