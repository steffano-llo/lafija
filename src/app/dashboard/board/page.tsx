import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Board } from "@/components/board/board";
import { buttonVariants } from "@/components/ui/button";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { listBoard } from "@/server/board";
import { ensureDefaultStages } from "@/server/stages";

export const metadata: Metadata = { title: "Board · laFija" };

async function BoardLoader() {
  const user = await requireUser();
  const db = getDb();
  await ensureDefaultStages(db, user.id);
  const { columns } = await listBoard(db, user.id);
  return <Board columns={columns} />;
}

export default function BoardPage() {
  return (
    <main className="flex w-full flex-1 flex-col gap-6 px-6 py-12">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/dashboard" className="text-sm text-muted-foreground hover:underline">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-semibold">Board</h1>
        </div>
        <nav aria-label="Board actions" className="flex flex-wrap gap-2">
          <Link href="/dashboard/applications/new" className={buttonVariants()}>
            New application
          </Link>
          <Link href="/dashboard/applications" className={buttonVariants({ variant: "outline" })}>
            List view
          </Link>
          <Link href="/dashboard/stages" className={buttonVariants({ variant: "outline" })}>
            Manage stages
          </Link>
        </nav>
      </div>
      {/* The session read is request data: the board streams in behind this boundary. */}
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <BoardLoader />
      </Suspense>
    </main>
  );
}
