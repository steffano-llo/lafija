import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DashboardHeader } from "@/components/reminders/dashboard-header";
import { ApplicationsTable } from "@/components/applications/applications-table";
import { buttonVariants } from "@/components/ui/button";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { listApplications } from "@/server/applications";

export const metadata: Metadata = { title: "Applications · laFija" };

async function ApplicationsList({ searchParams }: { searchParams: PageProps<"/dashboard/applications">["searchParams"] }) {
  const user = await requireUser();
  const { view } = await searchParams;
  const archived = view === "archived";
  const applications = await listApplications(getDb(), user.id, { archived });

  const tab = (active: boolean) =>
    buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" });

  return (
    <>
      <nav aria-label="Filter applications" className="flex gap-2">
        <Link href="/dashboard/applications" className={tab(!archived)} aria-current={archived ? undefined : "page"}>
          Active
        </Link>
        <Link
          href="/dashboard/applications?view=archived"
          className={tab(archived)}
          aria-current={archived ? "page" : undefined}
        >
          Archived
        </Link>
      </nav>
      <ApplicationsTable applications={applications} archived={archived} />
    </>
  );
}

export default function ApplicationsPage({ searchParams }: PageProps<"/dashboard/applications">) {
  return (
    <>
      <DashboardHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-12">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Link href="/dashboard" className="text-sm text-muted-foreground hover:underline">
              ← Dashboard
            </Link>
            <h1 className="text-2xl font-semibold">Applications</h1>
          </div>
          <Link href="/dashboard/applications/new" className={buttonVariants()}>
            New application
          </Link>
        </div>
        {/* The session and the filter are request data: they stream in behind this boundary. */}
        <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
          <ApplicationsList searchParams={searchParams} />
        </Suspense>
      </main>
    </>
  );
}
