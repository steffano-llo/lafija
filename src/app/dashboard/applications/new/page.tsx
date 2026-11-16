import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ApplicationForm } from "@/components/applications/application-form";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { listCompanies } from "@/server/applications";
import { createApplicationAction } from "../actions";

export const metadata: Metadata = { title: "New application · laFija" };

async function NewApplicationForm() {
  const user = await requireUser();
  const companies = await listCompanies(getDb(), user.id);
  return (
    <ApplicationForm
      action={createApplicationAction}
      companies={companies.map((company) => company.name)}
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
