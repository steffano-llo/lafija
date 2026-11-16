"use client";

import { startTransition, useState, type ReactNode, type RefObject } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DESTRUCTIVE_ACTION } from "./action-styles";

type ConfirmCopy = {
  /** Names what will be deleted, e.g. “Delete Ana?”. */
  title: ReactNode;
  /** The consequence of confirming. */
  description: ReactNode;
  /** Text of the red confirm button. */
  confirmLabel?: string;
  /** Runs inside a transition, so it can dispatch a `useActionState` action. */
  onConfirm: () => void;
};

function ConfirmContent({
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
  close,
  finalFocus,
}: ConfirmCopy & { close: () => void; finalFocus?: RefObject<HTMLElement | null> }) {
  return (
    // Focus starts on Cancel (the first button), stays inside until the dialog closes and then
    // returns to the trigger, or to `finalFocus` when the dialog was opened from a menu.
    <AlertDialogContent finalFocus={finalFocus}>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          onClick={() => {
            close();
            startTransition(onConfirm);
          }}
        >
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

/** A confirmation opened from elsewhere (e.g. a menu item); the caller owns the open state. */
export function ConfirmDialog({
  open,
  onOpenChange,
  finalFocus,
  ...copy
}: ConfirmCopy & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <ConfirmContent {...copy} close={() => onOpenChange(false)} finalFocus={finalFocus} />
    </AlertDialog>
  );
}

/** An outlined red button (Delete by default) that acts only after the user confirms it. */
export function ConfirmActionButton({
  label = "Delete",
  ariaLabel,
  disabled,
  ...copy
}: ConfirmCopy & { label?: string; ariaLabel: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={(next) => setOpen(next)}>
      <AlertDialogTrigger
        render={<Button type="button" {...DESTRUCTIVE_ACTION} disabled={disabled} aria-label={ariaLabel} />}
      >
        {label}
      </AlertDialogTrigger>
      <ConfirmContent confirmLabel={label} {...copy} close={() => setOpen(false)} />
    </AlertDialog>
  );
}
