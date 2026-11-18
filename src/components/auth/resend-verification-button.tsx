"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Result = { ok: boolean; message: string };

/** Calls the resend Server Action and shows its English answer; a thrown call shows a generic error. */
export function ResendVerificationButton({ action }: { action: () => Promise<Result> }) {
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    setResult(null);
    try {
      setResult(await action());
    } catch {
      setResult({ ok: false, message: "The verification email could not be sent. Please try again later." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" onClick={onClick} disabled={pending}>
        {pending ? "Sending…" : "Resend verification email"}
      </Button>
      {result && (
        <p role={result.ok ? "status" : "alert"} className={result.ok ? "text-sm" : "text-sm text-destructive"}>
          {result.message}
        </p>
      )}
    </div>
  );
}
