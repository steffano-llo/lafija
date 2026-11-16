import type { Metadata } from "next";
import { Suspense } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard · laFija" };

async function SignedInAs() {
  const user = await requireUser();
  return <p className="text-muted-foreground">Signed in as {user.email}.</p>;
}

export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your search</h1>
        <SignOutButton />
      </div>
      {/* The session read is request data: it streams in behind this boundary. */}
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <SignedInAs />
      </Suspense>
    </main>
  );
}
