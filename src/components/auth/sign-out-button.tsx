"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { signOutAndLeave } from "./auth-errors";

export function SignOutButton() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    setError(null);
    setPending(true);
    const failure = await signOutAndLeave(
      () => authClient.signOut(),
      () => {
        router.push("/sign-in");
        router.refresh();
      },
    );
    if (failure) {
      setError(failure);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button variant="outline" onClick={onClick} disabled={pending}>
        Sign out
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
