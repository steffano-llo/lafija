"use client";

import { useActionState } from "react";
import { startDemoAction, type DemoActionState } from "@/app/(auth)/demo-actions";
import { Button } from "@/components/ui/button";
import { DEMO_LIFETIME_HOURS } from "@/lib/validation/demo";

/** "Try the demo": one click creates a temporary account with sample data and opens its board. */
export function TryDemoButton({ size = "default" }: { size?: "default" | "lg" }) {
  const [state, formAction, pending] = useActionState<DemoActionState, FormData>(startDemoAction, null);
  return (
    <form action={formAction} className="flex flex-col items-center gap-2">
      <Button type="submit" variant="secondary" size={size} disabled={pending}>
        {pending ? "Preparing your demo…" : "Try the demo"}
      </Button>
      <p className="max-w-xs text-center text-xs text-muted-foreground">
        No sign-up needed. The demo account and its sample data are deleted {DEMO_LIFETIME_HOURS} hours after it is
        created.
      </p>
      {state?.error && (
        <p role="alert" className="max-w-xs text-center text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
