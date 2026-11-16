import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DashboardHeader } from "@/components/reminders/dashboard-header";
import { formatAppliedDate, formatSalary } from "@/components/applications/format";
import { NotesForm } from "@/components/applications/notes-form";
import { StageHistory } from "@/components/applications/stage-history";
import { ContactsSection } from "@/components/contacts/contacts-section";
import { InterviewsSection } from "@/components/interviews/interviews-section";
import { toReminderItem } from "@/components/reminders/form-state";
import { RemindersSection } from "@/components/reminders/reminders-section";
import { buttonVariants } from "@/components/ui/button";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { getApplication } from "@/server/applications";
import { listApplicationHistory } from "@/server/board";
import { listApplicationContacts, listLinkableContacts, type Contact } from "@/server/contacts";
import { listInterviews } from "@/server/interviews";
import { listApplicationReminders } from "@/server/reminders";
import { updateNotesAction } from "./actions";

export const metadata: Metadata = { title: "Application · laFija" };

type Params = PageProps<"/dashboard/applications/[id]">["params"];

const contactItem = ({ id, name, role, email, linkedin, notes }: Contact) => ({ id, name, role, email, linkedin, notes });

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

async function ApplicationDetail({ params }: { params: Params }) {
  const user = await requireUser();
  const { id } = await params;
  const db = getDb();
  const [application, history, interviews, contacts, linkable, reminders] = await Promise.all([
    getApplication(db, user.id, id),
    listApplicationHistory(db, user.id, id),
    listInterviews(db, user.id, id),
    listApplicationContacts(db, user.id, id),
    listLinkableContacts(db, user.id, id),
    listApplicationReminders(db, user.id, id),
  ]);
  // Unknown and foreign ids look the same: not found.
  if (!application || !history || !interviews || !contacts || !linkable || !reminders) notFound();

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">
            {application.role} <span className="text-muted-foreground">at</span> {application.companyName}
          </h1>
          {application.archived && <p className="text-sm text-muted-foreground">Archived</p>}
        </div>
        <Link
          href={`/dashboard/applications/${application.id}/edit`}
          className={buttonVariants({ variant: "outline" })}
          aria-label={`Edit ${application.role} at ${application.companyName}`}
        >
          Edit
        </Link>
      </div>

      <dl className="grid gap-4 rounded-lg p-4 text-sm ring-1 ring-foreground/10 sm:grid-cols-3">
        <Detail term="Current stage">
          {application.stageName}
          {application.stageArchived && <span className="text-muted-foreground"> (archived)</span>}
        </Detail>
        <Detail term="Applied">{formatAppliedDate(application.appliedAt)}</Detail>
        <Detail term="Source">{application.source ?? "—"}</Detail>
        <Detail term="Salary range">{formatSalary(application.salaryRange, application.salaryCurrency)}</Detail>
        <Detail term="Job posting">
          {application.url ? (
            <a href={application.url} target="_blank" rel="noopener noreferrer" className="break-all underline-offset-4 hover:underline">
              {application.url}
            </a>
          ) : (
            "—"
          )}
        </Detail>
      </dl>

      <NotesForm action={updateNotesAction.bind(null, application.id)} notes={application.notes} />

      <RemindersSection applicationId={application.id} reminders={reminders.map(toReminderItem)} />

      <InterviewsSection
        applicationId={application.id}
        interviews={interviews.map(({ id: interviewId, scheduledAt, type, outcome, notes, needsOutcome }) => ({
          id: interviewId,
          scheduledAt: scheduledAt.toISOString(),
          type,
          outcome,
          notes,
          needsOutcome,
        }))}
      />

      <ContactsSection
        applicationId={application.id}
        companyName={application.companyName}
        contacts={contacts.map(contactItem)}
        linkable={linkable.map(contactItem)}
      />

      <StageHistory entries={history} />
    </>
  );
}

export default function ApplicationPage({ params }: PageProps<"/dashboard/applications/[id]">) {
  return (
    <>
      <DashboardHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-12">
        <nav aria-label="Back" className="flex gap-4 text-sm text-muted-foreground">
          <Link href="/dashboard/board" className="hover:underline">
            ← Board
          </Link>
          <Link href="/dashboard/applications" className="hover:underline">
            ← Applications
          </Link>
        </nav>
        {/* The session read is request data: the detail streams in behind this boundary. */}
        <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
          <ApplicationDetail params={params} />
        </Suspense>
      </main>
    </>
  );
}
