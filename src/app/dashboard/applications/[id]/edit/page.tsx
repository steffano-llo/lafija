import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DashboardHeader } from "@/components/reminders/dashboard-header";
import { ApplicationForm } from "@/components/applications/application-form";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { getApplication, listCompanies, listSourceSuggestions } from "@/server/applications";
import { getUserSettings } from "@/server/settings";
import { listStages } from "@/server/stages";
import { updateApplicationAction } from "../../actions";

export const metadata: Metadata = { title: "Edit application · laFija" };

type Params = PageProps<"/dashboard/applications/[id]/edit">["params"];

async function EditApplicationForm({ params }: { params: Params }) {
  const user = await requireUser();
  const { id } = await params;
  const db = getDb();
  const [application, companies, sources, stages, settings] = await Promise.all([
    getApplication(db, user.id, id),
    listCompanies(db, user.id),
    listSourceSuggestions(db, user.id),
    listStages(db, user.id),
    getUserSettings(db, user.id),
  ]);
  // Unknown and foreign ids look the same: not found.
  if (!application) notFound();
  // Active stages, plus the current one even if it was archived since, so saving keeps it.
  const stageOptions = stages
    .filter((stage) => !stage.archived || stage.id === application.stageId)
    .map(({ id, name, archived }) => ({ id, name, archived }));

  return (
    <ApplicationForm
      action={updateApplicationAction.bind(null, application.id)}
      initialValues={{
        companyName: application.companyName,
        role: application.role,
        stageId: application.stageId,
        url: application.url ?? "",
        source: application.source ?? "",
        salaryRange: application.salaryRange ?? "",
        salaryCurrency: application.salaryCurrency ?? settings.defaultCurrency,
        appliedAt: application.appliedAt ?? "",
      }}
      companies={companies.map((company) => company.name)}
      sources={sources}
      stages={stageOptions}
      timeZone={settings.timeZone}
      submitLabel="Save changes"
    />
  );
}

export default function EditApplicationPage({ params }: PageProps<"/dashboard/applications/[id]/edit">) {
  return (
    <>
      <DashboardHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-12">
        <div className="flex flex-col gap-1">
          <Link href="/dashboard/applications" className="text-sm text-muted-foreground hover:underline">
            ← Applications
          </Link>
          <h1 className="text-2xl font-semibold">Edit application</h1>
        </div>
        <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
          <EditApplicationForm params={params} />
        </Suspense>
      </main>
    </>
  );
}
