import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CreateStageForm } from "@/components/stages/create-stage-form";
import { StageRow } from "@/components/stages/stage-row";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { listStages } from "@/server/stages";
import { createStageAction, stageRowAction, updateStageAction } from "./actions";

export const metadata: Metadata = { title: "Stages · laFija" };

async function StagesList() {
  const user = await requireUser();
  const stages = await listStages(getDb(), user.id);

  return (
    <ol aria-label="Stages" className="rounded-lg ring-1 ring-foreground/10">
      {stages.map((stage, index) => (
        <StageRow
          key={stage.id}
          stage={{ id: stage.id, name: stage.name, category: stage.category, archived: stage.archived }}
          isFirst={index === 0}
          isLast={index === stages.length - 1}
          updateAction={updateStageAction.bind(null, stage.id)}
          rowAction={stageRowAction.bind(null, stage.id)}
        />
      ))}
    </ol>
  );
}

export default function StagesPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-12">
      <div className="flex flex-col gap-1">
        <Link href="/dashboard" className="text-sm text-muted-foreground hover:underline">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold">Stages</h1>
        <p className="text-sm text-muted-foreground">
          Stages are the columns your applications move through, in this order. The category says what a stage
          means for your statistics. A stage that applications use or have been in cannot be deleted, only archived, and you can
          archive it once its active applications have moved on.
        </p>
      </div>
      <section aria-labelledby="new-stage-heading" className="flex flex-col gap-3">
        <h2 id="new-stage-heading" className="text-lg font-medium">
          New stage
        </h2>
        <CreateStageForm action={createStageAction} />
      </section>
      {/* The session read is request data: the list streams in behind this boundary. */}
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <StagesList />
      </Suspense>
    </main>
  );
}
