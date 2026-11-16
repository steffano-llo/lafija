import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ApplicationForm } from "@/components/applications/application-form";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { listCompanies } from "@/server/applications";
import { listStages } from "@/server/stages";
import { createApplicationAction } from "../actions";

export const metadata: Metadata = { title: "New application · laFija" };

async function NewApplicationForm() {
  const user = await requireUser();
  const db = getDb();
  const [companies, stages] = await Promise.all([listCompanies(db, user.id), listStages(db, user.id)]);
  const activeStages = stages.filter((stage) => !stage.archived);
  return (
    <ApplicationForm
      action={createApplicationAction}
      // New applications start in the first active stage unless the user picks another.
      initialValues={{ stageId: activeStages[0]?.id }}
      companies={companies.map((company) => company.name)}
      stages={activeStages.map(({ id, name }) => ({ id, name }))}
      submitLabel="Save application"
    />
  );
}

export default function NewApplicationPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-12">
      <div className="flex flex-col gap-1">
        <Link href="/dashboard/applications" className="text-sm text-muted-foreground hover:underline">
          ← Applications
        </Link>
        <h1 className="text-2xl font-semibold">New application</h1>
      </div>
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <NewApplicationForm />
      </Suspense>
    </main>
  );
}
